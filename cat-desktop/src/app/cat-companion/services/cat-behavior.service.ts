import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CAT_BASE_WALK_SPEED, CatScreenInfo, CatSettings, CatWalkEndReason, CatWalkEnded, CatWalkRequest, CatWalkResult } from '../../core/models';
import { CatSettingsService } from '../../core/services/cat-settings.service';
import { CatWindowService } from '../../core/services/cat-window.service';
import { CatAnimation } from '../components/cat-sprite/cat-art';
import { CatAnimationService } from './cat-animation.service';
import {
  CAT_BEHAVIOR_CONFIG as CFG,
  CHOICE_GATES,
  CatBehaviorChoice,
  CatBehaviorState,
  CatClickReaction,
  pickWeighted,
  randomIn,
} from './cat-behavior.config';
import { CatSoundService } from './cat-sound.service';

export type { CatBehaviorState } from './cat-behavior.config';

/** Why the autonomous loop is on hold. It only runs while there is none. */
type HoldReason = 'hidden' | 'document' | 'layout' | 'drag' | 'reaction';

interface ActiveWalk {
  generation: number;
  kind: 'walk' | 'run';
  /** Null until the host answered cat.walk. */
  result: CatWalkResult | null;
  /** cat.walkEnded that arrived before the cat.walk response. */
  endedEarly: CatWalkEndReason | null;
}

const STATE_LABELS: Readonly<Record<CatBehaviorState, string>> = {
  idle: 'Idle',
  walking: 'Walking',
  running: 'Running',
  sitting: 'Sitting',
  sleeping: 'Napping',
  stretching: 'Stretching',
  yawning: 'Yawning',
  jumping: 'Jumping',
  looking: 'Looking around',
  dragged: 'Being carried',
  interacting: 'Listening',
};

/**
 * The cat's mind: a randomised state machine (idle, walking, running, sitting, sleeping, stretching, jumping,
 * looking, dragged, interacting). Every state has a random duration (or lasts as long as its one-shot clip) and
 * ends in a weighted random choice of the next state (CAT_BEHAVIOR_CONFIG.transitions), filtered by the settings
 * (autoWalk, randomIdle, randomActions). There is no fixed sequence.
 *
 * Walking is done by the host (cat.walk); this service only plans a walk from cat.getScreenInfo's room and waits
 * for cat.walkEnded. The loop is held while the cat is hidden, the page is hidden, a menu/panel is open, the cat
 * is being dragged or is reacting to a click. Only coarse setTimeout timers are used.
 */
@Injectable()
export class CatBehaviorService {
  private readonly catWindow = inject(CatWindowService);
  private readonly catSettings = inject(CatSettingsService);
  private readonly anim = inject(CatAnimationService);
  private readonly sound = inject(CatSoundService);

  readonly state = signal<CatBehaviorState>('idle');
  readonly stateLabel = computed(() => STATE_LABELS[this.state()]);
  /** True while something holds the autonomous loop. */
  readonly suspended = signal(false);

  private readonly holds = new Set<HoldReason>();
  /** Bumped whenever the current activity is abandoned; stale timers and awaits compare against it. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private walk: ActiveWalk | null = null;
  private started = false;
  private awakeSince = performance.now();
  private lastReaction: CatClickReaction | null = null;
  /** Set when a hold ends with the cat already resting (after a drag): carry on without another idle pause. */
  private continueAfterHold = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.catWindow.walkEnded$.pipe(takeUntilDestroyed(destroyRef)).subscribe((ended) => this.onWalkEnded(ended));
    // The host already moved the cat back on screen; a walk planned for the old room is stopped and re-planned.
    this.catWindow.screenChanged$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.stopWalking());

    effect(() => {
      const visible = this.catWindow.visible();
      untracked(() => this.setHold('hidden', !visible));
    });
    effect(() => {
      const hidden = this.anim.documentHidden();
      untracked(() => this.setHold('document', hidden));
    });
    effect(() => {
      const settings = this.catSettings.settings();
      untracked(() => this.applySettings(settings));
    });

    destroyRef.onDestroy(() => {
      this.started = false;
      this.cancel();
    });
  }

  /** Start the loop (after the cat UI rendered). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.resume();
  }

  // ---- entry points for interaction -------------------------------------------------------

  /** The context menu or the companion panel opened: the cat sits and listens (the host stops a walk itself). */
  menuOpened(): void {
    this.holds.delete('reaction'); // a click reaction in progress is abandoned
    this.setHold('layout', true);
    this.begin('interacting');
    this.anim.loop('sit');
  }

  menuClosed(): void {
    this.setHold('layout', false);
  }

  /** A drag started (the host stops a walk itself, reason 'dragged'). */
  dragStarted(): void {
    this.holds.delete('reaction');
    this.setHold('drag', true);
    const generation = this.begin('dragged');
    // Grab → a brief startle → dangling.
    void this.anim.play('surprised');
    this.after(CFG.grabSurpriseMs, generation, () => this.anim.loop('dragged'));
  }

  /** cat.dragEnded: land, sit (or stand), and normal behaviour again after 2–4 s. */
  async dragFinished(moved: boolean): Promise<void> {
    if (!this.holds.has('drag')) return;
    const generation = this.begin('interacting');
    if (moved) {
      await this.anim.play('land');
      if (generation !== this.generation) return;
    }
    const sit = Math.random() < CFG.afterDragSitChance;
    this.state.set(sit ? 'sitting' : 'idle');
    this.anim.loop(sit ? 'sit' : 'idle');
    this.after(randomIn(CFG.afterDragMs), generation, () => {
      this.continueAfterHold = true;
      this.setHold('drag', false);
      this.continueAfterHold = false;
    });
  }

  /** cat.dragStart was refused: back to normal. */
  dragAborted(): void {
    if (!this.holds.has('drag')) return;
    this.begin('idle');
    this.anim.loop('idle');
    this.setHold('drag', false);
  }

  /**
   * A single click on the cat (point in CSS px relative to the cat box): look at the cursor, a small jump, a happy
   * wiggle, a paw "interact" or a meow (sound on) – never the same one twice in a row. A sleeping cat wakes up
   * startled instead.
   */
  async reactToClick(point: { x: number; y: number }): Promise<void> {
    if (!this.started || this.holds.size > 0) return;
    const wasSleeping = this.state() === 'sleeping';
    this.setHold('reaction', true);
    const generation = this.begin('interacting');

    if (wasSleeping) {
      this.awakeSince = performance.now();
      await this.anim.play('surprised');
      this.endReaction(generation);
      return;
    }

    const weights: Partial<Record<CatClickReaction, number>> = { ...CFG.clickReactions };
    if (!this.catSettings.settings().sound) delete weights.meow;
    if (this.lastReaction) delete weights[this.lastReaction];
    const choice = pickWeighted(weights) ?? 'gaze';
    this.lastReaction = choice;
    switch (choice) {
      case 'gaze':
        // Look at the cursor, ears up (the artwork blinks on its own).
        this.anim.loop('idle');
        this.anim.face(point.x < this.catSettings.boxSize().width / 2 ? 'left' : 'right');
        this.anim.lookAt(point, CFG.gazeHoldMs);
        this.anim.reactionAttentive.set(true);
        this.after(CFG.gazeHoldMs, generation, () => {
          this.anim.reactionAttentive.set(false);
          this.endReaction(generation);
        });
        return;
      case 'meow':
        this.sound.meow('click');
        this.anim.lookAt(point, CFG.gazeHoldMs);
        await this.anim.play('happy');
        break;
      default:
        await this.anim.play(choice);
    }
    this.endReaction(generation);
  }

  /** The `meow` cat.command: a meow (sound on) and, when free to move, a happy wiggle. */
  async meowCommand(): Promise<void> {
    this.sound.meow('command');
    if (!this.started || this.holds.size > 0) return;
    this.setHold('reaction', true);
    const generation = this.begin('interacting');
    await this.anim.play('happy');
    this.endReaction(generation);
  }

  // ---- holds ------------------------------------------------------------------------------

  private setHold(reason: HoldReason, on: boolean): void {
    if (on === this.holds.has(reason)) return;
    if (on) {
      const wasFree = this.holds.size === 0;
      this.holds.add(reason);
      this.suspended.set(true);
      if (wasFree) this.interrupt(reason);
      return;
    }
    this.holds.delete(reason);
    if (this.holds.size === 0) {
      this.suspended.set(false);
      this.resume();
    }
  }

  /** Abandon the current activity. The host stops a walk itself on hide, drag and layout changes. */
  private interrupt(reason: HoldReason): void {
    const walking = this.walk !== null;
    this.cancel();
    if (walking) {
      if (reason === 'document' || reason === 'reaction') this.catWindow.stop().catch(() => undefined);
      this.state.set('idle');
      this.anim.loop('idle');
    }
  }

  private endReaction(generation: number): void {
    if (generation !== this.generation) return;
    this.setHold('reaction', false);
  }

  /** Continue after a hold: straight on after the post-drag sit, otherwise after a short idle. */
  private resume(): void {
    if (!this.started || this.holds.size > 0) return;
    if (this.continueAfterHold) {
      this.continueAfterHold = false;
      this.decide(); // the post-drag sit/stand already was the pause
      return;
    }
    this.enterIdle(randomIn(CFG.resumeMs));
  }

  private applySettings(settings: CatSettings): void {
    if (!this.started || this.holds.size > 0) return;
    const state = this.state();
    if (!settings.autoWalk && this.walk) this.stopWalking();
    else if (!settings.randomActions && state === 'running') this.stopWalking();
    else if (!settings.randomIdle && (state === 'sitting' || state === 'sleeping')) this.enterIdle(randomIn(CFG.idleMs));
  }

  // ---- the loop ---------------------------------------------------------------------------

  /** Weighted random next step from the current state, filtered by the settings gates. */
  private decide(): void {
    if (!this.started || this.holds.size > 0) return;
    const settings = this.catSettings.settings();
    const weights: Partial<Record<CatBehaviorChoice, number>> = {};
    const table: Partial<Record<CatBehaviorChoice, number>> = CFG.transitions[this.state()];
    for (const [choice, weight] of Object.entries(table) as [CatBehaviorChoice, number][]) {
      const gate = CHOICE_GATES[choice];
      if (gate && !settings[gate]) continue;
      if (choice === 'run' && !settings.randomActions) continue;
      if (choice === 'sleep' && performance.now() - this.awakeSince < CFG.minAwakeBeforeSleepMs) continue;
      weights[choice] = weight;
    }
    const choice = pickWeighted(weights) ?? 'idle';
    switch (choice) {
      case 'walk':
      case 'run':
        void this.enterWalk(choice);
        break;
      case 'sit':
        this.enterSit();
        break;
      case 'sleep':
        void this.enterSleep();
        break;
      case 'look':
        void this.enterOneShot('looking', 'look');
        break;
      case 'yawn':
        void this.enterOneShot('yawning', 'yawn');
        break;
      case 'stretch':
        void this.enterOneShot('stretching', 'stretch');
        break;
      case 'jump':
        void this.enterOneShot('jumping', 'jump');
        break;
      case 'happy':
        void this.enterOneShot('idle', 'happy');
        break;
      default:
        this.enterIdle(randomIn(CFG.idleMs));
    }
  }

  private enterIdle(ms: number): void {
    const generation = this.begin('idle');
    this.anim.loop('idle');
    this.after(ms, generation, () => this.decide());
  }

  private enterSit(): void {
    const generation = this.begin('sitting');
    this.anim.loop('sit');
    const long = Math.random() < CFG.longSitChance;
    if (long && Math.random() < CFG.longSitPurrChance) this.sound.purr('spontaneous');
    this.after(randomIn(long ? CFG.longSitMs : CFG.sitMs), generation, () => this.decide());
  }

  /** Often a yawn first; then a 20–90 s nap; waking up is yawn → stretch (stretch only with randomActions). */
  private async enterSleep(): Promise<void> {
    if (this.state() !== 'yawning' && Math.random() < CFG.preSleepYawnChance) {
      const yawned = this.begin('yawning');
      await this.anim.play('yawn');
      if (yawned !== this.generation) return;
    }
    const generation = this.begin('sleeping');
    this.anim.loop('sleep');
    this.after(randomIn(CFG.sleepMs), generation, () => void this.wakeUp(generation));
  }

  private async wakeUp(generation: number): Promise<void> {
    this.awakeSince = performance.now();
    if (Math.random() < CFG.wakeMeowChance) this.sound.meow('spontaneous');
    this.state.set('yawning');
    await this.anim.play('yawn');
    if (generation !== this.generation) return;
    if (this.catSettings.settings().randomActions) {
      this.state.set('stretching');
      await this.anim.play('stretch');
      if (generation !== this.generation) return;
    }
    this.decide(); // from 'yawning' or 'stretching'
  }

  /** States that last exactly one clip: looking, stretching, jumping, and the idle happy wiggle. */
  private async enterOneShot(state: CatBehaviorState, clip: CatAnimation): Promise<void> {
    const generation = this.begin(state);
    await this.anim.play(clip);
    if (generation === this.generation) this.decide();
  }

  // ---- walking ----------------------------------------------------------------------------

  private async enterWalk(kind: 'walk' | 'run'): Promise<void> {
    const generation = this.begin(kind === 'run' ? 'running' : 'walking');
    const plan = await this.planWalk(kind);
    if (generation !== this.generation) return;
    if (!plan) {
      this.enterIdle(randomIn(CFG.idleMs)); // no room either way
      return;
    }
    this.anim.face(plan.dx < 0 ? 'left' : 'right');
    const walk: ActiveWalk = { generation, kind, result: null, endedEarly: null };
    this.walk = walk;
    let result: CatWalkResult;
    try {
      result = await this.catWindow.walk(plan);
    } catch (err) {
      // 'denied' while a drag or a layout change is on its way; that hold takes over.
      if (this.walk === walk) {
        this.walk = null;
        this.enterIdle(randomIn(CFG.idleMs));
      }
      console.debug('[cat] walk refused', err);
      return;
    }
    if (this.walk !== walk) return;
    walk.result = result;
    if (walk.endedEarly) {
      this.finishWalk(walk, walk.endedEarly);
      return;
    }
    if (result.durationMs <= 0 || Math.hypot(result.dx, result.dy) < 1) {
      this.finishWalk(walk, 'blocked');
      return;
    }
    this.anim.walk(kind, result);
    // Safety net only: the host ends every walk with cat.walkEnded.
    this.after(result.durationMs + CFG.walkEndGraceMs, generation, () => this.finishWalk(walk, 'arrived'));
  }

  private onWalkEnded(ended: CatWalkEnded): void {
    const walk = this.walk;
    if (!walk || ended.reason === 'replaced') return; // 'replaced' belongs to an older walk
    if (!walk.result) {
      walk.endedEarly = ended.reason;
      return;
    }
    this.finishWalk(walk, ended.reason);
  }

  private finishWalk(walk: ActiveWalk, reason: CatWalkEndReason): void {
    if (this.walk !== walk || walk.generation !== this.generation) return;
    this.walk = null;
    switch (reason) {
      case 'blocked':
        // Nose against the edge of the screen: turn around and think about it.
        this.anim.face(this.anim.facing() === 'left' ? 'right' : 'left');
        this.enterIdle(randomIn([600, 1_500]));
        return;
      case 'dragged':
      case 'layout':
      case 'hidden':
        this.enterIdle(randomIn(CFG.idleMs)); // the matching hold follows and takes over
        return;
      default:
        this.decide(); // arrived / stopped: from 'walking' or 'running'
    }
  }

  private stopWalking(): void {
    if (this.walk) this.catWindow.stop().catch(() => undefined);
  }

  /**
   * Direction and distance from the room on screen: mostly keep going the way the cat faces, turn around near
   * an edge, sometimes a slight diagonal (|dy| ≤ 0.3 |dx|). Distance = speed × a random duration.
   */
  private async planWalk(kind: 'walk' | 'run'): Promise<CatWalkRequest | null> {
    const settings = this.catSettings.settings();
    const box = this.catSettings.boxSize();
    let info: CatScreenInfo | null;
    try {
      info = await this.catWindow.getScreenInfo();
    } catch {
      info = this.catWindow.screen();
    }
    const factor = randomIn(CFG.speedJitter) * (kind === 'run' ? CFG.runSpeedFactor : 1);
    // Small cats take small steps: speed grows with √scale, so the gait (stride rate) stays natural at 10 %–200 %.
    const sizeFactor = Math.sqrt(settings.scale);
    const speed = Math.min(600, Math.max(10, CAT_BASE_WALK_SPEED * settings.walkingSpeed * sizeFactor * factor));
    const wanted = (speed * randomIn(kind === 'run' ? CFG.runMs : CFG.walkMs)) / 1000;
    const room = info?.room ?? { left: wanted, right: wanted, up: 0, down: 0 };
    const ahead = (dir: 1 | -1): number => Math.max(0, (dir > 0 ? room.right : room.left) - CFG.edgeMargin);

    let dir: 1 | -1 = this.anim.facing() === 'right' ? 1 : -1;
    if (Math.random() > CFG.keepDirectionChance) dir = Math.random() < 0.5 ? 1 : -1;
    if (ahead(dir) < box.width * CFG.edgeTurnBoxWidths && ahead(-dir as 1 | -1) > ahead(dir)) dir = -dir as 1 | -1;
    let distance = Math.min(wanted, ahead(dir));
    if (distance < CFG.minWalkDistance) {
      dir = -dir as 1 | -1;
      distance = Math.min(wanted, ahead(dir));
    }
    if (distance < CFG.minWalkDistance) return null;

    const dx = dir * distance;
    let dy = 0;
    if (Math.random() < CFG.diagonalChance) {
      const up = Math.random() < 0.5;
      const limit = Math.max(0, (up ? room.up : room.down) - CFG.edgeMargin);
      const size = Math.min(limit, Math.abs(dx) * CFG.maxDiagonal * randomIn([0.3, 1]));
      if (size >= 6) dy = up ? -size : size;
    }
    return { dx: Math.round(dx), dy: Math.round(dy), speed: Math.round(speed) };
  }

  // ---- plumbing ---------------------------------------------------------------------------

  /** Leave whatever the cat was doing and enter `state`; returns the new generation. */
  private begin(state: CatBehaviorState): number {
    this.cancel();
    this.state.set(state);
    return this.generation;
  }

  private cancel(): void {
    this.generation++;
    this.anim.reactionAttentive.set(false);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.walk = null;
  }

  /** The single behaviour timer: run `fn` after `ms` unless the activity changed meanwhile. */
  private after(ms: number, generation: number, fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation === this.generation) fn();
    }, Math.max(0, ms));
  }
}
