-- Local sync agent tables
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- Task queue: dashboard creates tasks, agent executes them
CREATE TABLE IF NOT EXISTS sync_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','error','expired')),
  phase SMALLINT DEFAULT 1,
  message TEXT,
  requires_2fa BOOLEAN DEFAULT FALSE,
  agent_id TEXT,
  error TEXT,
  movements_inserted INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

ALTER TABLE sync_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own tasks" ON sync_tasks
  FOR ALL USING (auth.uid()::text = user_id);

CREATE INDEX IF NOT EXISTS idx_sync_tasks_pending
  ON sync_tasks (user_id, status) WHERE status = 'pending';

-- Agent presence: heartbeat-based online detection
CREATE TABLE IF NOT EXISTS agent_presence (
  user_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
  banks TEXT[] NOT NULL DEFAULT '{}',
  version TEXT
);

ALTER TABLE agent_presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own presence" ON agent_presence
  FOR ALL USING (auth.uid()::text = user_id);

-- Enable Realtime on both tables
ALTER PUBLICATION supabase_realtime ADD TABLE sync_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_presence;
