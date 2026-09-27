-- CatDesktop schema, version 1 (docs/DESKTOP-CONTRACT.md section 6).
-- Applied by CatDesktop.Host.Database.SqliteDatabase inside a transaction; the runner records the
-- version in schema_migrations, so this script must never insert into that table itself.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
);

-- value holds JSON (any kind, including null/strings/numbers), never raw text.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
    id         TEXT    PRIMARY KEY,
    title      TEXT    NOT NULL DEFAULT '',
    content    TEXT    NOT NULL DEFAULT '',
    color      TEXT    NULL,
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT    PRIMARY KEY,
    title        TEXT    NOT NULL,
    notes        TEXT    NULL,
    completed    INTEGER NOT NULL DEFAULT 0,
    priority     INTEGER NOT NULL DEFAULT 0,
    due_at       TEXT    NULL,
    completed_at TEXT    NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS pet_book_actions (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    icon        TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    route       TEXT    NULL,
    action_type TEXT    NOT NULL,
    payload     TEXT    NULL
);

CREATE TABLE IF NOT EXISTS window_states (
    window_id    TEXT    PRIMARY KEY,
    monitor      TEXT    NULL,
    x            INTEGER NOT NULL,
    y            INTEGER NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    is_maximized INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS focus_sessions (
    id              TEXT    PRIMARY KEY,
    phase           TEXT    NOT NULL,
    started_at      TEXT    NOT NULL,
    ended_at        TEXT    NULL,
    planned_seconds INTEGER NOT NULL,
    completed       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_notes_updated_at ON notes (updated_at);
CREATE INDEX IF NOT EXISTS ix_tasks_completed_sort_order ON tasks (completed, sort_order);
CREATE INDEX IF NOT EXISTS ix_tasks_due_at ON tasks (due_at);

-- Default Pet Book quick actions (contract section 3, actions.*). Same set as PetBookActionDefaults.All.
INSERT OR IGNORE INTO pet_book_actions (id, name, icon, enabled, sort_order, route, action_type, payload) VALUES
    ('home',       'Home',        'home',     1, 0, '/dashboard', 'navigate',   NULL),
    ('quick-note', 'Quick Note',  'note',     1, 1, NULL,         'quick-note', NULL),
    ('tasks',      'Tasks',       'tasks',    1, 2, NULL,         'tasks',      NULL),
    ('focus',      'Focus Timer', 'timer',    1, 3, NULL,         'focus',      NULL),
    ('reminders',  'Reminders',   'bell',     1, 4, NULL,         'reminders',  NULL),
    ('pin',        'Pin',         'pin',      1, 5, NULL,         'pin',        NULL),
    ('search',     'Search',      'search',   1, 6, '/notes',     'search',     NULL),
    ('settings',   'Settings',    'settings', 1, 7, '/settings',  'navigate',   NULL);
