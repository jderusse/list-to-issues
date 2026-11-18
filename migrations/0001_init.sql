-- One row per mirrored (in) or sent (out) message.
CREATE TABLE messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	-- Message-ID without angle brackets. Unknown for an outbound row until send() returns.
	message_id TEXT UNIQUE,
	direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
	issue_number INTEGER,
	-- in: the first GitHub comment of the message, NULL when it is the issue body.
	-- out: the GitHub comment that was emailed.
	comment_id INTEGER,
	r2_key TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'unknown')),
	from_reporter INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX messages_out_comment ON messages (comment_id) WHERE direction = 'out';
CREATE INDEX messages_issue ON messages (issue_number);

CREATE TABLE threads (
	issue_number INTEGER PRIMARY KEY,
	root_message_id TEXT NOT NULL,
	subject TEXT NOT NULL,
	reporter_address TEXT NOT NULL,
	reporter_name TEXT NOT NULL DEFAULT '',
	-- JSON array of { "address": "...", "name": "..." }
	extra_recipients TEXT NOT NULL DEFAULT '[]',
	last_message_id TEXT,
	last_reporter_message_id TEXT,
	-- JSON array of the Message-IDs that follow the root, oldest first, capped
	refs TEXT NOT NULL DEFAULT '[]',
	closed_at TEXT,
	spam INTEGER NOT NULL DEFAULT 0,
	files_deleted_at TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX threads_closed ON threads (closed_at);
