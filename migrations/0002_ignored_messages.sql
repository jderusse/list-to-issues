-- Messages that were dropped on purpose, so that replies to them are dropped too.
CREATE TABLE ignored_messages (
	message_id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL
);
