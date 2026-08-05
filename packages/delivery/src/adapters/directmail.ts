import * as CredentialModule from "@alicloud/credentials";
import { ECSRAMRoleCredentialsProvider } from "@alicloud/credentials";
import * as DirectMailModule from "@alicloud/dm20151123";
import { SingleSendMailRequest } from "@alicloud/dm20151123";

import type { DeliveryMessage } from "../contracts.js";
import { DeliveryError } from "../errors.js";
import { REVIEW_MESSAGE_COPY } from "../experience.js";
import type { DemoMessagePort } from "../ports.js";

const ENDPOINTS = {
  "ap-southeast-1": "dm.ap-southeast-1.aliyuncs.com",
  "cn-hangzhou": "dm.aliyuncs.com",
  "eu-central-1": "dm.eu-central-1.aliyuncs.com",
  "us-east-1": "dm.us-east-1.aliyuncs.com",
} as const;

export type DemoDirectMailRegion = keyof typeof ENDPOINTS;

export interface DemoDirectMailConfig {
  readonly fromAlias: string;
  readonly ramRoleName: string;
  readonly region: DemoDirectMailRegion;
  readonly senderAddress: string;
}

export interface DemoDirectMailClient {
  singleSendMail(request: SingleSendMailRequest): Promise<unknown>;
}

export class DirectMailDemoMessageAdapter implements DemoMessagePort {
  readonly provider = "email" as const;

  constructor(
    private readonly client: DemoDirectMailClient,
    private readonly config: Pick<
      DemoDirectMailConfig,
      "fromAlias" | "senderAddress"
    >,
  ) {
    assertConfiguration(config);
  }

  async send(message: DeliveryMessage): Promise<{
    readonly providerMessageId: string;
  }> {
    if (
      message.provider !== this.provider ||
      message.emailLink === null ||
      message.recipient.includes(",") ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.recipient)
    ) {
      throw new DeliveryError("invalid_input");
    }
    const request = new SingleSendMailRequest({
      accountName: this.config.senderAddress,
      addressType: 1,
      clickTrace: "0",
      fromAlias: this.config.fromAlias,
      htmlBody: htmlBody(message.emailLink),
      replyToAddress: false,
      subject: REVIEW_MESSAGE_COPY.emailSubject,
      textBody: textBody(message.emailLink),
      toAddress: message.recipient,
      unSubscribeFilterLevel: "disabled",
      unSubscribeLinkType: "disabled",
    });
    let result: unknown;
    try {
      result = await this.client.singleSendMail(request);
    } catch {
      throw new DeliveryError("dispatch_ambiguous");
    }
    return {
      providerMessageId:
        providerRequestId(result) ??
        `directmail/accepted/${message.deliveryId}`,
    };
  }
}

export function createDirectMailDemoMessageAdapter(
  config: DemoDirectMailConfig,
): DirectMailDemoMessageAdapter {
  assertConfiguration(config);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.ramRoleName)) {
    throw new DeliveryError("invalid_configuration");
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
      }) => DemoDirectMailClient
    >(DirectMailModule);
  const credential = new CredentialClient(null, provider);
  return new DirectMailDemoMessageAdapter(
    new DirectMailClient({
      credential,
      endpoint: ENDPOINTS[config.region],
      protocol: "https",
      regionId: config.region,
    }),
    config,
  );
}

function assertConfiguration(
  config: Pick<DemoDirectMailConfig, "fromAlias" | "senderAddress">,
): void {
  if (
    config.fromAlias.trim() === "" ||
    Array.from(config.fromAlias).length > 15 ||
    /[\r\n]/.test(config.fromAlias) ||
    config.senderAddress.includes(",") ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.senderAddress)
  ) {
    throw new DeliveryError("invalid_configuration");
  }
}

function textBody(link: string): string {
  return [
    REVIEW_MESSAGE_COPY.emailHeading,
    "",
    "A short review is waiting for you:",
    link,
    "",
    "Open it soon; the secure link expires automatically. Email replies are not read or graded.",
  ].join("\n");
}

function htmlBody(link: string): string {
  return [
    `<h1>${REVIEW_MESSAGE_COPY.emailHeading}</h1>`,
    "<p>A short review is waiting for you.</p>",
    `<p><a href="${escapeHtml(link)}">${REVIEW_MESSAGE_COPY.action}</a></p>`,
    "<p>Open it soon; the secure link expires automatically. Email replies are not read or graded.</p>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function providerRequestId(value: unknown): string | null {
  const candidates = [value, objectField(value, "body")];
  for (const candidate of candidates) {
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      for (const key of ["requestId", "RequestId", "envId", "EnvId"]) {
        const field = (candidate as Record<string, unknown>)[key];
        if (typeof field === "string" && field.length > 0) {
          return `directmail/${field}`;
        }
      }
    }
  }
  return null;
}

function objectField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : null;
}

function cjsDefault<Value>(module: unknown): Value {
  const first = (module as { default?: unknown }).default ?? module;
  return ((first as { default?: unknown }).default ?? first) as Value;
}
