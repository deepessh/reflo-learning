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
import {
  AssessmentError,
  type AssessmentFinalizationView,
} from "@reflo/assessment";
import type { ServerEnvironment } from "@reflo/config";
import {
  type ConnectedDemoPreflightView,
  HEALTH_CONTRACT_VERSION,
  type ConnectedStudyView,
  type HealthResponse,
} from "@reflo/contracts";
import {
  DeliveryError,
  type DemoDeliveryService,
  type DemoDeliveryProvider,
} from "@reflo/delivery";
import { TutorAgentError, type TutorAgentService } from "@reflo/tutor-agent";

const SESSION_COOKIE = "__Host-reflo_session";
const CSRF_COOKIE = "__Host-reflo_csrf";

export interface ApiDependencies {
  readonly accounts?: AccountService;
  readonly delivery?: Pick<
    DemoDeliveryService,
    "dispatch" | "handleTelegramWebhook" | "previewEmail" | "submitEmail"
  >;
  readonly localAuthInbox?: {
    take(accessKey: string | undefined): {
      readonly expiresAt: string;
      readonly loginUrl: string;
    } | null;
  };
  readonly now?: () => Date;
  readonly assessment?: {
    gradeReplacement(input: {
      readonly answer: string;
      readonly authorization: ReturnType<typeof deliveryAuthorization>;
      readonly bundleId: string;
      readonly idempotencyKey: string;
      readonly itemId: string;
      readonly sessionId: string;
    }): Promise<AssessmentFinalizationView>;
    gradeShortAnswer(input: {
      readonly answer: string;
      readonly authorization: ReturnType<typeof deliveryAuthorization>;
      readonly deadlineMs: number;
      readonly idempotencyKey: string;
      readonly questionId: string;
      readonly sessionId: string;
    }): Promise<AssessmentFinalizationView>;
  };
  readonly preflight?: {
    check(deliveryAvailable: boolean): Promise<ConnectedDemoPreflightView>;
  };
  readonly seed?: {
    reset(authorization: ReturnType<typeof deliveryAuthorization>): Promise<{
      readonly conceptId: string;
      readonly courseId: string;
      readonly demoOnly: true;
      readonly sessionId: string;
    }>;
  };
  readonly sessions?: {
    loadSummary(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
    ): Promise<{
      readonly courseId: string;
      readonly sessionId: string;
      readonly status: "active" | "completed" | "abandoned";
      readonly summary: Readonly<Record<string, unknown>> | null;
    } | null>;
  };
  readonly study?: {
    load(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
    ): Promise<ConnectedStudyView | null>;
  };
  readonly tutorAgent?: Pick<TutorAgentService, "ask" | "nextAction">;
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

    if (request.method === "GET" && request.url === "/v1/demo/preflight") {
      const preflight = dependencies.preflight;
      const preflightOrigin = singleHeader(request.headers.origin);
      if (
        preflightOrigin !== undefined &&
        dependencies.accounts?.isTrustedOrigin(preflightOrigin) === true
      ) {
        writeCors(response, preflightOrigin);
      }
      if (preflight === undefined) {
        sendJson(response, 503, {
          dependencies: [],
          error: "connected_demo_unavailable",
          status: "unavailable",
        });
        return;
      }
      const result = await preflight.check(dependencies.delivery !== undefined);
      sendJson(response, result.status === "ready" ? 200 : 503, result);
      return;
    }

    if (request.method === "POST" && request.url === "/v1/webhooks/telegram") {
      const delivery = dependencies.delivery;
      if (delivery === undefined) {
        sendJson(response, 503, { error: "service_unavailable" });
        return;
      }
      try {
        const results = await delivery.handleTelegramWebhook(
          await readRawBody(request),
          singleHeader(request.headers["x-telegram-bot-api-secret-token"]),
        );
        sendJson(response, 200, { accepted: true, results });
      } catch (error) {
        if (error instanceof DeliveryError) {
          sendJson(response, deliveryErrorStatus(error), {
            error: error.code,
          });
        } else if (error instanceof JsonBodyError) {
          sendJson(response, 400, { error: "invalid_request" });
        } else {
          sendJson(response, 503, { error: "service_unavailable" });
        }
      }
      return;
    }

    if (request.method === "POST" && request.url === "/v1/webhooks/email") {
      request.resume();
      response.writeHead(204);
      response.end();
      return;
    }

    if (
      request.method === "GET" &&
      request.url === "/v1/dev/auth-inbox/latest"
    ) {
      const message = dependencies.localAuthInbox?.take(
        singleHeader(request.headers["x-reflo-dev-inbox-key"]),
      );
      if (message === null || message === undefined) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      sendJson(response, 200, { message });
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
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 401, { error: "authentication_required" });
            return;
          }
          if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
            writeCors(response, origin);
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
          if (request.method === "GET" && url.pathname === "/v1/csrf-token") {
            if (origin !== undefined && !accounts.isTrustedOrigin(origin)) {
              sendJson(response, 403, { error: "origin_not_allowed" });
              return;
            }
            const csrfToken = cookies.get(CSRF_COOKIE);
            if (
              csrfToken === undefined ||
              !accounts.verifyCsrf(sessionSecret, csrfToken, csrfToken)
            ) {
              sendJson(response, 403, { error: "csrf_rejected" });
              return;
            }
            if (origin !== undefined) {
              writeCors(response, origin);
            }
            sendJson(response, 200, { csrfToken });
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
          if (
            request.method === "GET" &&
            url.pathname === "/v1/demo/email-quiz"
          ) {
            const delivery = dependencies.delivery;
            if (delivery === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            const token = url.searchParams.get("token");
            if (token === null) {
              throw new JsonBodyError();
            }
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, {
              quiz: await delivery.previewEmail(
                deliveryAuthorization(account),
                token,
                currentTime(dependencies),
              ),
            });
            return;
          }
          const progressCourseId = courseProgressRoute(url.pathname);
          if (request.method === "GET" && progressCourseId !== null) {
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            const progress = await accounts.getCourseProgress(
              account,
              progressCourseId,
            );
            if (progress === null) {
              sendJson(response, 404, { error: "course_not_found" });
              return;
            }
            sendJson(response, 200, { progress });
            return;
          }
          const summarySessionId = studySessionRoute(url.pathname, "summary");
          if (request.method === "GET" && summarySessionId !== null) {
            const sessions = dependencies.sessions;
            if (sessions === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            const summary = await sessions.loadSummary(
              deliveryAuthorization(account),
              summarySessionId,
            );
            if (summary === null) {
              sendJson(response, 404, { error: "study_session_not_found" });
              return;
            }
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, { session: summary });
            return;
          }
          const stateSessionId = studySessionRoute(url.pathname, "state");
          if (request.method === "GET" && stateSessionId !== null) {
            const study = dependencies.study;
            if (study === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            const view = await study.load(
              deliveryAuthorization(account),
              stateSessionId,
            );
            if (view === null) {
              sendJson(response, 404, { error: "study_session_not_found" });
              return;
            }
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, { view });
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
            if (url.pathname === "/v1/demo/deliveries/dispatch") {
              const delivery = dependencies.delivery;
              if (delivery === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const provider = deliveryProvider(body, "provider");
              const result = await delivery.dispatch({
                authorization: deliveryAuthorization(account),
                idempotencyKey: stringField(body, "idempotencyKey"),
                now: currentTime(dependencies),
                provider,
              });
              writeCors(response, origin!);
              sendJson(response, 200, { result });
              return;
            }
            if (url.pathname === "/v1/demo/seed/reset") {
              const seed = dependencies.seed;
              if (seed === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const result = await seed.reset(deliveryAuthorization(account));
              writeCors(response, origin!);
              sendJson(response, 200, { seed: result });
              return;
            }
            if (url.pathname === "/v1/demo/email-quiz/submit") {
              const delivery = dependencies.delivery;
              if (delivery === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const results = await delivery.submitEmail(
                deliveryAuthorization(account),
                stringField(body, "token"),
                answerFields(body, "answers"),
                currentTime(dependencies),
              );
              writeCors(response, origin!);
              sendJson(response, 200, { results });
              return;
            }
            const nextActionSessionId = studySessionRoute(url.pathname, "next");
            if (nextActionSessionId !== null) {
              const tutorAgent = dependencies.tutorAgent;
              if (tutorAgent === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const action = await tutorAgent.nextAction({
                authorization: {
                  actorId: account.userId,
                  authorizationId: account.sessionId,
                  ownerScopeId: account.ownerScopeId,
                },
                deadlineMs: 30_000,
                sessionId: nextActionSessionId,
              });
              writeCors(response, origin!);
              sendJson(response, 200, { action });
              return;
            }
            const askSessionId = studySessionRoute(url.pathname, "ask");
            if (askSessionId !== null) {
              const tutorAgent = dependencies.tutorAgent;
              if (tutorAgent === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const answer = await tutorAgent.ask({
                authorization: {
                  actorId: account.userId,
                  authorizationId: account.sessionId,
                  ownerScopeId: account.ownerScopeId,
                },
                courseId: stringField(body, "courseId"),
                deadlineMs: 30_000,
                idempotencyKey: stringField(body, "idempotencyKey"),
                question: stringField(body, "question"),
                sessionId: askSessionId,
                sourceDocumentId: stringField(body, "sourceDocumentId"),
              });
              writeCors(response, origin!);
              sendJson(response, 200, { answer });
              return;
            }
            const shortAnswerSessionId = studySessionRoute(
              url.pathname,
              "answers/short-answer",
            );
            if (shortAnswerSessionId !== null) {
              const assessment = dependencies.assessment;
              if (assessment === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const result = await assessment.gradeShortAnswer({
                answer: stringField(body, "answer"),
                authorization: deliveryAuthorization(account),
                deadlineMs: 30_000,
                idempotencyKey: stringField(body, "idempotencyKey"),
                questionId: stringField(body, "questionId"),
                sessionId: shortAnswerSessionId,
              });
              writeCors(response, origin!);
              sendJson(response, 200, { result });
              return;
            }
            const replacementSessionId = studySessionRoute(
              url.pathname,
              "answers/replacement",
            );
            if (replacementSessionId !== null) {
              const assessment = dependencies.assessment;
              if (assessment === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const result = await assessment.gradeReplacement({
                answer: stringField(body, "answer"),
                authorization: deliveryAuthorization(account),
                bundleId: stringField(body, "bundleId"),
                idempotencyKey: stringField(body, "idempotencyKey"),
                itemId: stringField(body, "itemId"),
                sessionId: replacementSessionId,
              });
              writeCors(response, origin!);
              sendJson(response, 200, { result });
              return;
            }
          }
        }
      } catch (error) {
        if (error instanceof AssessmentError) {
          if (
            error.code === "authorization_denied" ||
            error.code === "question_unavailable"
          ) {
            sendJson(response, 404, { error: "assessment_not_found" });
            return;
          }
          if (
            error.code === "conflicting_duplicate" ||
            error.code === "grading_in_progress"
          ) {
            sendJson(response, 409, { error: error.code });
            return;
          }
          if (
            error.code === "fallback_unavailable" ||
            error.code === "invalid_configuration" ||
            error.code === "invalid_input"
          ) {
            sendJson(response, 400, { error: error.code });
            return;
          }
          sendJson(response, 503, { error: "assessment_unavailable" });
          return;
        }
        if (error instanceof DeliveryError) {
          sendJson(response, deliveryErrorStatus(error), {
            error: error.code,
          });
          return;
        }
        if (error instanceof TutorAgentError) {
          if (
            error.code === "authorization_denied" ||
            error.code === "invalid_session"
          ) {
            sendJson(response, 404, { error: "study_session_not_found" });
            return;
          }
          if (
            error.code === "invalid_configuration" ||
            error.code === "retest_unavailable"
          ) {
            sendJson(response, 400, { error: error.code });
            return;
          }
          sendJson(response, 503, { error: "tutor_unavailable" });
          return;
        }
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

function currentTime(dependencies: ApiDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: object,
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
  const raw = await readRawBody(request);
  try {
    const value: unknown = JSON.parse(raw);
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

async function readRawBody(request: IncomingMessage): Promise<string> {
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
  return Buffer.concat(chunks).toString("utf8");
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") {
    throw new JsonBodyError();
  }
  return value;
}

function deliveryProvider(
  body: Record<string, unknown>,
  name: string,
): DemoDeliveryProvider {
  const value = stringField(body, name);
  if (value !== "email" && value !== "telegram") {
    throw new JsonBodyError();
  }
  return value;
}

function answerFields(
  body: Record<string, unknown>,
  name: string,
): readonly { readonly answer: string; readonly deliveryItemId: string }[] {
  const value = body[name];
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    value.some(
      (answer) =>
        answer === null ||
        typeof answer !== "object" ||
        Array.isArray(answer) ||
        typeof (answer as Record<string, unknown>).answer !== "string" ||
        typeof (answer as Record<string, unknown>).deliveryItemId !== "string",
    )
  ) {
    throw new JsonBodyError();
  }
  return value as {
    readonly answer: string;
    readonly deliveryItemId: string;
  }[];
}

function deliveryAuthorization(account: {
  readonly ownerScopeId: string;
  readonly sessionId: string;
  readonly userId: string;
}) {
  return {
    actorId: account.userId,
    authorizationId: account.sessionId,
    ownerScopeId: account.ownerScopeId,
  };
}

function deliveryErrorStatus(error: DeliveryError): number {
  switch (error.code) {
    case "invalid_signature":
      return 401;
    case "authorization_denied":
    case "not_found":
      return 404;
    case "delivery_expired":
    case "link_redeemed":
      return 410;
    case "conflicting_duplicate":
    case "invalid_input":
      return 400;
    case "dispatch_ambiguous":
    case "dispatch_failed":
    case "invalid_configuration":
      return 503;
  }
}

function studySessionRoute(
  pathname: string,
  action:
    | "answers/replacement"
    | "answers/short-answer"
    | "ask"
    | "next"
    | "state"
    | "summary",
): string | null {
  const match = new RegExp(
    `^/v1/study-sessions/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/${action}$`,
    "i",
  ).exec(pathname);
  return match?.[1] ?? null;
}

function courseProgressRoute(pathname: string): string | null {
  const match =
    /^\/v1\/courses\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/progress$/i.exec(
      pathname,
    );
  return match?.[1] ?? null;
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
