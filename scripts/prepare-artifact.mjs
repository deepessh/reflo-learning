import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const ALLOWED_ARTIFACTS = new Set(["api", "jobs", "web"]);
const [artifactName, sourceDirectory] = process.argv.slice(2);

if (!artifactName || !ALLOWED_ARTIFACTS.has(artifactName)) {
  throw new Error("Artifact name must be one of: api, jobs, web");
}

const root = process.cwd();
const artifactsRoot = path.resolve(root, ".artifacts");
const target = path.resolve(artifactsRoot, artifactName);

if (path.dirname(target) !== artifactsRoot) {
  throw new Error("Refusing to prepare an artifact outside .artifacts");
}

rmSync(target, { force: true, recursive: true });
mkdirSync(artifactsRoot, { recursive: true });

if (sourceDirectory) {
  const source = path.resolve(root, sourceDirectory);
  if (!existsSync(source)) {
    throw new Error(`Artifact source does not exist: ${sourceDirectory}`);
  }
  cpSync(source, target, { recursive: true });
}

console.info(`Prepared .artifacts/${artifactName}`);
