import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_NAMES = new Set(["api", "jobs", "web"]);
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const SKIPPED_DIRECTORIES = new Set([
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const IMPORT_PATTERN =
  /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;

export function checkBoundaries(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const appsRoot = path.join(root, "apps");
  const packagesRoot = path.join(root, "packages");
  const violations = [];

  for (const file of listSourceFiles(appsRoot)) {
    const relative = path.relative(appsRoot, file);
    const [sourceApp] = relative.split(path.sep);
    inspectFile(file, sourceApp, appsRoot, violations);
  }

  for (const file of listSourceFiles(packagesRoot)) {
    inspectFile(file, undefined, appsRoot, violations);
  }

  return violations;
}

function inspectFile(file, sourceApp, appsRoot, violations) {
  const source = readFileSync(file, "utf8");

  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    const packageTarget = specifier.match(
      /^@reflo\/(api|jobs|web)(?:\/|$)/,
    )?.[1];

    if (packageTarget !== undefined && packageTarget !== sourceApp) {
      violations.push(
        `${file}: cannot import application package ${specifier}`,
      );
      continue;
    }

    if (!specifier.startsWith(".")) {
      continue;
    }

    const resolved = path.resolve(path.dirname(file), specifier);
    const relativeTarget = path.relative(appsRoot, resolved);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      continue;
    }

    const [targetApp] = relativeTarget.split(path.sep);
    if (APP_NAMES.has(targetApp) && targetApp !== sourceApp) {
      violations.push(
        `${file}: cannot import source from apps/${targetApp} via ${specifier}`,
      );
    }
  }
}

function listSourceFiles(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRECTORIES.has(entry.name)
          ? []
          : listSourceFiles(target);
      }

      return entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))
        ? [target]
        : [];
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

function main() {
  const violations = checkBoundaries(process.cwd());
  if (violations.length > 0) {
    console.error("Application boundary violations:\n" + violations.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.info("Application boundaries are valid");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
