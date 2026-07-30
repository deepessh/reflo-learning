import {
  assertSafeDemoOperationalTrace,
  type DemoOperationalTrace,
  type DemoOperationalTraceSink,
} from "../contracts.js";

const PREFIX = "reflo.demo-operational-trace ";

export function createStructuredLogOperationalTraceSink(
  write: (line: string) => void = console.info,
): DemoOperationalTraceSink {
  return Object.freeze({
    record(trace: DemoOperationalTrace): void {
      const safe = assertSafeDemoOperationalTrace(trace);
      write(`${PREFIX}${JSON.stringify(safe)}`);
    },
  });
}
