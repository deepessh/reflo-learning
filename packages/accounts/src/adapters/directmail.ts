import * as CredentialModule from "@alicloud/credentials";
import { ECSRAMRoleCredentialsProvider } from "@alicloud/credentials";
import * as DirectMailModule from "@alicloud/dm20151123";
import { SingleSendMailRequest } from "@alicloud/dm20151123";

import type { MagicLinkMessage } from "../contracts.js";
import type { TransactionalEmailPort } from "../ports.js";

const ENDPOINTS = {
  "ap-southeast-1": "dm.ap-southeast-1.aliyuncs.com",
  "cn-hangzhou": "dm.aliyuncs.com",
  "eu-central-1": "dm.eu-central-1.aliyuncs.com",
  "us-east-1": "dm.us-east-1.aliyuncs.com",
} as const;

export type DirectMailRegion = keyof typeof ENDPOINTS;

export interface DirectMailAdapterConfig {
  readonly fromAlias: string;
  readonly ramRoleName: string;
  readonly region: DirectMailRegion;
  readonly senderAddress: string;
}

export interface DirectMailSingleSendClient {
  singleSendMail(request: SingleSendMailRequest): Promise<unknown>;
}

export class TransactionalEmailDeliveryError extends Error {
  constructor() {
    super("transactional_email_delivery_failed");
    this.name = "TransactionalEmailDeliveryError";
  }
}

export class DirectMailTransactionalEmailAdapter implements TransactionalEmailPort {
  constructor(
    private readonly client: DirectMailSingleSendClient,
    private readonly config: Pick<
      DirectMailAdapterConfig,
      "fromAlias" | "senderAddress"
    >,
  ) {
    assertSenderConfiguration(config);
  }

  async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    if (
      message.destination.includes(",") ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.destination)
    ) {
      throw new TransactionalEmailDeliveryError();
    }
    const request = new SingleSendMailRequest({
      accountName: this.config.senderAddress,
      addressType: 1,
      clickTrace: "0",
      fromAlias: this.config.fromAlias,
      htmlBody: htmlBody(message.loginUrl),
      replyToAddress: false,
      subject: "Your secure Reflo sign-in link",
      textBody: textBody(message.loginUrl),
      toAddress: message.destination,
      unSubscribeFilterLevel: "disabled",
      unSubscribeLinkType: "disabled",
    });

    try {
      await this.client.singleSendMail(request);
    } catch {
      // Provider payloads can contain contact data and request details. Normalize
      // without retaining the original error as a cause or diagnostic field.
      throw new TransactionalEmailDeliveryError();
    }
  }
}

export function createDirectMailTransactionalEmailAdapter(
  config: DirectMailAdapterConfig,
): DirectMailTransactionalEmailAdapter {
  assertSenderConfiguration(config);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.ramRoleName)) {
    throw new Error("DirectMail RAM role name is invalid");
  }
  const provider = ECSRAMRoleCredentialsProvider.builder()
    .withRoleName(config.ramRoleName)
    .withDisableIMDSv1(true)
    .withConnectTimeout(1_000)
    .withReadTimeout(1_000)
    .build();
  const CredentialClient =
    cjsDefault<new (config: null, credentialProvider: object) => object>(
      CredentialModule,
    );
  const DirectMailClient =
    cjsDefault<
      new (config: {
        credential: object;
        endpoint: string;
        protocol: string;
        regionId: string;
      }) => DirectMailSingleSendClient
    >(DirectMailModule);
  const credential = new CredentialClient(null, provider);
  const client = new DirectMailClient({
    credential,
    endpoint: ENDPOINTS[config.region],
    protocol: "https",
    regionId: config.region,
  });
  return new DirectMailTransactionalEmailAdapter(client, config);
}

function cjsDefault<Value>(module: unknown): Value {
  const first = (module as { default?: unknown }).default ?? module;
  return ((first as { default?: unknown }).default ?? first) as Value;
}

function assertSenderConfiguration(
  config: Pick<DirectMailAdapterConfig, "fromAlias" | "senderAddress">,
): void {
  if (
    config.fromAlias.trim() === "" ||
    Array.from(config.fromAlias).length > 15 ||
    /[\r\n]/.test(config.fromAlias)
  ) {
    throw new Error("DirectMail sender alias must contain 1 to 15 characters");
  }
  if (
    config.senderAddress.includes(",") ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.senderAddress)
  ) {
    throw new Error("DirectMail sender address is invalid");
  }
}

function textBody(loginUrl: string): string {
  return [
    "Sign in to Reflo",
    "",
    "Use this secure link to sign in:",
    loginUrl,
    "",
    "This link expires in 10 minutes and can be used once. If you did not request it, ignore this email.",
  ].join("\n");
}

function htmlBody(loginUrl: string): string {
  const escapedUrl = escapeHtml(loginUrl);
  return [
    "<h1>Sign in to Reflo</h1>",
    "<p>Use this secure link to sign in:</p>",
    `<p><a href="${escapedUrl}">Sign in securely</a></p>`,
    "<p>This link expires in 10 minutes and can be used once. If you did not request it, ignore this email.</p>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
