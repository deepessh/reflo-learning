import OSS from "ali-oss";

export interface RefloOssClient {
  get(name: string): Promise<{
    readonly content: Uint8Array;
    readonly res: { readonly status: number };
  }>;
  head(name: string): Promise<{
    readonly meta?: Readonly<Record<string, string | number>>;
    readonly res: {
      readonly headers?: Readonly<Record<string, string | undefined>>;
      readonly size?: number;
      readonly status: number;
    };
  }>;
  put(
    name: string,
    bytes: Uint8Array,
    options: {
      readonly headers: Readonly<Record<string, string>>;
      readonly mime: string;
    },
  ): Promise<{ readonly res: { readonly status: number } }>;
}

export interface TemporaryOssCredentials {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly stsToken: string;
}

export async function createAliOssPrivateClient(input: {
  readonly bucket: string;
  readonly loadCredentials: () => Promise<TemporaryOssCredentials>;
  readonly region: string;
}): Promise<RefloOssClient> {
  const initial = await input.loadCredentials();
  const oss = new OSS({
    ...initial,
    authorizationV4: true,
    bucket: input.bucket,
    internal: true,
    refreshSTSToken: input.loadCredentials,
    refreshSTSTokenInterval: 5 * 60 * 1_000,
    region: `oss-${input.region}`,
    secure: true,
    timeout: 30_000,
  });
  return {
    async get(name) {
      const result = await oss.get(name);
      if (result.content === undefined) {
        throw new Error("missing OSS object content");
      }
      return { content: result.content, res: result.res };
    },
    async head(name) {
      const result = await oss.head(name);
      const headers = result.res.headers as
        Readonly<Record<string, string | undefined>> | undefined;
      return {
        meta: result.meta,
        res: {
          headers,
          size: Number(headers?.["content-length"]),
          status: result.res.status,
        },
      };
    },
    put: (name, bytes, options) => oss.put(name, bytes, options),
  };
}
