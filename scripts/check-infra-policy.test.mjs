import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
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

test("infrastructure policy ignores generated deployment artifacts", () => {
  withInfrastructureFixture((fixture) => {
    mkdirSync(path.join(fixture, ".artifacts", "deployment"), {
      recursive: true,
    });
    writeFileSync(
      path.join(fixture, ".artifacts", "deployment", "deployment.tfvars.json"),
      "{}",
    );
    assert.deepEqual(checkInfraPolicy(fixture), []);
  });
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

test("infrastructure policy rejects mutable-name GitHub OIDC subjects", () => {
  withInfrastructureFixture((fixture) => {
    const mainPath = path.join(fixture, "infra/bootstrap/main.tf");
    writeFileSync(
      mainPath,
      readFileSync(mainPath, "utf8").replace(
        '"${var.github_oidc_subject_prefix}:environment:dev"',
        '"repo:${var.github_repository}:environment:dev"',
      ),
    );

    const errors = checkInfraPolicy(fixture).join("\n");
    assert.match(errors, /exact repository, protected dev environment/);
  });
});

test("infrastructure policy rejects parser host, network, trigger, and EventBridge drift", () => {
  withInfrastructureFixture((fixture) => {
    const runtimePath = path.join(
      fixture,
      "infra/modules/demo-runtime/main.tf",
    );
    writeFileSync(
      runtimePath,
      `${readFileSync(runtimePath, "utf8")}
resource "alicloud_instance" "parser_forbidden" {}
resource "alicloud_fcv3_trigger" "parser_forbidden" {}
resource "alicloud_event_bridge_event_bus" "parser_forbidden" {}
`,
    );

    const networkPath = path.join(fixture, "infra/modules/dev-network/main.tf");
    writeFileSync(
      networkPath,
      readFileSync(networkPath, "utf8").replace(
        "data        = var.subnets.data",
        "data        = var.subnets.data\n    parser      = var.subnets.data",
      ),
    );

    const errors = checkInfraPolicy(fixture).join("\n");
    assert.match(errors, /must not provision or depend on EventBridge/);
    assert.match(errors, /must not retain a parser ECS host/);
    assert.match(errors, /must not retain a parser VSwitch or security group/);
    assert.match(errors, /must have no trigger or provisioned/);
  });
});

test("infrastructure policy rejects parser identity, egress, isolation, and permission drift", () => {
  withInfrastructureFixture((fixture) => {
    const runtimePath = path.join(
      fixture,
      "infra/modules/demo-runtime/main.tf",
    );
    const altered = readFileSync(runtimePath, "utf8")
      .replace(
        "internet_access        = false",
        "internet_access        = true",
      )
      .replace(
        'instance_isolation_mode = "SESSION_EXCLUSIVE"',
        'instance_isolation_mode = "NONE"',
      )
      .replace(
        'description            = "Credential-free session-isolated Reflo document parser"',
        'description            = "Credential-free session-isolated Reflo document parser"\n  role                   = alicloud_ram_role.jobs.arn\n  vpc_config {}',
      )
      .replace(
        '"fc:InvokeFunction",',
        '"fc:InvokeFunction",\n        "fc:ListFunctions",',
      );
    writeFileSync(runtimePath, altered);

    const errors = checkInfraPolicy(fixture).join("\n");
    assert.match(errors, /missing required control: instance_isolation_mode/);
    assert.match(errors, /missing required control: internet_access = false/);
    assert.match(errors, /must not configure role/);
    assert.match(errors, /must not configure vpc_config/);
    assert.match(errors, /must receive only the exact FC/);
  });
});

test("infrastructure policy rejects incomplete or mutable API parser client wiring", () => {
  withInfrastructureFixture((fixture) => {
    const runtimePath = path.join(
      fixture,
      "infra/modules/demo-runtime/main.tf",
    );
    const altered = readFileSync(runtimePath, "utf8")
      .replace(
        'REFLO_DEMO_UPLOAD_PROCESSOR_MODE              = "serverless-isolated-ingestion-v1"',
        'REFLO_DEMO_UPLOAD_PROCESSOR_MODE              = "disabled"',
      )
      .replace(
        'REFLO_ALIBABA_FC_PARSER_FUNCTION_QUALIFIER    = "LATEST"',
        'REFLO_ALIBABA_FC_PARSER_FUNCTION_QUALIFIER    = "mutable"',
      )
      .replace("var.artifact_identity.parser_clamav_snapshot_sha256,", "");
    writeFileSync(runtimePath, altered);

    const devPath = path.join(fixture, "infra/environments/dev/main.tf");
    writeFileSync(
      devPath,
      readFileSync(devPath, "utf8").replace(
        "fc_account_id      = var.fc_account_id",
        "",
      ),
    );

    const errors = checkInfraPolicy(fixture).join("\n");
    assert.match(errors, /missing parser client control: REFLO_DEMO/);
    assert.match(
      errors,
      /missing parser client control: REFLO_ALIBABA_FC_PARSER_FUNCTION_QUALIFIER/,
    );
    assert.match(errors, /aggregate artifact digest is missing identity input/);
    assert.match(errors, /must receive the validated FC account ID/);
  });
});

test("infrastructure policy rejects mutable or incomplete parser artifacts", () => {
  withInfrastructureFixture((fixture) => {
    const variablesPath = path.join(
      fixture,
      "infra/modules/demo-runtime/variables.tf",
    );
    writeFileSync(
      variablesPath,
      readFileSync(variablesPath, "utf8").replace(
        "parser-code\\\\.zip",
        "parser-latest\\\\.zip",
      ),
    );

    const runtimePath = path.join(
      fixture,
      "infra/modules/demo-runtime/main.tf",
    );
    writeFileSync(
      runtimePath,
      readFileSync(runtimePath, "utf8").replace(
        'resource "alicloud_fcv3_layer_version" "parser_snapshot"',
        'resource "alicloud_fcv3_layer_version" "missing_snapshot"',
      ),
    );

    const errors = checkInfraPolicy(fixture).join("\n");
    assert.match(errors, /missing content-address validation/);
    assert.match(errors, /missing immutable code\/layer wiring/);
  });
});

test("infrastructure policy rejects an unprotected or artifact-exporting dev apply", () => {
  withInfrastructureFixture((fixture) => {
    const workflow = path.join(fixture, ".github/workflows/deploy-dev.yml");
    writeFileSync(
      workflow,
      readFileSync(workflow, "utf8")
        .replace("environment: dev", "environment: staging")
        .concat("\n# actions/upload-artifact\npull_request:\n"),
    );
    const errors = checkInfraPolicy(fixture).join("\n");
    assert.match(errors, /missing required control: environment: dev/);
    assert.match(errors, /plans, and apply out of pull-request/);
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
    cpSync(path.join(root, ".github"), path.join(fixture, ".github"), {
      recursive: true,
    });
    cpSync(path.join(root, "scripts"), path.join(fixture, "scripts"), {
      recursive: true,
    });
    run(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
