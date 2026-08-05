export type ActivationProgressStatus =
  "pending" | "retrying" | "ready" | "failed";

export interface ActivationProgressEvent {
  readonly activationStatus: ActivationProgressStatus;
  readonly artifact: "first_text_lesson" | null;
  readonly assessmentStatus: ActivationProgressStatus;
  readonly assessmentArtifact?: {
    readonly artifactKind: "chapter_quiz" | "placement_quiz";
    readonly attemptCount: number;
    readonly failure: ActivationProgressEvent["failure"];
    readonly maxAttempts: 5;
    readonly regenerationOrdinal: number;
    readonly stage: ActivationProgressEvent["stage"];
    readonly status: ActivationProgressStatus;
    readonly updatedAt: string;
  } | null;
  readonly attemptCount: number;
  readonly contractVersion: "activation-progress-v1";
  readonly failure: {
    readonly code:
      "generation_failed" | "generation_timed_out" | "generation_unavailable";
    readonly message: string;
  } | null;
  readonly maxAttempts: 5;
  readonly nextAction: "activation_failed" | "open_lesson" | "wait";
  readonly stage:
    | "awaiting_generation"
    | "failed"
    | "generating"
    | "ready"
    | "retry_scheduled";
  readonly updatedAt: string;
}

interface EventSourceLike {
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
  onerror: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null;
  onopen: ((event: Event) => unknown) | null;
}

export interface ActivationProgressController {
  stop(): void;
}

export type ActivationProgressConnection =
  "idle" | "connecting" | "live" | "offline";

export function activationConnectionText(
  connection: ActivationProgressConnection,
): string | null {
  if (connection === "idle") return null;
  if (connection === "live") {
    return "Updates are connected. You can leave this page and return later.";
  }
  if (connection === "connecting") {
    return "Connecting to lesson updates…";
  }
  return "Live updates are offline. Reflo will check occasionally while this tab is visible.";
}

export function parseActivationProgressEvent(
  data: string,
): ActivationProgressEvent | null {
  try {
    const value = JSON.parse(data) as Partial<ActivationProgressEvent>;
    if (
      value.contractVersion !== "activation-progress-v1" ||
      !["pending", "retrying", "ready", "failed"].includes(
        value.activationStatus ?? "",
      ) ||
      !["pending", "retrying", "ready", "failed"].includes(
        value.assessmentStatus ?? "",
      ) ||
      !Number.isSafeInteger(value.attemptCount) ||
      (value.attemptCount ?? -1) < 0 ||
      value.maxAttempts !== 5 ||
      !["wait", "open_lesson", "activation_failed"].includes(
        value.nextAction ?? "",
      ) ||
      ![
        "awaiting_generation",
        "generating",
        "retry_scheduled",
        "ready",
        "failed",
      ].includes(value.stage ?? "") ||
      typeof value.updatedAt !== "string" ||
      Number.isNaN(new Date(value.updatedAt).getTime())
    ) {
      return null;
    }
    if (value.assessmentArtifact !== undefined) {
      const assessment = value.assessmentArtifact;
      if (
        assessment !== null &&
        (!["chapter_quiz", "placement_quiz"].includes(
          assessment.artifactKind,
        ) ||
          !["pending", "retrying", "ready", "failed"].includes(
            assessment.status,
          ) ||
          !Number.isSafeInteger(assessment.attemptCount) ||
          assessment.attemptCount < 0 ||
          assessment.maxAttempts !== 5 ||
          !Number.isSafeInteger(assessment.regenerationOrdinal) ||
          assessment.regenerationOrdinal < 0 ||
          Number.isNaN(new Date(assessment.updatedAt).getTime()))
      ) {
        return null;
      }
    }
    return value as ActivationProgressEvent;
  } catch {
    return null;
  }
}

export function activationProgressText(event: ActivationProgressEvent): string {
  if (event.activationStatus === "retrying") {
    return `The first lesson needs another pass. Attempt ${event.attemptCount} of ${event.maxAttempts} is scheduled.`;
  }
  if (event.activationStatus === "ready") {
    return "Your first lesson is ready. Opening it now…";
  }
  if (event.activationStatus === "failed") {
    return "Lesson preparation has stopped.";
  }
  return event.attemptCount > 0
    ? `Preparing your first lesson · attempt ${event.attemptCount}`
    : "Preparing your first lesson…";
}

export function createActivationProgressController({
  connectionTimeoutMs = 8_000,
  createEventSource,
  initialDelayMs = 0,
  isVisible,
  maxReconnects = 3,
  maxPolls = 6,
  onConnectionChange,
  onEvent,
  poll,
  pollIntervalMs = 10_000,
  reconnectBaseMs = 750,
  schedule = (callback, delay) => window.setTimeout(callback, delay),
  cancel = (handle) => window.clearTimeout(handle),
}: {
  readonly cancel?: (handle: number) => void;
  readonly connectionTimeoutMs?: number;
  readonly createEventSource: () => EventSourceLike;
  readonly initialDelayMs?: number;
  readonly isVisible: () => boolean;
  readonly maxReconnects?: number;
  readonly maxPolls?: number;
  readonly onConnectionChange: (state: ActivationProgressConnection) => void;
  readonly onEvent: (event: ActivationProgressEvent) => void;
  readonly poll: () => Promise<"continue" | "stop">;
  readonly pollIntervalMs?: number;
  readonly reconnectBaseMs?: number;
  readonly schedule?: (callback: () => void, delay: number) => number;
}): ActivationProgressController {
  let connectionHandle: number | null = null;
  let connectionState: ActivationProgressConnection | null = null;
  let fallbackHandle: number | null = null;
  let reconnectHandle: number | null = null;
  let source: EventSourceLike | null = null;
  let sourceGeneration = 0;
  let live = false;
  let pollCount = 0;
  let reconnectCount = 0;
  let stopped = false;
  let terminal = false;

  function setConnection(state: ActivationProgressConnection) {
    if (connectionState === state) return;
    connectionState = state;
    onConnectionChange(state);
  }

  function clearConnectionTimeout() {
    if (connectionHandle !== null) {
      cancel(connectionHandle);
      connectionHandle = null;
    }
  }

  function clearFallback() {
    if (fallbackHandle !== null) {
      cancel(fallbackHandle);
      fallbackHandle = null;
    }
  }

  function clearReconnect() {
    if (reconnectHandle !== null) {
      cancel(reconnectHandle);
      reconnectHandle = null;
    }
  }

  function closeSource() {
    clearConnectionTimeout();
    const closing = source;
    source = null;
    sourceGeneration += 1;
    closing?.close();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    terminal = true;
    clearReconnect();
    clearFallback();
    closeSource();
  }

  function accept(message: MessageEvent<string>, generation: number) {
    const event = parseActivationProgressEvent(message.data);
    if (
      event === null ||
      stopped ||
      terminal ||
      generation !== sourceGeneration
    ) {
      return;
    }
    const activationTerminal =
      event.activationStatus === "ready" || event.activationStatus === "failed";
    const isTerminal =
      activationTerminal &&
      (event.assessmentArtifact === undefined ||
        ((event.assessmentStatus === "ready" ||
          event.assessmentStatus === "failed") &&
          event.assessmentArtifact?.status !== "pending" &&
          event.assessmentArtifact?.status !== "retrying"));
    // Mark terminal before notifying React. A server can send its terminal
    // snapshot and close in the same task; the following native error must not
    // overwrite that authoritative snapshot with an offline state.
    if (isTerminal) {
      terminal = true;
      live = false;
      setConnection("idle");
    } else if (!live) {
      live = true;
      setConnection("live");
      clearFallback();
    }
    onEvent(event);
    if (isTerminal) {
      clearReconnect();
      clearFallback();
      closeSource();
    }
  }

  function scheduleFallback() {
    if (stopped || live || fallbackHandle !== null || pollCount >= maxPolls)
      return;
    fallbackHandle = schedule(() => {
      fallbackHandle = null;
      if (stopped) return;
      if (!isVisible()) {
        scheduleFallback();
        return;
      }
      pollCount += 1;
      void poll()
        .then((result) => {
          if (result === "stop") stop();
          else scheduleFallback();
        })
        .catch(() => scheduleFallback());
    }, pollIntervalMs);
  }

  function moveOffline() {
    if (stopped || terminal) return;
    live = false;
    setConnection("offline");
    scheduleFallback();
  }

  function retryConnection(generation: number) {
    if (stopped || terminal || generation !== sourceGeneration) return;
    closeSource();
    live = false;
    if (reconnectCount >= maxReconnects) {
      moveOffline();
      return;
    }
    reconnectCount += 1;
    setConnection("connecting");
    reconnectHandle = schedule(
      () => {
        reconnectHandle = null;
        connect();
      },
      reconnectBaseMs * 2 ** (reconnectCount - 1),
    );
  }

  function connect() {
    if (stopped || terminal) return;
    if (!isVisible()) {
      moveOffline();
      return;
    }
    setConnection("connecting");
    let nextSource: EventSourceLike;
    try {
      nextSource = createEventSource();
    } catch {
      const failedGeneration = sourceGeneration;
      retryConnection(failedGeneration);
      return;
    }
    source = nextSource;
    sourceGeneration += 1;
    const generation = sourceGeneration;
    connectionHandle = schedule(() => {
      connectionHandle = null;
      retryConnection(generation);
    }, connectionTimeoutMs);
    const acceptCurrent = (event: MessageEvent<string>) =>
      accept(event, generation);
    nextSource.onopen = () => {
      if (stopped || terminal || generation !== sourceGeneration) return;
      clearConnectionTimeout();
      live = true;
      setConnection("live");
      clearFallback();
    };
    nextSource.onerror = () => retryConnection(generation);
    nextSource.onmessage = acceptCurrent;
    nextSource.addEventListener("activation", acceptCurrent);
    nextSource.addEventListener("reconnect", () => retryConnection(generation));
  }

  // Deferring even a zero-delay start is important during hydration: React's
  // development Strict Mode can mount, clean up, and mount an effect again.
  // The discarded effect is cancelled before it opens a credentialed stream.
  reconnectHandle = schedule(() => {
    reconnectHandle = null;
    connect();
  }, initialDelayMs);
  return { stop };
}
