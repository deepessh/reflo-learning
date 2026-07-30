import { describe, expect, it, vi } from "vitest";

import { emitRocketMqOperationalAlert } from "./rocketmq-alert.js";

describe("RocketMQ operational alerts", () => {
  it("emits only the bounded safe alert schema", () => {
    const write = vi.fn();
    emitRocketMqOperationalAlert(
      {
        ageSeconds: 42,
        component: "rocketmq-dlq-redrive",
        count: 2,
        failureClass: "publication_timeout",
        kind: "ambiguous_publication",
        privateEndpoint: "must-not-appear",
        providerPayload: { must: "not appear" },
      } as Parameters<typeof emitRocketMqOperationalAlert>[0],
      write,
    );

    expect(JSON.parse(write.mock.calls[0]?.[0] ?? "")).toEqual({
      ageSeconds: 42,
      component: "rocketmq-dlq-redrive",
      count: 2,
      event: "operational_alert",
      failureClass: "publication_timeout",
      kind: "ambiguous_publication",
      messagePolicy: "dev/media.audio.generate/v1",
      schemaVersion: "reflo-rocketmq-operational-alert-v1",
    });
    expect(write.mock.calls[0]?.[0]).not.toContain("must-not-appear");
  });

  it("rejects unbounded values and unknown failure classes", () => {
    expect(() =>
      emitRocketMqOperationalAlert({
        component: "outbox-relay",
        count: 1,
        failureClass: "raw-provider-diagnostic",
        kind: "publication_failure",
      }),
    ).toThrow("RocketMQ operational alert is invalid");
  });
});
