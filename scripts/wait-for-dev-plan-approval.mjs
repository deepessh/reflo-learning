import { pathToFileURL } from "node:url";

const ISSUE_NUMBER = 199;
const MARKER =
  /^<!-- reflo-dev-plan-approval:v1\ncommit: ([a-f0-9]{40})\nplan-sha256: ([a-f0-9]{64})\ndecision: approved\n-->$/;

export function findDevPlanApproval(
  comments,
  { commit, generatedAt, owner, planDigest },
) {
  const generatedTime = Date.parse(generatedAt);
  if (
    !Array.isArray(comments) ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    !/^[a-f0-9]{64}$/.test(planDigest) ||
    !/^[A-Za-z0-9-]{1,39}$/.test(owner) ||
    !Number.isFinite(generatedTime)
  ) {
    throw new Error("dev plan approval input is invalid");
  }
  return comments.find((comment) => {
    const match =
      typeof comment?.body === "string" ? MARKER.exec(comment.body) : null;
    return (
      match !== null &&
      match[1] === commit &&
      match[2] === planDigest &&
      comment.author_association === "OWNER" &&
      comment.user?.login === owner &&
      Date.parse(comment.created_at) > generatedTime
    );
  });
}

async function listComments({ repository, token }) {
  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/issues/${ISSUE_NUMBER}/comments?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub approval lookup failed with ${response.status}`);
    }
    const pageComments = await response.json();
    if (!Array.isArray(pageComments)) {
      throw new Error("GitHub approval response is invalid");
    }
    comments.push(...pageComments);
    if (pageComments.length < 100) {
      break;
    }
  }
  return comments;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = process.env.REFLO_PLAN_COMMIT;
  const generatedAt = process.env.REFLO_PLAN_GENERATED_AT;
  const planDigest = process.env.REFLO_PLAN_DIGEST;
  const waitSeconds = Number(process.env.REFLO_PLAN_APPROVAL_WAIT_SECONDS);
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    repository !== "deepessh/reflo-learning" ||
    typeof commit !== "string" ||
    typeof generatedAt !== "string" ||
    typeof planDigest !== "string" ||
    !Number.isSafeInteger(waitSeconds) ||
    waitSeconds < 60 ||
    waitSeconds > 3600
  ) {
    throw new Error("protected dev plan approval configuration is invalid");
  }
  const owner = repository.split("/")[0];
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const approval = findDevPlanApproval(
      await listComments({ repository, token }),
      { commit, generatedAt, owner, planDigest },
    );
    if (approval !== undefined) {
      console.info("Exact post-plan owner approval verified on issue #199");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error("exact post-plan owner approval was not recorded in time");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
