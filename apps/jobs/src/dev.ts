import {
  developmentJobFailureMessage,
  runDevelopmentJob,
} from "./development-runner.js";
import { healthcheck } from "./healthcheck.js";

try {
  const execution = await runDevelopmentJob();
  console.info(
    execution.kind === "idle"
      ? "Reflo jobs development handler ready"
      : "Reflo jobs development handler completed",
    execution.kind === "idle" ? healthcheck() : execution.result,
  );
} catch (error) {
  console.error(developmentJobFailureMessage(error));
  process.exitCode = 1;
}
