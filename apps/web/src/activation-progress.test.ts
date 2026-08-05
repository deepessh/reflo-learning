import { describe, expect, it, vi } from "vitest";

import {
  activationConnectionText,
  activationProgressText,
  createActivationProgressController,
  parseActivationProgressEvent,
  type ActivationProgressConnection,
} from "./activation-progress";

function event(status: "pending" | "retrying" | "ready" | "failed") {
  return JSON.stringify({
    activationStatus: status,
    artifact: status === "ready" ? "first_text_lesson" : null,
    assessmentStatus: status === "ready" ? "ready" : "pending",
    attemptCount: status === "retrying" ? 2 : 1,
    contractVersion: "activation-progress-v1",
    failure:
      status === "failed"
        ? {
            code: "generation_timed_out",
            message: "Lesson generation timed out.",
          }
        : null,
    maxAttempts: 5,
    nextAction:
      status === "ready"
        ? "open_lesson"
        : status === "failed"
          ? "activation_failed"
          : "wait",
    stage:
      status === "retrying"
        ? "retry_scheduled"
        : status === "ready" || status === "failed"
          ? status
          : "generating",
    updatedAt: "2026-08-01T07:00:00.000Z",
  });
}

interface ScheduledTask {
  readonly callback: () => void;
  cancelled: boolean;
  readonly delay: number;
  readonly handle: number;
}

function scheduler() {
  let nextHandle = 1;
  const tasks: ScheduledTask[] = [];
  return {
    cancel(handle: number) {
      const task = tasks.find((candidate) => candidate.handle === handle);
      if (task !== undefined) task.cancelled = true;
    },
    run(delay: number) {
      const task = tasks.find(
        (candidate) => !candidate.cancelled && candidate.delay === delay,
      );
      if (task === undefined) {
        throw new Error(`No active ${delay}ms task`);
      }
      task.cancelled = true;
      task.callback();
    },
    schedule(callback: () => void, delay: number) {
      const handle = nextHandle++;
      tasks.push({ callback, cancelled: false, delay, handle });
      return handle;
    },
    tasks,
  };
}

function fakeSource() {
  const listeners = new Map<string, (event: MessageEvent<string>) => void>();
  const source = {
    addEventListener: vi.fn(
      (type: string, listener: (event: MessageEvent<string>) => void) =>
        listeners.set(type, listener),
    ),
    close: vi.fn(),
    onerror: null as (() => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onopen: null as (() => void) | null,
  };
  return {
    activation(status: "pending" | "retrying" | "ready" | "failed") {
      listeners.get("activation")?.({
        data: event(status),
      } as MessageEvent<string>);
    },
    reconnect() {
      listeners.get("reconnect")?.({ data: "{}" } as MessageEvent<string>);
    },
    source,
  };
}

function harness(
  overrides: Partial<
    Parameters<typeof createActivationProgressController>[0]
  > = {},
) {
  const clock = scheduler();
  const sources: ReturnType<typeof fakeSource>[] = [];
  const connections: ActivationProgressConnection[] = [];
  const onEvent = vi.fn();
  const poll = vi.fn(async () => "continue" as const);
  const controller = createActivationProgressController({
    cancel: (handle) => clock.cancel(handle),
    connectionTimeoutMs: 8_000,
    createEventSource: () => {
      const source = fakeSource();
      sources.push(source);
      return source.source;
    },
    isVisible: () => true,
    onConnectionChange: (state) => connections.push(state),
    onEvent,
    poll,
    schedule: (callback, delay) => clock.schedule(callback, delay),
    ...overrides,
  });
  return { clock, connections, controller, onEvent, poll, sources };
}

describe("activation progress", () => {
  it("cold-starts after mount and connects without a manual refresh", () => {
    const h = harness();
    expect(h.sources).toHaveLength(0);

    h.clock.run(0);
    expect(h.sources).toHaveLength(1);
    expect(h.connections).toEqual(["connecting"]);

    h.sources[0]!.source.onopen?.();
    h.sources[0]!.activation("pending");
    expect(h.connections).toEqual(["connecting", "live"]);
    expect(h.onEvent).toHaveBeenCalledOnce();
  });

  it("lets an immediate terminal event win over the server close race", () => {
    const h = harness();
    h.clock.run(0);

    h.sources[0]!.activation("failed");
    h.sources[0]!.source.onerror?.();

    expect(
      h.onEvent.mock.calls.map(([value]) => value.activationStatus),
    ).toEqual(["failed"]);
    expect(h.connections).toEqual(["connecting", "idle"]);
    expect(h.sources[0]!.source.close).toHaveBeenCalledOnce();
    expect(h.poll).not.toHaveBeenCalled();
  });

  it("retries when auth and session readiness settle after mount", () => {
    let ready = false;
    const created: ReturnType<typeof fakeSource>[] = [];
    const h = harness({
      createEventSource: () => {
        if (!ready) throw new Error("session not stable");
        const source = fakeSource();
        created.push(source);
        return source.source;
      },
    });
    h.clock.run(0);
    expect(created).toHaveLength(0);

    ready = true;
    h.clock.run(750);
    created[0]!.source.onopen?.();
    created[0]!.activation("pending");

    expect(h.connections).toEqual(["connecting", "live"]);
    expect(h.onEvent).toHaveBeenCalledOnce();
  });

  it("uses bounded reconnects before visible slow polling fallback", async () => {
    const h = harness({ maxReconnects: 1, pollIntervalMs: 10_000 });
    h.clock.run(0);
    h.sources[0]!.source.onerror?.();
    h.clock.run(750);
    h.sources[1]!.source.onerror?.();

    expect(h.connections).toEqual(["connecting", "offline"]);
    h.clock.run(10_000);
    await Promise.resolve();
    expect(h.poll).toHaveBeenCalledOnce();
  });

  it("times out a connection that produces no browser callbacks", () => {
    const h = harness({ maxReconnects: 0 });
    h.clock.run(0);
    h.clock.run(8_000);
    expect(h.sources[0]!.source.close).toHaveBeenCalledOnce();
    expect(h.connections).toEqual(["connecting", "offline"]);
  });

  it("cancels the discarded Strict Mode effect before opening a stream", () => {
    const first = harness();
    first.controller.stop();
    expect(first.sources).toHaveLength(0);
    expect(first.clock.tasks.filter((task) => !task.cancelled)).toHaveLength(0);

    const replay = harness();
    replay.clock.run(0);
    replay.sources[0]!.source.onopen?.();
    replay.sources[0]!.activation("pending");
    expect(replay.onEvent).toHaveBeenCalledOnce();
  });

  it("has the same terminal outcome on cold effect replay and refresh", () => {
    const discarded = harness();
    discarded.controller.stop();

    const coldReplay = harness();
    coldReplay.clock.run(0);
    coldReplay.sources[0]!.activation("failed");

    const refreshed = harness();
    refreshed.clock.run(0);
    refreshed.sources[0]!.source.onopen?.();
    refreshed.sources[0]!.activation("failed");

    expect(coldReplay.onEvent.mock.calls[0]?.[0]).toEqual(
      refreshed.onEvent.mock.calls[0]?.[0],
    );
    expect(coldReplay.connections.at(-1)).toBe("idle");
    expect(refreshed.connections.at(-1)).toBe("idle");
  });

  it("shows connection copy only while a controller is active", () => {
    expect(activationConnectionText("idle")).toBeNull();
    expect(activationConnectionText("connecting")).toBe(
      "Connecting to lesson updates…",
    );
    expect(activationConnectionText("live")).toContain("connected");
    expect(activationConnectionText("offline")).toContain("offline");
  });

  it("presents retry and failure language without internal detail", () => {
    const retrying = parseActivationProgressEvent(event("retrying"));
    const failed = parseActivationProgressEvent(event("failed"));
    expect(activationProgressText(retrying!)).toContain("Attempt 2 of 5");
    expect(activationProgressText(failed!)).toBe(
      "Lesson preparation has stopped.",
    );
  });
});
