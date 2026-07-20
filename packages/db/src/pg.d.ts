declare module "pg" {
  export interface QueryResult<Row extends Record<string, unknown>> {
    readonly rowCount: number | null;
    readonly rows: Row[];
  }

  export interface PoolClient {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>>;
    release(): void;
  }

  export class Pool {
    constructor(options: { readonly connectionString: string });
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }

  const pg: { readonly Pool: typeof Pool };
  export default pg;
}
