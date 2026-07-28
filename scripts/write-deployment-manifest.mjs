import { writeFile } from "node:fs/promises";
import path from "node:path";

const [output, commit, apiSha256, jobsSha256, parserSha256] =
  process.argv.slice(2);
if (
  output === undefined ||
  !/^[0-9a-f]{40}$/.test(commit ?? "") ||
  [apiSha256, jobsSha256, parserSha256].some(
    (digest) => !/^[0-9a-f]{64}$/.test(digest ?? ""),
  )
) {
  throw new Error("deployment manifest inputs are invalid");
}
const root = path.resolve(".artifacts/deployment");
const destination = path.resolve(output);
if (path.dirname(destination) !== root) {
  throw new Error("deployment manifest must remain in .artifacts/deployment");
}
const manifest = {
  artifacts: {
    api: {
      key: `deployments/${apiSha256}/api.tar.gz`,
      sha256: apiSha256,
    },
    jobs: {
      key: `deployments/${jobsSha256}/jobs.zip`,
      sha256: jobsSha256,
    },
    parser: {
      key: `deployments/${parserSha256}/parser.tar`,
      sha256: parserSha256,
    },
  },
  commit,
  contractVersion: "reflo-dev-deployment-artifacts-v1",
};
await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
await writeFile(
  path.join(root, "deployment.tfvars.json"),
  `${JSON.stringify({ deployment_manifest: manifest }, null, 2)}\n`,
  { mode: 0o600 },
);
console.info(
  `Prepared immutable deployment manifest for commit ${commit.slice(0, 12)}`,
);
