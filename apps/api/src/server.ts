import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";

import {
  AccountInputError,
  type AccountService,
  RecentAuthenticationRequiredError,
} from "@reflo/accounts";
import {
  AssessmentError,
  type AssessmentFinalizationView,
} from "@reflo/assessment";
import { ActivationGenerationError } from "@reflo/activation";
import type { ServerEnvironment } from "@reflo/config";
import {
  type ConnectedDemoPreflightView,
  type DemoCourseOutline,
  type DemoSourceApproval,
  type DemoUploadMediaType,
  type DemoUploadView,
  HEALTH_CONTRACT_VERSION,
  type ConnectedStudyView,
  type HealthResponse,
} from "@reflo/contracts";
import {
  DeliveryError,
  type DeliveryPreferenceSettings,
  type DemoDeliveryService,
  type DemoDeliveryProvider,
} from "@reflo/delivery";
import { TutorAgentError, type TutorAgentService } from "@reflo/tutor-agent";
import {
  LOCAL_BRIDGE_HTTP,
  LOCAL_INGESTION_BRIDGE_VERSION,
} from "@reflo/ingestion";
import type {
  ConnectedActivationProgress,
  ConnectedPlacementChoiceRequest,
  ConnectedPlacementState,
} from "@reflo/db";

import { DemoUploadAccessError } from "./demo-upload.js";
import {
  type LocalIngestionBridgeApi,
  LocalIngestionBridgeError,
  localBridgeOutputMetadataFromHeaders,
} from "./local-ingestion-bridge.js";
import type { ActivationPackageScheduler } from "./activation-package-processing.js";
import type {
  LocalPrivateAssetDelivery,
  LocalPrivateAssetRead,
} from "./local-private-assets.js";

const SESSION_COOKIE = "__Host-reflo_session";
const CSRF_COOKIE = "__Host-reflo_csrf";
const MAX_DEMO_UPLOAD_BYTES = 50 * 1024 * 1024;

type ScopeAuthorization = ReturnType<typeof deliveryAuthorization>;

export interface ApiDependencies {
  readonly accounts?: AccountService;
  readonly activation?: ActivationPackageScheduler;
  readonly activationStream?: {
    readonly heartbeatIntervalMs?: number;
    readonly maxConnectionMs?: number;
    readonly pollIntervalMs?: number;
    readonly retryAfterMs?: number;
  };
  readonly delivery?: Pick<
    DemoDeliveryService,
    | "dispatch"
    | "getPreference"
    | "handleTelegramWebhook"
    | "previewEmail"
    | "submitEmail"
    | "updatePreference"
  >;
  readonly localAuthInbox?: {
    take(accessKey: string | undefined): {
      readonly expiresAt: string;
      readonly loginUrl: string;
    } | null;
  };
  readonly localIngestionBridge?: LocalIngestionBridgeApi;
  readonly now?: () => Date;
  readonly assessment?: {
    loadPendingFallback(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
    ): Promise<AssessmentFinalizationView | null>;
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
    check(
      deliveryAvailable: boolean,
      capability?: "all" | "delivery" | "library" | "study",
    ): Promise<ConnectedDemoPreflightView>;
  };
  readonly privateAssets?: Pick<
    LocalPrivateAssetDelivery,
    "authorize" | "read"
  >;
  readonly demoUploads?: {
    create(
      authorization: ScopeAuthorization,
      input: {
        readonly approvalId: string;
        readonly bytes: Uint8Array;
        readonly mediaType: DemoUploadMediaType;
        readonly replacesUploadId?: string;
      },
    ): Promise<DemoUploadView>;
    get(
      authorization: ScopeAuthorization,
      uploadId: string,
    ): Promise<DemoUploadView | null>;
    listApprovals(
      authorization: ScopeAuthorization,
    ): Promise<readonly DemoSourceApproval[]>;
    loadOutline(
      authorization: ScopeAuthorization,
      uploadId: string,
    ): Promise<DemoCourseOutline | null>;
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
    completeLesson?(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
      completion: {
        readonly assetId: string;
        readonly conceptId: string;
        readonly idempotencyKey: string;
      },
    ): Promise<boolean>;
    loadSummary(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
    ): Promise<{
      readonly courseId: string;
      readonly sessionId: string;
      readonly status: "active" | "completed" | "abandoned";
      readonly summary: Readonly<Record<string, unknown>> | null;
    } | null>;
    loadActivationProgress?(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
    ): Promise<ConnectedActivationProgress | null>;
    loadPlacement?(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
    ): Promise<ConnectedPlacementState | null>;
    regenerateLesson?(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
      courseId: string,
      requestIdempotencyKey: string,
    ): Promise<{
      readonly operation: {
        readonly attemptCount: number;
        readonly id: string;
        readonly regenerationOrdinal: number;
        readonly status: string;
      };
      readonly replayed: boolean;
    }>;
    regenerateAssessment?(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
      courseId: string,
      artifactKind: "chapter_quiz" | "placement_quiz",
      requestIdempotencyKey: string,
    ): Promise<{
      readonly operation: {
        readonly attemptCount: number;
        readonly id: string;
        readonly regenerationOrdinal: number;
        readonly status: string;
      };
      readonly replayed: boolean;
    }>;
    startOrResume?(
      authorization: ReturnType<typeof deliveryAuthorization>,
      courseId: string,
    ): Promise<{
      readonly courseId: string;
      readonly plan: Readonly<Record<string, unknown>>;
      readonly resumed: boolean;
      readonly sessionId: string;
      readonly status: "active";
    } | null>;
    submitPlacementChoice?(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
      request: ConnectedPlacementChoiceRequest,
    ): Promise<{
      readonly correct: boolean;
      readonly status: "created" | "replayed";
    }>;
  };
  readonly study?: {
    load(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
    ): Promise<ConnectedStudyView | null>;
    loadLesson?(
      authorization: ReturnType<typeof deliveryAuthorization>,
      sessionId: string,
    ): Promise<Readonly<Record<string, unknown>> | null>;
  };
  readonly tutorAgent?: Pick<TutorAgentService, "ask" | "nextAction">;
}

export function createApiServer(
  environment: ServerEnvironment,
  dependencies: ApiDependencies = {},
): Server {
  return createServer(createApiRequestListener(environment, dependencies));
}

export function createApiRequestListener(
  environment: ServerEnvironment,
  dependencies: ApiDependencies = {},
): RequestListener {
  return async (request, response) => {
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

    if (request.url?.startsWith("/internal/v1/local-ingestion/")) {
      await handleLocalIngestionBridgeRequest(
        request,
        response,
        dependencies.localIngestionBridge,
      );
      return;
    }

    const unauthenticatedUrl = new URL(
      request.url ?? "/",
      "http://api.invalid",
    );
    const privateAssetId = privateAssetRoute(unauthenticatedUrl.pathname);
    if (request.method === "GET" && privateAssetId !== null) {
      const privateAssets = dependencies.privateAssets;
      if (privateAssets === undefined) {
        sendPrivateAssetNotFound(response);
        return;
      }
      const asset = await privateAssets.read(
        privateAssetId,
        unauthenticatedUrl.searchParams.get("auth_key"),
        singleHeader(request.headers.range),
      );
      if (asset === null) {
        sendPrivateAssetNotFound(response);
        return;
      }
      sendPrivateAsset(response, asset);
      return;
    }
    if (
      request.method === "GET" &&
      (unauthenticatedUrl.pathname === "/v1/preflight" ||
        unauthenticatedUrl.pathname === "/v1/demo/preflight")
    ) {
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
      const capability = preflightCapability(
        unauthenticatedUrl.searchParams.get("capability"),
      );
      if (capability === null) {
        sendJson(response, 400, { error: "invalid_preflight_capability" });
        return;
      }
      const result = await preflight.check(
        dependencies.delivery !== undefined,
        capability,
      );
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
          "access-control-allow-headers":
            "content-type, idempotency-key, x-reflo-csrf, x-reflo-demo-source-approval, x-reflo-demo-upload-retry-of",
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
            url.pathname === "/v1/demo/uploads/approvals"
          ) {
            const demoUploads = dependencies.demoUploads;
            if (demoUploads === undefined) {
              sendJson(response, 503, { error: "demo_upload_unavailable" });
              return;
            }
            sendJson(response, 200, {
              approvals: await demoUploads.listApprovals(
                deliveryAuthorization(account),
              ),
            });
            return;
          }
          const uploadStatusId = demoUploadRoute(url.pathname);
          if (request.method === "GET" && uploadStatusId !== null) {
            const demoUploads = dependencies.demoUploads;
            if (demoUploads === undefined) {
              sendJson(response, 503, { error: "demo_upload_unavailable" });
              return;
            }
            const upload = await demoUploads.get(
              deliveryAuthorization(account),
              uploadStatusId,
            );
            if (upload === null) {
              sendJson(response, 404, { error: "demo_upload_not_found" });
              return;
            }
            sendJson(response, 200, { upload });
            return;
          }
          const uploadOutlineId = demoUploadOutlineRoute(url.pathname);
          if (request.method === "GET" && uploadOutlineId !== null) {
            const demoUploads = dependencies.demoUploads;
            if (demoUploads === undefined) {
              sendJson(response, 503, { error: "demo_upload_unavailable" });
              return;
            }
            const outline = await demoUploads.loadOutline(
              deliveryAuthorization(account),
              uploadOutlineId,
            );
            if (outline === null) {
              sendJson(response, 404, { error: "demo_outline_not_found" });
              return;
            }
            sendJson(response, 200, { outline });
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
            (url.pathname === "/v1/email-quiz" ||
              url.pathname === "/v1/demo/email-quiz")
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
          if (
            request.method === "GET" &&
            url.pathname === "/v1/delivery-preference"
          ) {
            const delivery = dependencies.delivery;
            if (delivery === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            sendJson(response, 200, {
              preference: await delivery.getPreference(
                deliveryAuthorization(account),
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
          const placementSessionId = studySessionRoute(
            url.pathname,
            "placement",
          );
          if (request.method === "GET" && placementSessionId !== null) {
            const loadPlacement = dependencies.sessions?.loadPlacement;
            if (loadPlacement === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            const placement = await loadPlacement(
              deliveryAuthorization(account),
              placementSessionId,
            );
            if (placement === null) {
              sendJson(response, 404, { error: "study_session_not_found" });
              return;
            }
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, { placement });
            return;
          }
          const activationEventsSessionId = studySessionRoute(
            url.pathname,
            "activation/events",
          );
          if (request.method === "GET" && activationEventsSessionId !== null) {
            // EventSource is credentialed and the web application is served on
            // a different loopback port. Keep the stream under the same
            // trusted-origin contract as the other authenticated reads.
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            const loadActivationProgress =
              dependencies.sessions?.loadActivationProgress;
            if (loadActivationProgress === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            const authorization = deliveryAuthorization(account);
            const initial = await loadActivationProgress(
              authorization,
              activationEventsSessionId,
            );
            if (initial === null) {
              sendJson(response, 404, { error: "study_session_not_found" });
              return;
            }
            await streamActivationProgress(
              request,
              response,
              initial,
              () =>
                loadActivationProgress(
                  authorization,
                  activationEventsSessionId,
                ),
              dependencies.activationStream,
            );
            return;
          }
          const stateSessionId = studySessionRoute(url.pathname, "state");
          const pendingAssessmentSessionId = studySessionRoute(
            url.pathname,
            "assessments/pending-fallback",
          );
          if (request.method === "GET" && pendingAssessmentSessionId !== null) {
            const assessment = dependencies.assessment;
            if (assessment === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, {
              result: await assessment.loadPendingFallback(
                deliveryAuthorization(account),
                pendingAssessmentSessionId,
              ),
            });
            return;
          }
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
          const lessonSessionId = studySessionRoute(url.pathname, "lesson");
          if (request.method === "GET" && lessonSessionId !== null) {
            const study = dependencies.study;
            if (study === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            if (study.loadLesson === undefined) {
              sendJson(response, 503, { error: "service_unavailable" });
              return;
            }
            let lesson = await study.loadLesson(
              deliveryAuthorization(account),
              lessonSessionId,
            );
            if (lesson === null) {
              sendJson(response, 404, { error: "study_lesson_not_found" });
              return;
            }
            lesson = await attachPrivateLessonDelivery(
              lesson,
              dependencies.privateAssets,
              deliveryAuthorization(account),
              localRequestOrigin(request),
            );
            if (origin !== undefined && accounts.isTrustedOrigin(origin)) {
              writeCors(response, origin);
            }
            sendJson(response, 200, { lesson });
            return;
          }
          const deliveryAssetId = privateAssetDeliveryRoute(url.pathname);
          if (request.method === "GET" && deliveryAssetId !== null) {
            const privateAssets = dependencies.privateAssets;
            const publicOrigin = localRequestOrigin(request);
            if (privateAssets === undefined || publicOrigin === null) {
              sendJson(response, 404, { error: "asset_not_found" });
              return;
            }
            const delivery = await privateAssets.authorize(
              deliveryAuthorization(account),
              deliveryAssetId,
              publicOrigin,
            );
            if (delivery === null) {
              sendJson(response, 404, { error: "asset_not_found" });
              return;
            }
            sendJson(response, 200, { delivery });
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
            const archiveCourseId = courseArchiveRoute(url.pathname);
            if (archiveCourseId !== null) {
              const archived = await accounts.archiveCourse(
                account,
                archiveCourseId,
              );
              writeCors(response, origin!);
              if (!archived) {
                sendJson(response, 404, { error: "course_not_found" });
                return;
              }
              response.writeHead(204);
              response.end();
              return;
            }
            if (
              url.pathname === "/v1/deliveries/dispatch" ||
              url.pathname === "/v1/demo/deliveries/dispatch"
            ) {
              const delivery = dependencies.delivery;
              if (delivery === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const result = await delivery.dispatch({
                authorization: deliveryAuthorization(account),
                idempotencyKey: stringField(body, "idempotencyKey"),
                now: currentTime(dependencies),
              });
              writeCors(response, origin!);
              sendJson(response, 200, { result });
              return;
            }
            if (url.pathname === "/v1/delivery-preference") {
              const delivery = dependencies.delivery;
              if (delivery === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const preference: DeliveryPreferenceSettings = {
                chosenLocalTime: stringField(body, "chosenLocalTime"),
                provider: deliveryProvider(body, "provider"),
                timeZone: stringField(body, "timeZone"),
              };
              writeCors(response, origin!);
              sendJson(response, 200, {
                preference: await delivery.updatePreference(
                  deliveryAuthorization(account),
                  preference,
                ),
              });
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
            const studyCourseId = courseStudySessionRoute(url.pathname);
            if (studyCourseId !== null) {
              const sessions = dependencies.sessions;
              if (sessions?.startOrResume === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const session = await sessions.startOrResume(
                deliveryAuthorization(account),
                studyCourseId,
              );
              if (session === null) {
                sendJson(response, 404, { error: "course_not_found" });
                return;
              }
              if (session.plan.generationRequired === true) {
                dependencies.activation?.schedule({
                  authorization: deliveryAuthorization(account),
                  courseId: studyCourseId,
                });
              }
              writeCors(response, origin!);
              sendJson(response, session.resumed ? 200 : 201, { session });
              return;
            }
            const regenerationSessionId = studySessionRoute(
              url.pathname,
              "activation/regenerate",
            );
            if (regenerationSessionId !== null) {
              const regenerateLesson = dependencies.sessions?.regenerateLesson;
              if (regenerateLesson === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const requestKey = singleHeader(
                request.headers["idempotency-key"],
              );
              if (requestKey === undefined) throw new JsonBodyError();
              const body = await readJsonBody(request);
              const result = await regenerateLesson(
                deliveryAuthorization(account),
                regenerationSessionId,
                stringField(body, "courseId"),
                requestKey,
              );
              writeCors(response, origin!);
              sendJson(response, result.replayed ? 200 : 202, {
                regeneration: {
                  attemptCount: result.operation.attemptCount,
                  maxAttempts: 5,
                  operationId: result.operation.id,
                  regenerationOrdinal: result.operation.regenerationOrdinal,
                  replayed: result.replayed,
                  status: result.operation.status,
                },
              });
              return;
            }
            const assessmentRegeneration = assessmentRegenerationRoute(
              url.pathname,
            );
            if (assessmentRegeneration !== null) {
              const regenerateAssessment =
                dependencies.sessions?.regenerateAssessment;
              if (regenerateAssessment === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const requestKey = singleHeader(
                request.headers["idempotency-key"],
              );
              if (requestKey === undefined) throw new JsonBodyError();
              const body = await readJsonBody(request);
              const result = await regenerateAssessment(
                deliveryAuthorization(account),
                assessmentRegeneration.sessionId,
                stringField(body, "courseId"),
                assessmentRegeneration.artifactKind,
                requestKey,
              );
              writeCors(response, origin!);
              sendJson(response, result.replayed ? 200 : 202, {
                regeneration: {
                  artifactKind: assessmentRegeneration.artifactKind,
                  attemptCount: result.operation.attemptCount,
                  maxAttempts: 5,
                  operationId: result.operation.id,
                  regenerationOrdinal: result.operation.regenerationOrdinal,
                  replayed: result.replayed,
                  status: result.operation.status,
                },
              });
              return;
            }
            if (url.pathname === "/v1/demo/uploads") {
              const demoUploads = dependencies.demoUploads;
              if (demoUploads === undefined) {
                sendJson(response, 503, { error: "demo_upload_unavailable" });
                return;
              }
              const mediaType = demoUploadMediaType(
                singleHeader(request.headers["content-type"]),
              );
              const approvalId = demoSourceApproval(
                singleHeader(request.headers["x-reflo-demo-source-approval"]),
              );
              const replacesUploadId = optionalDemoUploadId(
                singleHeader(request.headers["x-reflo-demo-upload-retry-of"]),
              );
              if (
                request.headers["content-encoding"] !== undefined &&
                request.headers["content-encoding"] !== "identity"
              ) {
                throw new JsonBodyError();
              }
              const bytes = await readBinaryBody(
                request,
                MAX_DEMO_UPLOAD_BYTES,
              );
              const upload = await demoUploads.create(
                deliveryAuthorization(account),
                { approvalId, bytes, mediaType, replacesUploadId },
              );
              writeCors(response, origin!);
              sendJson(response, 202, { upload });
              return;
            }
            if (
              url.pathname === "/v1/email-quiz/submit" ||
              url.pathname === "/v1/demo/email-quiz/submit"
            ) {
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
            const lessonCompletionSessionId = studySessionRoute(
              url.pathname,
              "lesson/complete",
            );
            if (lessonCompletionSessionId !== null) {
              const sessions = dependencies.sessions;
              if (sessions?.completeLesson === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const completed = await sessions.completeLesson(
                deliveryAuthorization(account),
                lessonCompletionSessionId,
                {
                  assetId: stringField(body, "assetId"),
                  conceptId: stringField(body, "conceptId"),
                  idempotencyKey: stringField(body, "idempotencyKey"),
                },
              );
              if (!completed) {
                sendJson(response, 404, { error: "study_lesson_not_found" });
                return;
              }
              writeCors(response, origin!);
              sendJson(response, 200, { completed: true });
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
                deadlineMs: 90_000,
                idempotencyKey: stringField(body, "idempotencyKey"),
                questionId: stringField(body, "questionId"),
                sessionId: shortAnswerSessionId,
              });
              writeCors(response, origin!);
              sendJson(response, 200, { result });
              return;
            }
            const placementAnswerSessionId = studySessionRoute(
              url.pathname,
              "placement/answers",
            );
            if (placementAnswerSessionId !== null) {
              const submitPlacementChoice =
                dependencies.sessions?.submitPlacementChoice;
              if (submitPlacementChoice === undefined) {
                sendJson(response, 503, { error: "service_unavailable" });
                return;
              }
              const body = await readJsonBody(request);
              const result = await submitPlacementChoice(
                deliveryAuthorization(account),
                placementAnswerSessionId,
                {
                  answer: stringField(body, "answer"),
                  idempotencyKey: stringField(body, "idempotencyKey"),
                  questionId: stringField(body, "questionId"),
                },
              );
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
        if (error instanceof ActivationGenerationError) {
          if (error.code === "authorization_denied") {
            sendJson(response, 404, { error: "study_session_not_found" });
            return;
          }
          if (error.code === "regeneration_cooldown") {
            const retryAt = error.retryAt ?? new Date(Date.now() + 60_000);
            response.setHeader(
              "retry-after",
              Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1_000)),
            );
            sendJson(response, 429, {
              error: "regeneration_cooldown",
              retryAt: retryAt.toISOString(),
            });
            return;
          }
          if (
            error.code === "regeneration_not_allowed" ||
            error.code === "operation_unavailable"
          ) {
            sendJson(response, 409, { error: error.code });
            return;
          }
          sendJson(response, 400, { error: "invalid_regeneration_request" });
          return;
        }
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
          if (error.code === "projection_unavailable") {
            console.warn(
              JSON.stringify({
                event: "assessment_submission_failed",
                failureClass: error.code,
                persisted: true,
                retryable: true,
              }),
            );
            sendJson(response, 503, {
              error: "assessment_projection_unavailable",
              persisted: true,
              retryable: true,
            });
            return;
          }
          if (error.code === "grading_unavailable") {
            console.warn(
              JSON.stringify({
                event: "assessment_submission_failed",
                failureClass: error.code,
                persisted: false,
                retryable: true,
              }),
            );
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
          if (error.code === "retest_unavailable") {
            sendJson(response, 409, { error: error.code });
            return;
          }
          sendJson(response, 503, {
            cause: error.code,
            error: "tutor_dependency_unavailable",
          });
          return;
        }
        if (error instanceof RecentAuthenticationRequiredError) {
          sendJson(response, 403, { error: error.message });
          return;
        }
        if (error instanceof DemoUploadAccessError) {
          sendJson(response, 404, { error: "demo_upload_not_found" });
          return;
        }
        if (error instanceof RequestBodyTooLargeError) {
          sendJson(response, 413, { error: "upload_too_large" });
          return;
        }
        if (error instanceof DemoUploadFormatError) {
          sendJson(response, 415, {
            detail: "Uploads accept only an approved digitally generated PDF.",
            error: "unsupported_demo_upload_format",
            supportedMediaType: "application/pdf",
          });
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
  };
}

async function handleLocalIngestionBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bridge: LocalIngestionBridgeApi | undefined,
): Promise<void> {
  if (bridge === undefined) {
    request.resume();
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  if (!bridge.authorize(singleHeader(request.headers.authorization))) {
    request.resume();
    sendJson(response, 401, { error: "authentication_required" });
    return;
  }
  const url = new URL(request.url ?? "", "http://api.invalid");
  try {
    if (
      request.method === "POST" &&
      url.pathname === LOCAL_BRIDGE_HTTP.heartbeatPath
    ) {
      bridge.heartbeat(await readJsonBody(request));
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === LOCAL_BRIDGE_HTTP.leasePath
    ) {
      request.resume();
      const lease = await bridge.lease();
      if (lease === null) {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } else {
        sendInternalJson(response, 200, lease);
      }
      return;
    }
    const route = localIngestionLeaseRoute(url.pathname);
    if (
      route !== null &&
      request.method === "GET" &&
      route.action === "input"
    ) {
      request.resume();
      const input = bridge.input(route.leaseId);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": input.byteLength,
        "content-type": "application/pdf",
        [LOCAL_BRIDGE_HTTP.contractHeader]: LOCAL_INGESTION_BRIDGE_VERSION,
        [LOCAL_BRIDGE_HTTP.inputSha256Header]: input.inputSha256,
      });
      await pipeline(input.stream, response);
      return;
    }
    if (
      route !== null &&
      request.method === "PUT" &&
      route.action === "output"
    ) {
      if (
        singleHeader(request.headers[LOCAL_BRIDGE_HTTP.contractHeader]) !==
          LOCAL_INGESTION_BRIDGE_VERSION ||
        singleHeader(request.headers["content-type"]) !== "application/json"
      ) {
        request.resume();
        throw new LocalIngestionBridgeError("output_invalid");
      }
      const metadata = localBridgeOutputMetadataFromHeaders(route.leaseId, {
        contentLength: singleHeader(request.headers["content-length"]),
        sha256: singleHeader(
          request.headers[LOCAL_BRIDGE_HTTP.outputSha256Header],
        ),
      });
      await bridge.stageOutput(route.leaseId, request, metadata);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (
      route !== null &&
      request.method === "POST" &&
      route.action === "complete"
    ) {
      await bridge.complete(route.leaseId, await readJsonBody(request));
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    request.resume();
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    request.resume();
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, { error: "request_too_large" });
      return;
    }
    if (error instanceof LocalIngestionBridgeError) {
      const unavailable =
        error.code === "bridge_closed" || error.code === "heartbeat_stale";
      sendJson(
        response,
        unavailable ? 503 : error.code === "lease_not_current" ? 409 : 400,
        {
          error: unavailable ? "service_unavailable" : error.code,
        },
      );
      return;
    }
    if (error instanceof JsonBodyError) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    sendJson(response, 503, { error: "service_unavailable" });
  }
}

const ACTIVATION_STREAM_DEFAULTS = {
  heartbeatIntervalMs: 15_000,
  maxConnectionMs: 120_000,
  pollIntervalMs: 1_000,
  retryAfterMs: 2_000,
} as const;

interface ActivationStreamPolicy {
  readonly heartbeatIntervalMs: number;
  readonly maxConnectionMs: number;
  readonly pollIntervalMs: number;
  readonly retryAfterMs: number;
}

async function streamActivationProgress(
  request: IncomingMessage,
  response: ServerResponse,
  initial: ConnectedActivationProgress,
  load: () => Promise<ConnectedActivationProgress | null>,
  options: ApiDependencies["activationStream"],
): Promise<void> {
  const policy = activationStreamPolicy(options);
  const disconnected = new AbortController();
  const disconnect = () => disconnected.abort();
  request.once("aborted", disconnect);
  response.once("close", disconnect);
  response.writeHead(200, {
    "cache-control": "no-cache, no-store, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();

  try {
    if (
      !(await writeEventStreamChunk(
        response,
        `retry: ${policy.retryAfterMs}\n\n`,
        disconnected.signal,
      )) ||
      !(await writeActivationEvent(
        response,
        "activation",
        initial,
        disconnected.signal,
      ))
    ) {
      return;
    }
    if (activationProgressIsTerminal(initial)) {
      response.end();
      return;
    }

    let previous = JSON.stringify(initial);
    const startedAt = Date.now();
    let nextHeartbeatAt = startedAt + policy.heartbeatIntervalMs;
    while (!disconnected.signal.aborted) {
      const elapsed = Date.now() - startedAt;
      const remaining = policy.maxConnectionMs - elapsed;
      if (remaining <= 0) {
        await writeActivationEvent(
          response,
          "reconnect",
          {
            contractVersion: "activation-progress-v1",
            retryAfterMs: policy.retryAfterMs,
          },
          disconnected.signal,
        );
        response.end();
        return;
      }
      await abortableDelay(
        Math.min(policy.pollIntervalMs, remaining),
        disconnected.signal,
      );
      if (disconnected.signal.aborted) {
        return;
      }

      const now = Date.now();
      if (now >= nextHeartbeatAt) {
        const written = await writeActivationEvent(
          response,
          "heartbeat",
          {
            contractVersion: "activation-progress-v1",
            observedAt: new Date(now).toISOString(),
          },
          disconnected.signal,
        );
        if (!written) return;
        nextHeartbeatAt = now + policy.heartbeatIntervalMs;
      }

      const snapshot = await load();
      if (snapshot === null) {
        await writeActivationEvent(
          response,
          "error",
          {
            code: "session_unavailable",
            contractVersion: "activation-progress-v1",
          },
          disconnected.signal,
        );
        response.end();
        return;
      }
      const serialized = JSON.stringify(snapshot);
      if (serialized !== previous) {
        const written = await writeActivationEvent(
          response,
          "activation",
          snapshot,
          disconnected.signal,
        );
        if (!written) return;
        previous = serialized;
      }
      if (activationProgressIsTerminal(snapshot)) {
        response.end();
        return;
      }
    }
  } catch {
    if (!disconnected.signal.aborted && !response.writableEnded) {
      await writeActivationEvent(
        response,
        "error",
        {
          code: "stream_unavailable",
          contractVersion: "activation-progress-v1",
        },
        disconnected.signal,
      ).catch(() => false);
      response.end();
    }
  } finally {
    request.off("aborted", disconnect);
    response.off("close", disconnect);
  }
}

function activationStreamPolicy(
  options: ApiDependencies["activationStream"],
): ActivationStreamPolicy {
  const policy = { ...ACTIVATION_STREAM_DEFAULTS, ...options };
  if (
    !boundedInteger(policy.pollIntervalMs, 5, 10_000) ||
    !boundedInteger(policy.heartbeatIntervalMs, 5, 60_000) ||
    !boundedInteger(policy.maxConnectionMs, 10, 10 * 60_000) ||
    !boundedInteger(policy.retryAfterMs, 250, 30_000)
  ) {
    throw new Error("activation event stream policy is invalid");
  }
  return policy;
}

function boundedInteger(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function activationProgressIsTerminal(
  snapshot: ConnectedActivationProgress,
): boolean {
  const activationTerminal =
    snapshot.activationStatus === "ready" ||
    snapshot.activationStatus === "failed";
  // Compatibility for callers created before assessment-level progress was
  // added. Repository snapshots always include this field.
  if (snapshot.assessmentArtifact === undefined) return activationTerminal;
  if (
    snapshot.assessmentArtifact?.status === "pending" ||
    snapshot.assessmentArtifact?.status === "retrying"
  ) {
    return false;
  }
  return (
    activationTerminal &&
    (snapshot.assessmentStatus === "ready" ||
      snapshot.assessmentStatus === "failed")
  );
}

async function writeActivationEvent(
  response: ServerResponse,
  event: "activation" | "error" | "heartbeat" | "reconnect",
  data: object,
  signal: AbortSignal,
): Promise<boolean> {
  return writeEventStreamChunk(
    response,
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    signal,
  );
}

async function writeEventStreamChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return false;
  }
  if (response.write(chunk)) {
    return true;
  }
  try {
    await once(response, "drain", { signal });
    return !signal.aborted && !response.destroyed && !response.writableEnded;
  } catch {
    return false;
  }
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function sendInternalJson(
  response: ServerResponse,
  status: number,
  body: object,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function localIngestionLeaseRoute(pathname: string): {
  readonly action: "complete" | "input" | "output";
  readonly leaseId: string;
} | null {
  const match =
    /^\/internal\/v1\/local-ingestion\/leases\/([a-f0-9]{48})\/(complete|input|output)$/.exec(
      pathname,
    );
  if (match === null) return null;
  return {
    action: match[2] as "complete" | "input" | "output",
    leaseId: match[1]!,
  };
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
  return Buffer.from(await readBinaryBody(request, 16_384)).toString("utf8");
}

async function readBinaryBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = singleHeader(request.headers["content-length"]);
  if (
    declaredLength !== undefined &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw new RequestBodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBytes) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (length < 1) {
    throw new JsonBodyError();
  }
  return Buffer.concat(chunks);
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

async function attachPrivateLessonDelivery(
  lesson: Readonly<Record<string, unknown>>,
  privateAssets: ApiDependencies["privateAssets"],
  authorization: ScopeAuthorization,
  publicOrigin: string | null,
): Promise<Readonly<Record<string, unknown>>> {
  const details = lesson.lesson;
  const media =
    typeof details === "object" && details !== null && "media" in details
      ? details.media
      : null;
  if (
    typeof details !== "object" ||
    details === null ||
    !("assetId" in details) ||
    typeof details.assetId !== "string" ||
    !("modality" in details) ||
    (details.modality !== "audio" && details.modality !== "video") ||
    typeof media !== "object" ||
    media === null ||
    !("status" in media) ||
    media.status !== "ready"
  ) {
    return lesson;
  }
  const delivery =
    privateAssets === undefined || publicOrigin === null
      ? null
      : await privateAssets
          .authorize(authorization, details.assetId, publicOrigin)
          .catch(() => null);
  return {
    ...lesson,
    lesson: {
      ...details,
      media: {
        delivery,
        status: delivery === null ? "unavailable" : "ready",
      },
    },
  };
}

function localRequestOrigin(request: IncomingMessage): string | null {
  const host = singleHeader(request.headers.host);
  if (
    host === undefined ||
    !/^(?:127\.0\.0\.1|localhost)(?::[1-9][0-9]{0,4})?$/.test(host)
  ) {
    return null;
  }
  return `http://${host}`;
}

function sendPrivateAsset(
  response: ServerResponse,
  asset: LocalPrivateAssetRead,
): void {
  response.writeHead(asset.status, {
    "accept-ranges": "bytes",
    "cache-control": "private, no-store, max-age=0",
    "content-length": String(asset.bytes.byteLength),
    ...(asset.contentRange === null
      ? {}
      : { "content-range": asset.contentRange }),
    "content-type": asset.contentType,
    etag: asset.etag,
  });
  response.end(asset.bytes);
}

function sendPrivateAssetNotFound(response: ServerResponse): void {
  response.writeHead(404, {
    "cache-control": "private, no-store, max-age=0",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: "asset_not_found" }));
}

function privateAssetRoute(pathname: string): string | null {
  const match =
    /^\/v1\/private-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      pathname,
    );
  return match?.[1] ?? null;
}

function privateAssetDeliveryRoute(pathname: string): string | null {
  const match =
    /^\/v1\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/delivery$/i.exec(
      pathname,
    );
  return match?.[1] ?? null;
}

function studySessionRoute(
  pathname: string,
  action:
    | "answers/replacement"
    | "answers/short-answer"
    | "activation/events"
    | "activation/regenerate"
    | "ask"
    | "assessments/pending-fallback"
    | "lesson"
    | "lesson/complete"
    | "next"
    | "placement"
    | "placement/answers"
    | "state"
    | "summary",
): string | null {
  const match = new RegExp(
    `^/v1/study-sessions/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/${action}$`,
    "i",
  ).exec(pathname);
  return match?.[1] ?? null;
}

function courseStudySessionRoute(pathname: string): string | null {
  const match =
    /^\/v1\/courses\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/study-sessions$/i.exec(
      pathname,
    );
  return match?.[1] ?? null;
}

function assessmentRegenerationRoute(pathname: string): {
  readonly artifactKind: "chapter_quiz" | "placement_quiz";
  readonly sessionId: string;
} | null {
  const match =
    /^\/v1\/study-sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/assessments\/(chapter_quiz|placement_quiz)\/regenerate$/i.exec(
      pathname,
    );
  const sessionId = match?.[1];
  const artifactKind = match?.[2];
  return sessionId === undefined ||
    (artifactKind !== "chapter_quiz" && artifactKind !== "placement_quiz")
    ? null
    : { artifactKind, sessionId };
}

function preflightCapability(
  value: string | null,
): "all" | "delivery" | "library" | "study" | null {
  if (value === null || value === "all") {
    return "all";
  }
  if (value === "delivery" || value === "library" || value === "study") {
    return value;
  }
  return null;
}

function courseProgressRoute(pathname: string): string | null {
  const match =
    /^\/v1\/courses\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/progress$/i.exec(
      pathname,
    );
  return match?.[1] ?? null;
}

function courseArchiveRoute(pathname: string): string | null {
  const match =
    /^\/v1\/courses\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/archive$/i.exec(
      pathname,
    );
  return match?.[1] ?? null;
}

function demoUploadRoute(pathname: string): string | null {
  const match =
    /^\/v1\/demo\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      pathname,
    );
  return match?.[1] ?? null;
}

function demoUploadOutlineRoute(pathname: string): string | null {
  const match =
    /^\/v1\/demo\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/outline$/i.exec(
      pathname,
    );
  return match?.[1] ?? null;
}

function demoUploadMediaType(value: string | undefined): DemoUploadMediaType {
  if (value !== "application/pdf") {
    throw new DemoUploadFormatError();
  }
  return value;
}

function demoSourceApproval(value: string | undefined): string {
  if (value === undefined || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(value)) {
    throw new JsonBodyError();
  }
  return value;
}

function optionalDemoUploadId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
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
class DemoUploadFormatError extends Error {}
class RequestBodyTooLargeError extends Error {}
