import { healthcheck } from "./healthcheck";

console.info("Reflo jobs development worker ready", healthcheck());

const keepAlive = setInterval(() => undefined, 60_000);

function shutdown() {
  clearInterval(keepAlive);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
