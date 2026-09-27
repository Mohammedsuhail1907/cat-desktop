-- CatDesktop schema, version 2: the Desktop Cat Companion replaces the Pet Book (docs/DESKTOP-CONTRACT.md section 6).
-- Applied by CatDesktop.Host.Database.SqliteDatabase inside a transaction; the runner records the version in
-- schema_migrations, so this script must never insert into that table itself.
-- The Pet Book's settings ('petbook.settings') and window position (window_states 'petbook') are converted by the host
-- at start-up (JSON mapping, see Cat/CatLegacyMigration.cs), not here.

-- The quick actions now live in the cat's companion panel.
ALTER TABLE pet_book_actions RENAME TO quick_actions;

-- Pet Book action types that no longer exist.
DELETE FROM quick_actions WHERE action_type IN ('toggle-compact', 'return-home');

-- The untouched default 'pin' action now reads "Always on Top" (same as QuickActionDefaults / actions.reset).
UPDATE quick_actions SET name = 'Always on Top' WHERE id = 'pin' AND action_type = 'pin' AND name = 'Pin';
