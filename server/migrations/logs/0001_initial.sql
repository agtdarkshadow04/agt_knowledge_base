-- LOG-1: the log store, a schema of its own that backups and restores never touch
-- (LOG-17). Log tables are append-only and exempt from DATA-8 (LOG-2).

-- The IP-hash key and the server-log "seen" marker.
CREATE TABLE logs.log_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);

-- LOG-7: events the server caused itself.
CREATE TABLE logs.server_log (
  id uuid PRIMARY KEY,
  at timestamptz NOT NULL,
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error', 'fatal')),
  source text NOT NULL,
  message text NOT NULL,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX server_log_at_idx ON logs.server_log (at, id);
CREATE INDEX server_log_level_idx ON logs.server_log (level, at);
CREATE INDEX server_log_source_idx ON logs.server_log (source, at);

-- LOG-10: events a user caused. actor_type 'member' is the AUTH-1 deviation.
CREATE TABLE logs.audit_log (
  id uuid PRIMARY KEY,
  at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1 CHECK (count >= 1),
  actor_type text NOT NULL CHECK (actor_type IN ('admin', 'member', 'anonymous')),
  actor text,
  ip_hash text,
  client text NOT NULL CHECK (client IN ('web', 'api')),
  action text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  target_type text,
  target_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'rate_limited', 'failure')),
  status_code integer NOT NULL,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON logs.audit_log (at, id);
CREATE INDEX audit_log_actor_type_idx ON logs.audit_log (actor_type, at);
CREATE INDEX audit_log_action_idx ON logs.audit_log (action, at);
CREATE INDEX audit_log_outcome_idx ON logs.audit_log (outcome, at);
CREATE INDEX audit_log_target_idx ON logs.audit_log (target_type, target_id, at);
-- LOG-11 coalescing looks up the latest identical failure.
CREATE INDEX audit_log_coalesce_idx ON logs.audit_log (action, outcome, status_code, ip_hash, last_at);
