import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const RUNTIME_BASE =
  "eclipse-temurin:25.0.3_9-jre-jammy@sha256:fbae06a5dad7ec55dac9db087c9fa007a3d6009818175486a24bfa3014c806c5";
const BUILD_BASE =
  "eclipse-temurin:25.0.3_9-jdk-jammy@sha256:8f5909797786d657cfb5232c43179d35fd2ca27f8c91f03fa55b727fbfd744dd";

describe("isolated ingestion worker image policy", () => {
  const containerfile = readFileSync(
    new URL("../worker/Containerfile", import.meta.url),
    "utf8",
  );

  it("uses only the authorized full Temurin 25 Jammy linux/amd64 pins", () => {
    const fromLines = containerfile
      .split("\n")
      .filter((line) => line.startsWith("FROM "));
    expect(fromLines).toEqual([
      `FROM --platform=linux/amd64 ${BUILD_BASE} AS build`,
      `FROM --platform=linux/amd64 ${RUNTIME_BASE} AS runtime`,
    ]);
    expect(containerfile).not.toMatch(
      /FROM .*:(?:latest|25-jre-jammy)(?:\s|$)/,
    );
  });

  it("pins every downloaded runtime component by an immutable URL and checksum", () => {
    expect(containerfile).toContain(
      "49b7d9592c13e8834fd1e2339bf22b2fabe378317393b51b3879de8520c5b01f",
    );
    expect(containerfile).toContain(
      "6235ea0dae45ea137f59c09320406f5888383741924d98855bd2ce0d16b54f21",
    );
    expect(containerfile).toContain(
      "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    );
    expect(containerfile).toContain(
      "tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata",
    );
    expect(containerfile).toContain("liblept5=1.82.0-3build1");
  });

  it("keeps build and connected update tools out of the runtime", () => {
    const runtime = containerfile.slice(containerfile.lastIndexOf("FROM "));
    expect(runtime).toContain("USER 65532:65532");
    expect(runtime).toContain(
      'ENTRYPOINT ["java", "-jar", "/opt/reflo/worker.jar"]',
    );
    expect(runtime).not.toMatch(/\b(?:curl|freshclam|mvn)\s+--/);
    expect(runtime).not.toContain(
      "COPY --from=build /opt/tesseract /opt/tesseract",
    );
    expect(runtime).toContain("test ! -e /usr/local/bin/freshclam");
    expect(runtime).toContain("test ! -e /opt/java/openjdk/bin/javac");
  });
});
