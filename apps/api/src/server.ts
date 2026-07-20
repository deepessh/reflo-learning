import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  AccountInputError,
  type AccountService,
  RecentAuthenticationRequiredError,
} from "@reflo/accounts";
import type { ServerEnvironment } from "@reflo/config";
import { HEALTH_CONTRACT_VERSION, type HealthResponse } from "@reflo/contracts";

const SESSION_COOKIE = "__Host-reflo_session";
const CSRF_COOKIE = "__Host-reflo_csrf";

export interface ApiDependencies {
  readonly accounts?: AccountService;
}

export function createApiServer(
  environment: ServerEnvironment,
  dependencies: ApiDependencies = {},
): Server {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const body: HealthResponse = {
        contractVersion: HEALTH_CONTRACT_VERSION,
        environment: environment.deployment,
        service: environment.service,
        status: "ok",
      };

      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
      return;
    }

    const accounts = dependencies.accounts;
    if (accounts !== undefined && request.url !== undefined) {
      const url = new URL(request.url, "http://api.invalid");
      const origin = singleHeader(request.headers.origin);
      if (request.method === "OPTIONS") {
        if (!accounts.isTrustedOrigin(origin)) {
          sendJson(response, 403, { error: "origin_not_allowed" });
          return;
        }
        writeCors(response, origin!);
        response.writeHead(204, {
          "access-control-allow-headers": "content-type, x-reflo-csrf",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        });
        response.end();
        return;
      }

      try {
        if (
          request.method === "POST" &&
          url.pathname === "/v1/auth/magic-link"
        ) {
          if (!accounts.isTrustedOrigin(origin)) {
            sendJson(response, 403, { error: "origin_not_allowed" });
            return;
          }
          const body = await readJsonBody(request);
          const email = stringField(body, "email");
          await accounts.requestMagicLink(email, origin!);
          writeCors(response, origin!);
          sendJson(response, 202, { accepted: true });
          return;
        }

        if (
          request.method === "POST" &&
          url.pathname === "/v1/auth/magic-link/redeem"
        ) {
          if (!accounts.isTrustedOrigin(origin)) {
            sendJson(response, 403, { error: "origin_not_allowed" });
            return;
          }
          const token = stringField(await readJsonBody(request), "token");
          const session = await accounts.redeemMagicLink(token);
          if (session === null) {
            sendJson(response, 401, { error: "login_link_invalid" });
            return;
          }
          writeCors(response, origin!);
          response.setHeader("set-cookie", sessionCookies(session));
          sendJson(response, 200, {
            authenticatedAt: session.authenticatedAt,
            ownerScopeId: session.ownerScopeId,
            userId: session.userId,
          });
          return;
        }

        if (url.pathname.startsWith("/v1/")) {
          const cookies = parseCookies(singleHeader(request.headers.cookie));
          const sessionSecret = cookies.get(SESSION_COOKIE) ?? "";
          const account = await accounts.authenticate(sessionSecret);
          if (account === null) {
            sendJson(response, 401, { error: "authentication_required" });
            return;
          }

          if (request.method === "GET" && url.pathname === "/v1/account") {
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, {
              authenticatedAt: account.authenticatedAt,
              ownerScopeId: account.ownerScopeId,
              userId: account.userId,
            });
            return;
          }
          if (request.method === "GET" && url.pathname === "/v1/library") {
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, {
              courses: await accounts.listLibrary(account),
            });
            return;
          }
          if (
            request.method === "GET" &&
            url.pathname === "/v1/session-history"
          ) {
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, {
              sessions: await accounts.listSessionHistory(account),
            });
            return;
          }

          if (request.method === "POST") {
            if (
              !accounts.isTrustedOrigin(origin) ||
              !accounts.verifyCsrf(
                sessionSecret,
                cookies.get(CSRF_COOKIE),
                singleHeader(request.headers["x-reflo-csrf"]),
              )
            ) {
              sendJson(response, 403, { error: "csrf_rejected" });
              return;
            }
            if (url.pathname === "/v1/auth/logout") {
              await accounts.logout(sessionSecret);
              writeCors(response, origin!);
              response.setHeader("set-cookie", clearedSessionCookies());
              response.writeHead(204);
              response.end();
              return;
            }
            if (url.pathname === "/v1/account/deletion-start") {
              await accounts.beginDeletion(account);
              writeCors(response, origin!);
              response.setHeader("set-cookie", clearedSessionCookies());
              response.writeHead(202, {
                "content-type": "application/json; charset=utf-8",
              });
              response.end(JSON.stringify({ accepted: true }));
              return;
            }
          }
        }
      } catch (error) {
        if (error instanceof RecentAuthenticationRequiredError) {
          sendJson(response, 403, { error: error.message });
          return;
        }
        if (
          error instanceof AccountInputError ||
          error instanceof JsonBodyError
        ) {
          sendJson(response, 400, { error: "invalid_request" });
          return;
        }
        sendJson(response, 503, { error: "service_unavailable" });
        return;
      }
    }

    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeCors(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) {
      throw new JsonBodyError();
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new JsonBodyError();
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof JsonBodyError) {
      throw error;
    }
    throw new JsonBodyError();
  }
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") {
    throw new JsonBodyError();
  }
  return value;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 1) {
      continue;
    }
    cookies.set(
      pair.slice(0, separator).trim(),
      pair.slice(separator + 1).trim(),
    );
  }
  return cookies;
}

function sessionCookies(session: {
  readonly csrfToken: string;
  readonly sessionSecret: string;
}): string[] {
  return [
    `${SESSION_COOKIE}=${session.sessionSecret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    `${CSRF_COOKIE}=${session.csrfToken}; Path=/; Secure; SameSite=Lax; Max-Age=2592000`,
  ];
}

function clearedSessionCookies(): string[] {
  return [
    `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`,
  ];
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

class JsonBodyError extends Error {}
