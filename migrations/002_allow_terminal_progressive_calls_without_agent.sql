ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_check;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_progressive_agent_check;

ALTER TABLE calls
  ADD CONSTRAINT calls_progressive_agent_check
  CHECK (
    mode <> 'PROGRESSIVE'
    OR agent_id IS NOT NULL
    OR state IN ('FAILED', 'CANCELLED', 'ABANDONED')
  );
