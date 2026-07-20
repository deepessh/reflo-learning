import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function topLevelBlock(source, key) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) {
    return [];
  }

  let end = start + 1;
  while (
    end < lines.length &&
    (lines[end].trim() === "" || /^\s/.test(lines[end]))
  ) {
    end += 1;
  }
  return lines.slice(start + 1, end);
}

export function workflowReportsForEveryPullRequest(source) {
  const onBlock = topLevelBlock(source, "on");
  const pullRequest = onBlock.findIndex((line) =>
    /^  pull_request:\s*(?:\{\})?\s*$/.test(line),
  );
  if (pullRequest === -1) {
    return false;
  }

  for (let index = pullRequest + 1; index < onBlock.length; index += 1) {
    const line = onBlock[index];
    if (line.trim() === "") {
      continue;
    }
    const indentation = line.match(/^\s*/)[0].length;
    if (indentation <= 2) {
      break;
    }
    return false;
  }
  return true;
}

function jobBlock(source, job) {
  const jobs = topLevelBlock(source, "jobs");
  const start = jobs.findIndex((line) => line === `  ${job}:`);
  if (start === -1) {
    return [];
  }
  let end = start + 1;
  while (end < jobs.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(jobs[end])) {
    end += 1;
  }
  return jobs.slice(start + 1, end);
}

export function validateRequiredChecks(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const manifestPath = path.join(root, ".github/required-checks.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [`${manifestPath}: ${error.message}`];
  }

  const checks = manifest.pullRequestChecks;
  if (!Array.isArray(checks) || checks.length === 0) {
    return [".github/required-checks.json must declare pullRequestChecks"];
  }

  const errors = [];
  const seen = new Set();
  for (const check of checks) {
    if (
      typeof check?.context !== "string" ||
      typeof check?.workflow !== "string" ||
      typeof check?.job !== "string"
    ) {
      errors.push(
        "every required check needs context, workflow, and job strings",
      );
      continue;
    }
    if (seen.has(check.context)) {
      errors.push(`duplicate required status context: ${check.context}`);
    }
    seen.add(check.context);

    const workflowPath = path.resolve(root, check.workflow);
    if (
      !workflowPath.startsWith(
        `${root}${path.sep}.github${path.sep}workflows${path.sep}`,
      )
    ) {
      errors.push(`${check.context}: workflow must be under .github/workflows`);
      continue;
    }

    let source;
    try {
      source = readFileSync(workflowPath, "utf8");
    } catch (error) {
      errors.push(
        `${check.context}: cannot read ${check.workflow}: ${error.message}`,
      );
      continue;
    }
    if (!workflowReportsForEveryPullRequest(source)) {
      errors.push(
        `${check.context}: ${check.workflow} must use an unfiltered pull_request trigger`,
      );
    }

    const selectedJob = jobBlock(source, check.job);
    if (selectedJob.length === 0) {
      errors.push(
        `${check.context}: job ${check.job} is missing from ${check.workflow}`,
      );
      continue;
    }
    if (selectedJob.some((line) => /^    if:/.test(line))) {
      errors.push(
        `${check.context}: required job ${check.job} cannot have a job-level if condition`,
      );
    }
    if (check.context !== check.job) {
      errors.push(
        `${check.context}: context must equal job id ${check.job} unless GitHub rules are updated atomically`,
      );
    }
  }
  return errors;
}

export function requiredContextsFromRules(rules) {
  return [
    ...new Set(
      rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((check) => check.context),
    ),
  ].sort();
}

export async function validateGitHubAlignment(
  rootDirectory,
  fetchImpl = fetch,
) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) {
    return [
      "GITHUB_REPOSITORY and GITHUB_TOKEN are required for --check-github",
    ];
  }

  const manifest = JSON.parse(
    readFileSync(
      path.join(rootDirectory, ".github/required-checks.json"),
      "utf8",
    ),
  );
  const expected = manifest.pullRequestChecks
    .map((check) => check.context)
    .sort();
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/rules/branches/main`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    return [`GitHub branch rules request failed with HTTP ${response.status}`];
  }
  const actual = requiredContextsFromRules(await response.json());
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [
        `required status context mismatch: repository=${actual.join(",") || "none"}; manifest=${expected.join(",")}`,
      ];
}

async function main() {
  const root = process.cwd();
  const errors = validateRequiredChecks(root);
  if (process.argv.includes("--check-github")) {
    errors.push(...(await validateGitHubAlignment(root)));
  }
  if (errors.length > 0) {
    console.error(`Required-check policy violations:\n${errors.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.info("Required PR checks are unconditional and aligned");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
