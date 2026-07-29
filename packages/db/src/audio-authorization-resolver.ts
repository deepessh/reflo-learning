import type { ScopeAuthorizationContext } from "@reflo/retrieval";
import pg from "pg";

const { Pool } = pg;

interface AudioAuthorizationRow extends Record<string, unknown> {
  actor_id: string;
  authorization_id: string;
  owner_scope_id: string;
}

export class PostgresAudioAuthorizationResolver {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new Error("audio authorization database is invalid");
    }
    this.#pool = new Pool({ connectionString });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async resolve(input: {
    readonly courseId: string;
    readonly operationId: string;
  }): Promise<ScopeAuthorizationContext | null> {
    if (!isUuid(input.courseId) || !isUuid(input.operationId)) {
      return null;
    }
    const client = await this.#pool.connect();
    try {
      const result = await client.query<AudioAuthorizationRow>(
        `SELECT actor_id, authorization_id, owner_scope_id
         FROM reflo_resolve_audio_authorization($1, $2)`,
        [input.courseId, input.operationId],
      );
      const row = result.rows[0];
      if (row === undefined || result.rows.length !== 1) {
        return null;
      }
      return {
        actorId: row.actor_id,
        authorizationId: row.authorization_id,
        ownerScopeId: row.owner_scope_id,
      };
    } finally {
      client.release();
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
