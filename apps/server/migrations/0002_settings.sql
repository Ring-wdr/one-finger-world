-- Operator switches (docs/multiplayer-server-design.md §7.1). Flip with `bun run multiplayer -- on|off`.
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

INSERT INTO settings (key, value, updated_at) VALUES ('multiplayer', 'on', 0);
