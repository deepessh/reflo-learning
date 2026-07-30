import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("registry-free parser Function Compute packaging policy", () => {
  it("packages one code archive and three bounded layer archives", async () => {
    const packaging = await readFile(
      new URL("./prepare-dev-deployment-artifacts.sh", import.meta.url),
      "utf8",
    );
    for (const archive of [
      "parser-code.zip",
      "parser-java-worker-layer.zip",
      "parser-native-layer.zip",
      "parser-clamav-snapshot-layer.zip",
    ]) {
      assert.match(packaging, new RegExp(archive.replace(".", "\\.")));
    }
    assert.doesNotMatch(packaging, /docker image (?:save|push)/);
    assert.doesNotMatch(packaging, /\bacr\b|aliyun.*registry/i);
    assert.match(packaging, /REFLO_CLAMAV_ADMISSION_DATABASE_DIR/);
    assert.match(
      packaging,
      /clamav@sha256:48eaad9644475c2d466ce6d4ba2da892dbd4dcd47713201d31b665364655cc3c/,
    );
    assert.match(packaging, /admit-clamav-layer-snapshot\.mjs/);
    assert.match(
      packaging,
      /com\/reflo\/ingestion\/FunctionRuntimeMain\.class/,
    );
    for (const runtimePath of ["/opt/java/openjdk", "/opt/reflo/worker.jar"]) {
      assert.match(
        `${packaging}\n${await readFile(
          new URL(
            "../packages/ingestion/worker/function/bootstrap",
            import.meta.url,
          ),
          "utf8",
        )}`,
        new RegExp(runtimePath),
      );
    }
    assert.match(packaging, /\$native_stage\/reflo\/native\/bin/);
    assert.match(packaging, /\$native_stage\/reflo\/native\/lib/);
    assert.match(packaging, /\$snapshot_stage\/reflo\/clamav/);
    assert.doesNotMatch(packaging, /\$(?:java|native|snapshot)_stage\/opt\//);
    assert.match(
      packaging,
      /debian:11\.11-slim@sha256:de70627667ac77b32ab6858f1acddfb04a4ff3acc1095ac17dbc19fe5725bcb6/,
    );
    const layerfile = await readFile(
      new URL(
        "../packages/ingestion/worker/FunctionLayerfile",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(
      layerfile,
      /^FROM --platform=linux\/amd64 debian:11\.11-slim@sha256:de70627667ac77b32ab6858f1acddfb04a4ff3acc1095ac17dbc19fe5725bcb6/m,
    );
    assert.match(layerfile, /tesseract-5\.5\.2/);
    assert.match(layerfile, /clamav-1\.4\.5/);
    assert.match(layerfile, /libleptonica-dev=1\.79\.0-1\.1\+deb11u1/);
    const functionManifest = JSON.parse(
      await readFile(
        new URL(
          "../packages/ingestion/worker/function-manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(
      functionManifest.contractVersion,
      "serverless-isolated-ingestion-package-v1",
    );
    assert.equal(functionManifest.runtime, "custom.debian11");
    assert.deepEqual(functionManifest.components, {
      java: "temurin-25.0.3+9",
      leptonica: "1.79.0-1.1+deb11u1",
      ocrEngine: "tesseract-5.5.2",
      ocrLanguage: "eng-tessdata_fast-87416418657359cb625c412a48b6e1d6d41c29bd",
      parser: "apache-tika-3.3.1",
      scanner: "clamav-1.4.5",
    });
    assert.deepEqual(functionManifest.paths, {
      bootstrap: "/code/bootstrap",
      clamavSnapshots: "/opt/reflo/clamav",
      java: "/opt/java/openjdk/bin/java",
      nativeBin: "/opt/reflo/native/bin",
      nativeLib: "/opt/reflo/native/lib",
      tessdata: "/opt/reflo/native/tessdata",
      worker: "/opt/reflo/worker.jar",
    });
  });

  it("makes the protected workflow assert the exact parser artifact set", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/deploy-dev.yml", import.meta.url),
      "utf8",
    );
    assert.match(
      workflow,
      /Assert immutable parser Function Compute artifacts/,
    );
    assert.match(workflow, /parser-code\.zip/);
    assert.match(workflow, /parser-clamav-snapshot-layer\.zip/);
    assert.match(workflow, /test ! -e .*parser\.tar/);
    assert.match(workflow, /reflo-dev-deployment-artifacts-v3/);
    assert.match(workflow, /custom\.debian11/);
  });

  it("packages the disabled Piper fallback as one exact jobs layer", async () => {
    const [packaging, workflow, layerfile, requirements, runtime] =
      await Promise.all([
        readFile(
          new URL("./prepare-dev-deployment-artifacts.sh", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../.github/workflows/deploy-dev.yml", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../packages/audio/piper-worker/FunctionLayerfile",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL(
            "../packages/audio/piper-worker/function-requirements.txt",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../infra/modules/demo-runtime/main.tf", import.meta.url),
          "utf8",
        ),
      ]);

    assert.match(packaging, /jobs-piper-layer\.zip/);
    assert.match(workflow, /jobs-piper-layer\.zip/);
    assert.match(
      layerfile,
      /python:3\.13\.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6/,
    );
    for (const digest of [
      "b17184a664bd9431ce95c138f4bfb3025e1280cf26075a703dbfdcab989b8ee3",
      "6872443f236a554921cda6f318c900e2d0c226792cf3534d00e5057c6926e5d2",
      "5d4f08ba6a2a48c44592eed3ce56bf85e9de3dd4e20df90541ae68a8310c029a",
      "7e1f4634af596d83cca997fb7a931ba80b70f8a316a2655ee69c55365e0ace14",
    ]) {
      assert.match(layerfile, new RegExp(digest));
    }
    for (const dependency of [
      "onnxruntime==1.27.0",
      "piper-tts==1.4.2",
      "pip==25.3",
    ]) {
      assert.match(requirements, new RegExp(dependency.replace(".", "\\.")));
    }
    assert.match(runtime, /compatible_runtime = \["nodejs20"\]/);
    assert.match(runtime, /REFLO_PIPER_ACTIVATION_STATUS\s*=\s*"blocked"/);
    assert.doesNotMatch(
      runtime,
      /REFLO_PIPER_ACTIVATION_STATUS\s*=\s*"active"/,
    );
  });
});
