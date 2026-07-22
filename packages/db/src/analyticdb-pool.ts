import type {
  AnalyticDbPoolPort,
  AnalyticDbSessionPort,
  SqlQueryResult,
} from "@reflo/retrieval";
import pg from "pg";

const { Pool } = pg;

export class PostgresAnalyticDbPool implements AnalyticDbPoolPort {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    if (connectionString.length === 0) {
      throw new Error("vector database connection is required");
    }
    this.#pool = new Pool({ connectionString });
  }

  async connect(): Promise<AnalyticDbSessionPort> {
    const client = await this.#pool.connect();
    return {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<SqlQueryResult<Row>> => {
        const result = await client.query<Row>(text, values as unknown[]);
        return { rowCount: result.rowCount, rows: result.rows };
      },
      release: () => client.release(),
    };
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}
