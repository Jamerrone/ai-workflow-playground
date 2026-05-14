// Sequential Reviewer (PR mode) — plan → implement → review → PR loop
//
// This template drives a multi-phase workflow per issue:
//   Phase 1 (Plan):         The planner reads the open issues, applies the
//                           priority order + blocking rules, and returns the
//                           single best issue to work on.
//   Phase 2 (Implement):    The implementer works the picked issue on a
//                           dedicated branch, commits the changes, and signals
//                           completion.
//   Phase 3 (Review):       The reviewer inspects the branch diff and either
//                           approves it or makes corrections directly on the
//                           branch.
//   Phase 4 (Push):         The host pushes the local branch to a clean
//                           `sandcastle/issue-<id>-<slug>` remote name.
//   Phase 5 (PR author):    The PR author reads the diff and emits a
//                           structured PR title and body.
//   Phase 6 (gh pr create): The host opens the pull request.
//
// The implementer, reviewer, and PR author share a single sandbox created via
// createSandbox(), so all three work on the same explicit branch. The planner
// runs in its own ephemeral sandbox since it only reads issues.
//
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration. Merging a PR auto-closes its issue via the `Closes #N` line in
// the PR body. This is the PR-mode variant of the sequential-reviewer
// template — instead of merging completed branches into HEAD, it accumulates
// PRs for human review.
//
// Usage:
//   npx tsx .sandcastle/main.ts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.ts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue. Raise this to process more issues per run.
const MAX_ITERATIONS = 2;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Host helpers (run on the host, not in the sandbox — gh + git shell-outs)
// ---------------------------------------------------------------------------

const shellEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

const slugify = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return slug || "untitled";
};

const preflight = (): { defaultBranch: string } => {
  try {
    execSync("git remote get-url origin", { stdio: "ignore" });
  } catch {
    throw new Error(
      "PR mode requires an 'origin' remote. Add one with `git remote add origin <url>`.",
    );
  }
  try {
    execSync("git symbolic-ref -q HEAD", { stdio: "ignore" });
  } catch {
    throw new Error(
      "PR mode requires a checked-out branch (HEAD is detached). Run `git checkout <branch>` first.",
    );
  }
  let ghVersionRaw = "";
  try {
    ghVersionRaw = execSync("gh --version", { encoding: "utf8" });
  } catch {
    throw new Error(
      "PR mode requires the GitHub CLI (`gh`). Install from https://cli.github.com/.",
    );
  }
  const m = ghVersionRaw.match(/gh version (\d+)\.(\d+)/);
  if (!m || Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 4)) {
    throw new Error(
      `PR mode requires gh ≥ 2.4 (found: ${ghVersionRaw.trim()}). Upgrade with your package manager.`,
    );
  }
  try {
    execSync("gh auth status", { stdio: "ignore" });
  } catch {
    throw new Error(
      "PR mode requires `gh auth login` on the host. Run it and retry.",
    );
  }
  const defaultBranch = execSync(
    "gh repo view --json defaultBranchRef -q .defaultBranchRef.name",
    { encoding: "utf8" },
  ).trim();
  if (!defaultBranch) {
    throw new Error(
      "Could not resolve repository default branch. Check `gh repo view` output.",
    );
  }
  return { defaultBranch };
};

type PrState = "OPEN" | "CLOSED" | "MERGED" | null;

const checkExistingPr = (
  remoteBranch: string,
): { state: PrState; url?: string; number?: number } => {
  try {
    const raw = execSync(
      `gh pr list --head ${shellEscape(remoteBranch)} --state all --json number,state,url --limit 1`,
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    const arr = JSON.parse(raw) as {
      number: number;
      state: PrState;
      url: string;
    }[];
    return arr[0] ?? { state: null };
  } catch (err) {
    console.warn(
      `  ⚠ Could not check existing PR for ${remoteBranch}: ${(err as Error).message ?? "unknown error"}`,
    );
    return { state: null };
  }
};

// Returns the set of issue IDs that currently have an open Sandcastle PR.
// The planner is told to skip these so it picks something new.
const listIssueIdsWithOpenPrs = (): Set<string> => {
  try {
    const raw = execSync(
      `gh pr list --state open --limit 200 --json headRefName`,
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    const prs = JSON.parse(raw) as { headRefName: string }[];
    return new Set(
      prs
        .map((pr) => pr.headRefName.match(/^sandcastle\/issue-(\d+)/)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
  } catch (err) {
    console.warn(
      `  ⚠ Could not list open Sandcastle PRs: ${(err as Error).message ?? "unknown error"}`,
    );
    return new Set();
  }
};

const countEligibleIssues = (skipIds: Set<string>): number => {
  try {
    const raw = execSync(
      `gh issue list --state open --label ready-for-agent --json number`,
      { encoding: "utf8" },
    );
    const issues = JSON.parse(raw) as { number: number }[];
    return issues.filter((i) => !skipIds.has(String(i.number))).length;
  } catch {
    // If gh fails, optimistically assume there's work to do and let the
    // planner surface the real error.
    return 1;
  }
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const { defaultBranch } = preflight();

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  const skipIssueIds = listIssueIdsWithOpenPrs();
  const skipList =
    skipIssueIds.size > 0 ? Array.from(skipIssueIds).join(", ") : "(none)";

  // Bail early if there's nothing to work on — saves spinning up the planner
  // sandbox just to discover an empty backlog.
  if (countEligibleIssues(skipIssueIds) === 0) {
    console.log(
      "No eligible open issues (every ready-for-agent issue already has an open Sandcastle PR, or the backlog is empty). Exiting.",
    );
    break;
  }

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planner reads the open issues, applies the priority rules + skip
  // list, and returns the single best issue inside a <plan> tag.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-opus-4-7"),
    promptFile: "./.sandcastle/plan-prompt.md",
    promptArgs: { SKIP_ISSUE_IDS: skipList },
  });

  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    console.warn("Planner did not emit a <plan> tag. Skipping iteration.");
    continue;
  }
  const picked = JSON.parse(planMatch[1]!) as {
    number?: string;
    title?: string;
  };
  if (!picked.number || !picked.title) {
    console.log("Planner returned no eligible issue. Exiting.");
    break;
  }
  const issueNumber = picked.number;
  const issueTitle = picked.title;
  console.log(`Planner picked issue ${issueNumber}: ${issueTitle}`);

  // The branch name is deterministic from the issue, so the implementer,
  // reviewer, and push all share the same branch.
  const branch = `sandcastle/issue-${issueNumber}-${slugify(issueTitle)}`;

  // Defensive: the planner skips issues whose IDs are in the open-PR list,
  // but a PR could have been merged or closed without auto-closing the
  // issue. Skip those before paying the cost of a sandbox.
  const existing = checkExistingPr(branch);
  if (existing.state === "MERGED") {
    console.warn(
      `  ⚠ ${issueNumber}: PR ${existing.url} already merged — skipping.`,
    );
    continue;
  }
  if (existing.state === "CLOSED") {
    console.warn(`  ⚠ ${issueNumber}: PR ${existing.url} closed — skipping.`);
    continue;
  }
  if (existing.state === "OPEN") {
    // Race: PR was opened between the planner's skip-list query and now.
    console.warn(
      `  ⚠ ${issueNumber}: PR ${existing.url} already open — skipping.`,
    );
    continue;
  }

  // Create a single sandbox that the implementer, reviewer, and PR author
  // share. This gives all three agents a real, named branch that persists
  // across phases.
  const sandbox = await sandcastle.createSandbox({
    branch,
    sandbox: docker(),
    hooks,
    copyToWorktree,
  });

  try {
    // -----------------------------------------------------------------------
    // Phase 2: Implement
    //
    // The implementer works the issue selected by the planner and commits
    // the result.
    // -----------------------------------------------------------------------
    const implement = await sandbox.run({
      name: "implementer",
      maxIterations: 100,
      agent: sandcastle.claudeCode("claude-sonnet-4-6"),
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: { ISSUE_NUMBER: issueNumber, ISSUE_TITLE: issueTitle },
    });

    if (!implement.commits.length) {
      console.log(
        "Implementation agent made no commits. Skipping review and PR.",
      );
      continue;
    }

    console.log(`\nImplementation complete on branch: ${branch}`);
    console.log(`Issue ${issueNumber}: ${issueTitle}`);
    console.log(`Commits: ${implement.commits.length}`);

    // -----------------------------------------------------------------------
    // Phase 3: Review
    //
    // The reviewer inspects the diff of the branch produced by Phase 2.
    // {{SOURCE_BRANCH}} and {{TARGET_BRANCH}} are built-in prompt args
    // auto-populated by sandcastle, so the reviewer inspects the right branch
    // and either approves or makes corrections directly on the branch.
    // -----------------------------------------------------------------------
    await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-sonnet-4-6"),
      promptFile: "./.sandcastle/review-prompt.md",
    });

    console.log("\nReview complete.");

    // -----------------------------------------------------------------------
    // Phase 4: Push
    //
    // Push the branch to its remote of the same name. No force-push: if the
    // remote rejects (e.g. a stale ref ahead of our local), surface the
    // error and skip rather than overwrite work.
    // -----------------------------------------------------------------------
    try {
      execSync(`git push -u origin ${shellEscape(branch)}`, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      console.error(
        `  ✗ ${issueNumber}: push failed — skipping (no force-push).\n${stderr}`,
      );
      continue;
    }

    // -----------------------------------------------------------------------
    // Phase 5: PR author
    //
    // The PR author reads the branch diff and emits a structured
    // <pr-title> + <pr-body>. The host parses these and opens the PR in
    // Phase 6.
    // -----------------------------------------------------------------------
    const prAuthor = await sandbox.run({
      name: "pr-author",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-sonnet-4-6"),
      promptFile: "./.sandcastle/pr-prompt.md",
      promptArgs: {
        ISSUE_NUMBER: issueNumber,
        ISSUE_TITLE: issueTitle,
        CLOSES_LINE: `Closes #${issueNumber}\n\n`,
      },
    });

    const prTitleMatch = prAuthor.stdout.match(
      /<pr-title>([\s\S]*?)<\/pr-title>/,
    );
    const prBodyMatch = prAuthor.stdout.match(/<pr-body>([\s\S]*?)<\/pr-body>/);
    if (!prTitleMatch || !prBodyMatch) {
      console.error(
        `  ✗ ${issueNumber}: pr-author did not emit <pr-title> + <pr-body>. PR not created (branch is pushed though).`,
      );
      continue;
    }
    const prTitle = prTitleMatch[1]!.trim();
    const prBody = prBodyMatch[1]!.trim();

    // -----------------------------------------------------------------------
    // Phase 6: gh pr create
    //
    // The host runs `gh pr create` with the agent-authored title and body.
    // All args are shell-escaped to avoid injection issues.
    // -----------------------------------------------------------------------
    try {
      const cmd =
        `gh pr create --base ${shellEscape(defaultBranch)} ` +
        `--head ${shellEscape(branch)} ` +
        `--title ${shellEscape(prTitle)} ` +
        `--body ${shellEscape(prBody)}`;
      const url = execSync(cmd, { encoding: "utf8" }).trim();
      console.log(`  ✓ ${issueNumber}: opened ${url}`);
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      console.error(`  ✗ ${issueNumber}: gh pr create failed.\n${stderr}`);
    }
  } finally {
    await sandbox.close();
  }
}

console.log("\nAll done.");
