import { chmod, writeFile } from "node:fs/promises";

const endpoint = required("ACTIONS_ID_TOKEN_REQUEST_URL");
const bearer = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
const audience = required("REFLO_ALIBABA_OIDC_AUDIENCE");
const output = required("REFLO_OIDC_TOKEN_FILE");

const url = new URL(endpoint);
url.searchParams.set("audience", audience);
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${bearer}` },
});
if (!response.ok) {
  throw new Error(`GitHub OIDC request failed (${response.status})`);
}
const payload = await response.json();
if (
  typeof payload !== "object" ||
  payload === null ||
  typeof payload.value !== "string" ||
  payload.value.split(".").length !== 3
) {
  throw new Error("GitHub OIDC response did not contain a JWT");
}
await writeFile(output, payload.value, { encoding: "utf8", mode: 0o600 });
await chmod(output, 0o600);
console.info("Wrote the short-lived GitHub OIDC token to the protected runner");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
