CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'PAUSED'
    CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED')),
  pacing_mode text NOT NULL DEFAULT 'PROGRESSIVE'
    CHECK (pacing_mode IN ('PROGRESSIVE', 'PREDICTIVE')),
  provider text NOT NULL DEFAULT 'provider-a',
  safety_incidents integer NOT NULL DEFAULT 0 CHECK (safety_incidents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  state text NOT NULL DEFAULT 'OFFLINE'
    CHECK (state IN ('OFFLINE', 'AVAILABLE', 'RESERVED', 'DIALING', 'CONNECTED', 'WRAP_UP', 'PAUSED')),
  reservation_id uuid,
  reserved_until timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK ((state = 'RESERVED') = (reservation_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_agents_allocatable
  ON agents (campaign_id, state, state_changed_at, id);
CREATE INDEX IF NOT EXISTS idx_agents_expired_reservations
  ON agents (reserved_until)
  WHERE state = 'RESERVED';

CREATE TABLE IF NOT EXISTS borrowers (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'READY'
    CHECK (state IN ('READY', 'RESERVED', 'IN_CALL', 'COMPLETED', 'EXHAUSTED')),
  reservation_id uuid,
  reserved_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, phone_number),
  CHECK ((state = 'RESERVED') = (reservation_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_borrowers_ready
  ON borrowers (campaign_id, priority DESC, next_attempt_at, id)
  WHERE state = 'READY';

CREATE TABLE IF NOT EXISTS safety_decisions (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL UNIQUE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  requested_mode text NOT NULL CHECK (requested_mode IN ('PROGRESSIVE', 'PREDICTIVE')),
  effective_mode text NOT NULL CHECK (effective_mode IN ('PROGRESSIVE', 'PREDICTIVE')),
  requested_calls integer NOT NULL CHECK (requested_calls >= 0),
  approved_calls integer NOT NULL CHECK (approved_calls >= 0),
  verdict text NOT NULL CHECK (verdict IN ('APPROVED', 'REDUCED', 'REJECTED', 'FALLBACK_TO_PROGRESSIVE')),
  reasons jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_calls <= requested_calls)
);

CREATE TABLE IF NOT EXISTS dial_permits (
  id uuid PRIMARY KEY,
  decision_id uuid NOT NULL REFERENCES safety_decisions(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('PROGRESSIVE', 'PREDICTIVE')),
  status text NOT NULL DEFAULT 'ISSUED'
    CHECK (status IN ('ISSUED', 'CONSUMED', 'EXPIRED')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dial_permits_issued
  ON dial_permits (campaign_id, expires_at)
  WHERE status = 'ISSUED';

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  borrower_id uuid NOT NULL REFERENCES borrowers(id),
  agent_id uuid REFERENCES agents(id),
  permit_id uuid NOT NULL UNIQUE REFERENCES dial_permits(id),
  mode text NOT NULL CHECK (mode IN ('PROGRESSIVE', 'PREDICTIVE')),
  provider text NOT NULL,
  external_call_id text,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'RESERVED'
    CHECK (state IN ('QUEUED', 'RESERVED', 'INITIATED', 'RINGING', 'ANSWERED', 'CONNECTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  initiated_at timestamptz,
  answered_at timestamptz,
  connected_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode <> 'PROGRESSIVE' OR agent_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_active_agent
  ON calls (agent_id)
  WHERE agent_id IS NOT NULL
    AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED');
CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_active_borrower
  ON calls (borrower_id)
  WHERE state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED');
CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_provider_external_id
  ON calls (provider, external_call_id)
  WHERE external_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_campaign_state
  ON calls (campaign_id, state, created_at);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('PLACE_CALL', 'CANCEL_CALL')),
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_outbox_claimable
  ON outbox (available_at, created_at)
  WHERE status IN ('PENDING', 'PROCESSING');

CREATE TABLE IF NOT EXISTS provider_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  external_call_id text NOT NULL,
  event_type text NOT NULL
    CHECK (event_type IN ('INITIATED', 'RINGING', 'ANSWERED', 'CONNECTED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_result text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_events_unprocessed
  ON provider_events (received_at)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS provider_health (
  provider text PRIMARY KEY,
  healthy boolean NOT NULL DEFAULT true,
  error_rate double precision NOT NULL DEFAULT 0 CHECK (error_rate BETWEEN 0 AND 1),
  p95_latency_ms integer NOT NULL DEFAULT 0 CHECK (p95_latency_ms >= 0),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO provider_health (provider)
VALUES ('provider-a'), ('provider-b')
ON CONFLICT (provider) DO NOTHING;
