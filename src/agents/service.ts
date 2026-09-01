import type { Pool } from "pg";
import { AGENT_STATES, canTransitionAgent, type AgentState } from "../domain/agent.js";
import { withTransaction } from "../persistence/database.js";

interface AgentRow {
  readonly id: string;
  readonly state: AgentState;
}

export class AgentService {
  constructor(private readonly pool: Pool) {}

  async transition(agentId: string, target: string): Promise<AgentState> {
    if (!isAgentState(target)) throw new Error(`Unknown agent state: ${target}`);

    return withTransaction(this.pool, async (client) => {
      const result = await client.query<AgentRow>(
        "SELECT id, state FROM agents WHERE id = $1 FOR UPDATE",
        [agentId],
      );
      const agent = result.rows[0];
      if (agent === undefined) throw new Error(`Agent ${agentId} was not found.`);
      if (!canTransitionAgent(agent.state, target)) {
        throw new Error(`Invalid agent transition: ${agent.state} -> ${target}`);
      }
      if (target === "RESERVED") {
        throw new Error("Manual transitions to RESERVED are not allowed; use the allocator.");
      }

      await client.query(
        `UPDATE agents
         SET state = $2, reservation_id = NULL, reserved_until = NULL,
             last_seen_at = now(), state_changed_at = now(), version = version + 1
         WHERE id = $1`,
        [agentId, target],
      );
      return target;
    });
  }
}

function isAgentState(value: string): value is AgentState {
  return (AGENT_STATES as readonly string[]).includes(value);
}
