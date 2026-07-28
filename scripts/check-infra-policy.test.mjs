import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkInfraPolicy } from "./check-infra-policy.mjs";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

test("repository infrastructure satisfies the issue #199 control-plane policy", () => {
  assert.deepEqual(checkInfraPolicy(root), []);
});

test("infrastructure policy rejects backend and provider drift", () => {
  withInfrastructureFixture((fixture) => {
    const versionsPath = path.join(
      fixture,
      "infra/environments/dev/versions.tf",
    );
    const altered = readFileSync(versionsPath, "utf8")
      .replace('version = "=1.283.0"', 'version = ">=1.283.0"')
      .replace("encrypt = true", "encrypt = false")
      .replace('prefix = "environments/dev"', 'prefix = "shared"');
    writeFileSync(versionsPath, altered);

    const errors = checkInfraPolicy(fixture).join("\n");
    assert.match(errors, /aliyun\/alicloud must be exactly =1\.283\.0/);
    assert.match(errors, /dev must use the private encrypted OSS backend/);
  });
});

test("infrastructure policy rejects excluded dev services, credentials, and public buckets", () => {
  withInfrastructureFixture((fixture) => {
    const devPath = path.join(fixture, "infra/environments/dev/main.tf");
    writeFileSync(
      devPath,
      `${readFileSync(devPath, "utf8")}
resource "alicloud_kms_secret" "forbidden" {}
resource "alicloud_log_project" "forbidden" {}
resource "alicloud_cr_ee_instance" "forbidden" {}
`,
    );

    const versionsPath = path.join(
      fixture,
      "infra/environments/dev/versions.tf",
    );
    writeFileSync(
      versionsPath,
      readFileSync(versionsPath, "utf8").replace(
        "region = var.region",
        'region = var.region\n  access_key = "committed-credential"',
      ),
    );

    const bucketPath = path.join(
      fixture,
      "infra/modules/private-oss-bucket/main.tf",
    );
    writeFileSync(
      bucketPath,
      readFileSync(bucketPath, "utf8")
        .replace('acl    = "private"', 'acl    = "public-read"')
        .replace("block_public_access = true", "block_public_access = false"),
    );

    const errors = checkInfraPolicy(fixture).join("\n");
    assert.match(errors, /credentials must come only from the protected OIDC/);
    assert.match(errors, /must not retain a KMS Secrets Manager dependency/);
    assert.match(errors, /must not provision SLS-specific observability/);
    assert.match(errors, /must not provision Alibaba Container Registry/);
    assert.match(errors, /private OSS module is missing required control/);
  });
});

function withInfrastructureFixture(run) {
  const fixture = mkdtempSync(path.join(tmpdir(), "reflo-infra-policy-"));
  try {
    cpSync(
      path.join(root, ".opentofu-version"),
      path.join(fixture, ".opentofu-version"),
    );
    cpSync(path.join(root, "infra"), path.join(fixture, "infra"), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.terraform${path.sep}`),
    });
    run(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
