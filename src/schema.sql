CREATE TABLE IF NOT EXISTS giveaways (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  prize TEXT NOT NULL,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  winner_id BIGINT,
  winner_username TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  giveaway_id INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  username TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (giveaway_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways(status);
CREATE INDEX IF NOT EXISTS idx_entries_giveaway ON entries(giveaway_id);
