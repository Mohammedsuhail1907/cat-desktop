import { DestroyRef, Injectable, inject } from '@angular/core';
import { CatSettingsService } from '../../core/services/cat-settings.service';

export type CatSoundReason = 'click' | 'command' | 'spontaneous';

/** Peak gain of every sound: quiet, the Windows mixer (per-app volume) scales it further. */
const GAIN = 0.15;
/** Spontaneous sounds: at most one per this range (randomised per sound), never in the first minutes. */
const SPONTANEOUS_GAP_MS: readonly [number, number] = [180_000, 360_000];
/** Click meows are allowed, but not spammy. */
const CLICK_GAP_MS = 4_000;
const COMMAND_GAP_MS = 1_000;

/**
 * Optional cat sounds (CatSettings.sound, default off), synthesised with WebAudio – no audio files.
 * The AudioContext is created lazily on the first user gesture (autoplay policy), so spontaneous sounds only
 * start after the user touched the cat once. Output goes through WebView2's audio session, so the volume
 * follows the Windows mixer automatically.
 */
@Injectable()
export class CatSoundService {
  private readonly catSettings = inject(CatSettingsService);
  private ctx: AudioContext | null = null;
  private lastSoundAt = 0;
  private lastClickAt = -CLICK_GAP_MS;
  private nextSpontaneousAt = performance.now() + randomIn(SPONTANEOUS_GAP_MS);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      void this.ctx?.close().catch(() => undefined);
      this.ctx = null;
    });
  }

  private get enabled(): boolean {
    return this.catSettings.settings().sound;
  }

  /** Call from a user gesture (pointerdown/keydown): creates or resumes the AudioContext when sound is on. */
  unlock(): void {
    if (!this.enabled || typeof AudioContext === 'undefined') return;
    try {
      this.ctx ??= new AudioContext({ latencyHint: 'playback' });
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
    }
  }

  meow(reason: CatSoundReason): boolean {
    const ctx = this.gate(reason);
    if (!ctx) return false;
    const t0 = ctx.currentTime + 0.02;
    const pitch = 0.9 + Math.random() * 0.25;
    const length = 0.45 + Math.random() * 0.25;

    const voice = ctx.createOscillator();
    voice.type = 'sawtooth';
    voice.frequency.setValueAtTime(470 * pitch, t0);
    voice.frequency.exponentialRampToValueAtTime(760 * pitch, t0 + length * 0.25);
    voice.frequency.exponentialRampToValueAtTime(690 * pitch, t0 + length * 0.55);
    voice.frequency.exponentialRampToValueAtTime(420 * pitch, t0 + length);

    const vibrato = ctx.createOscillator();
    const vibratoDepth = ctx.createGain();
    vibrato.frequency.value = 6;
    vibratoDepth.gain.value = 10 * pitch;
    vibrato.connect(vibratoDepth).connect(voice.frequency);

    // "mee-ow": the mouth formant slides down while the pitch arcs.
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.Q.value = 3.5;
    formant.frequency.setValueAtTime(1900, t0);
    formant.frequency.exponentialRampToValueAtTime(950, t0 + length);
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 3200;

    const amp = this.envelope(ctx, t0, 0.05, length);
    voice.connect(formant).connect(soften).connect(amp).connect(ctx.destination);
    voice.start(t0);
    vibrato.start(t0);
    voice.stop(t0 + length + 0.05);
    vibrato.stop(t0 + length + 0.05);
    return true;
  }

  purr(reason: CatSoundReason): boolean {
    const ctx = this.gate(reason);
    if (!ctx) return false;
    const t0 = ctx.currentTime + 0.02;
    const length = 1.3 + Math.random() * 0.6;

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx, length + 0.1);
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 340;

    // ~25 Hz amplitude flutter is what makes filtered noise sound like a purr.
    const flutter = ctx.createGain();
    flutter.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfo.frequency.value = 23 + Math.random() * 5;
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth).connect(flutter.gain);

    const amp = this.envelope(ctx, t0, 0.3, length);
    noise.connect(body).connect(flutter).connect(amp).connect(ctx.destination);
    noise.start(t0);
    lfo.start(t0);
    noise.stop(t0 + length + 0.05);
    lfo.stop(t0 + length + 0.05);
    return true;
  }

  /** The AudioContext when a sound of this kind may play now (sound on, unlocked, rate limits), else null. */
  private gate(reason: CatSoundReason): AudioContext | null {
    if (!this.enabled) return null;
    if (reason !== 'spontaneous') this.unlock();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const now = performance.now();
    if (now - this.lastSoundAt < 900) return null; // never overlap
    if (reason === 'spontaneous' && now < this.nextSpontaneousAt) return null;
    if (reason === 'click' && now - this.lastClickAt < CLICK_GAP_MS) return null;
    if (reason === 'command' && now - this.lastSoundAt < COMMAND_GAP_MS) return null;
    this.lastSoundAt = now;
    if (reason === 'click') this.lastClickAt = now;
    // Any sound pushes the next spontaneous one back.
    this.nextSpontaneousAt = Math.max(this.nextSpontaneousAt, now + randomIn(SPONTANEOUS_GAP_MS));
    return ctx;
  }

  private envelope(ctx: AudioContext, t0: number, attack: number, length: number): GainNode {
    const amp = ctx.createGain();
    const level = GAIN;
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(level, t0 + attack);
    amp.gain.setValueAtTime(level, t0 + Math.max(attack, length * 0.6));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + length);
    return amp;
  }

  private noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}

function randomIn([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}
