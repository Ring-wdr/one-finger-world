-- Accounts and meta progression (docs/multiplayer-server-design.md §9).
CREATE TABLE players (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
	best INTEGER NOT NULL DEFAULT 0,
	matches INTEGER NOT NULL DEFAULT 0,
	-- JSON array of rune ids
	owned TEXT NOT NULL DEFAULT '[]',
	-- JSON object: slot -> rune id or null
	equipped TEXT NOT NULL DEFAULT '{"offense":null,"defense":null,"utility":null}',
	-- Optimistic concurrency for shop writes
	version INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL
);

CREATE INDEX players_best ON players (best DESC);

CREATE TABLE matches (
	id TEXT PRIMARY KEY,
	seed INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER NOT NULL,
	duration_s REAL NOT NULL,
	humans INTEGER NOT NULL,
	winner_player_id TEXT
);

-- One row per human seat. The primary key makes reward grants idempotent: a retried grant
-- fails on it and its batch rolls back without paying twice. Rows are written as each seat's
-- result is decided, before the matches row exists, so there is no foreign key to matches.
CREATE TABLE match_results (
	match_id TEXT NOT NULL,
	player_id TEXT NOT NULL REFERENCES players (id),
	placement INTEGER NOT NULL,
	kills INTEGER NOT NULL,
	level INTEGER NOT NULL,
	survived_s REAL NOT NULL,
	score INTEGER NOT NULL,
	coins INTEGER NOT NULL,
	left_early INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (match_id, player_id)
);

CREATE INDEX match_results_player ON match_results (player_id, created_at DESC);
