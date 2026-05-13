// Sequential Reviewer (PR mode) — implement → review → PR loop
//
// This template drives a multi-phase workflow per issue:
//   Phase 1 (Implement):    An agent picks an open issue, works on it
//                           on a dedicated branch, commits the changes, and
//                           signals completion.
//   Phase 2 (Review):       A second agent reviews the branch diff and either
//                           approves it or makes corrections directly on the
//                           branch.
//   Phase 3 (Push):         The host pushes the local branch to a clean
//                           `sandcastle/issue-<id>-<slug>` remote name.
//   Phase 4 (PR author):    A third agent reads the diff and emits a
//                           structured PR title and body.
//   Phase 5 (gh pr create): The host opens the pull request.
//
// All agent phases share a single sandbox created via createSandbox(), so the
// implementer, reviewer, and PR author work on the same explicit branch.
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
// The implementer prompt is told to skip these so the agent picks something new.
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

const fetchIssueTitle = (issueId: string): string | null => {
  try {
    return execSync(
      `gh issue view ${shellEscape(issueId)} --json title -q .title`,
      { encoding: "utf8" },
    ).trim();
  } catch (err) {
    console.error(
      `  ✗ Could not fetch title for issue ${issueId}: ${(err as Error).message ?? "unknown error"}`,
    );
    return null;
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
    // implementer surface the real error.
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

  // Bail early if there's nothing to work on — saves spinning up a sandbox
  // just to have the implementer report an empty backlog.
  if (countEligibleIssues(skipIssueIds) === 0) {
    console.log(
      "No eligible open issues (every ready-for-agent issue already has an open Sandcastle PR, or the backlog is empty). Exiting.",
    );
    break;
  }

  // Generate a unique temporary branch name for this iteration. After we know
  // which issue the agent picked, we push to a clean
  // `sandcastle/issue-<id>-<slug>` remote name (see Phase 3).
  const tempBranch = `sandcastle/sequential-reviewer/${Date.now()}`;

  // Create a single sandbox that the implementer, reviewer, and PR author
  // share. This gives all three agents a real, named branch that persists
  // across phases.
  const sandbox = await sandcastle.createSandbox({
    branch: tempBranch,
    sandbox: docker(),
    hooks,
    copyToWorktree,
  });

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Implement
    //
    // An agent picks the next open issue (skipping any whose IDs are in
    // SKIP_ISSUE_IDS), writes the implementation (using RGR: Red → Green →
    // Repeat → Refactor), and commits the result. It also emits
    // <issue-id>N</issue-id> so the host knows which issue to push for and
    // open a PR against.
    //
    // The agent signals completion via <promise>COMPLETE</promise> when done.
    // -----------------------------------------------------------------------
    const implement = await sandbox.run({
      name: "implementer",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-opus-4-7"),
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: { SKIP_ISSUE_IDS: skipList },
    });

    if (!implement.commits.length) {
      console.log("Implementation agent made no commits. Skipping review and PR.");
      continue;
    }

    const idMatch = implement.stdout.match(/<issue-id>(\d+)<\/issue-id>/);
    if (!idMatch) {
      console.error(
        "Implementation agent did not emit <issue-id>N</issue-id>. Skipping review and PR.",
      );
      continue;
    }
    const issueId = idMatch[1]!;

    const issueTitle = fetchIssueTitle(issueId);
    if (!issueTitle) {
      continue;
    }

    console.log(`\nImplementation complete on branch: ${tempBranch}`);
    console.log(`Issue ${issueId}: ${issueTitle}`);
    console.log(`Commits: ${implement.commits.length}`);

    // -----------------------------------------------------------------------
    // Phase 2: Review
    //
    // A second agent reviews the diff of the branch produced by Phase 1.
    // {{SOURCE_BRANCH}} and {{TARGET_BRANCH}} are built-in prompt args
    // auto-populated by sandcastle, so the reviewer inspects the right branch
    // and either approves or makes corrections directly on the branch.
    // -----------------------------------------------------------------------
    await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-opus-4-7"),
      promptFile: "./.sandcastle/review-prompt.md",
    });

    console.log("\nReview complete.");

    // -----------------------------------------------------------------------
    // Phase 3: Push
    //
    // Push the local temp branch to a clean `sandcastle/issue-<id>-<slug>`
    // remote name. If a PR already exists for this remote branch and is
    // open, the push alone updates it — we skip phases 4 and 5. If the PR
    // was merged or closed, we skip pushing entirely (no force-push).
    // -----------------------------------------------------------------------
    const remoteBranch = `sandcastle/issue-${issueId}-${slugify(issueTitle)}`;
    const existing = checkExistingPr(remoteBranch);
    if (existing.state === "MERGED") {
      console.warn(
        `  ⚠ ${issueId}: PR ${existing.url} already merged — skipping.`,
      );
      continue;
    }
    if (existing.state === "CLOSED") {
      console.warn(
        `  ⚠ ${issueId}: PR ${existing.url} closed — skipping.`,
      );
      continue;
    }

    try {
      const refspec = `${tempBranch}:refs/heads/${remoteBranch}`;
      execSync(`git push origin ${shellEscape(refspec)}`, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      console.error(
        `  ✗ ${issueId}: push failed — skipping (no force-push).\n${stderr}`,
      );
      continue;
    }

    if (existing.state === "OPEN" && existing.url) {
      console.log(`  ↻ ${issueId}: updated existing PR ${existing.url}`);
      continue;
    }

    // -----------------------------------------------------------------------
    // Phase 4: PR author
    //
    // A short-lived agent reads the branch diff and emits a structured
    // <pr-title> + <pr-body>. The host parses these tags and uses them to
    // open the PR in Phase 5. The agent never runs `gh` or `git push`.
    // -----------------------------------------------------------------------
    const prAuthor = await sandbox.run({
      name: "pr-author",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-opus-4-7"),
      promptFile: "./.sandcastle/pr-prompt.md",
      promptArgs: {
        TASK_ID: issueId,
        ISSUE_TITLE: issueTitle,
        ISSUE_ID: issueId,
        CLOSES_LINE: `Closes #${issueId}\n\n`,
      },
    });

    const prTitleMatch = prAuthor.stdout.match(
      /<pr-title>([\s\S]*?)<\/pr-title>/,
    );
    const prBodyMatch = prAuthor.stdout.match(
      /<pr-body>([\s\S]*?)<\/pr-body>/,
    );
    if (!prTitleMatch || !prBodyMatch) {
      console.error(
        `  ✗ ${issueId}: pr-author did not emit <pr-title> + <pr-body>. PR not created (branch is pushed though).`,
      );
      continue;
    }
    const prTitle = prTitleMatch[1]!.trim();
    const prBody = prBodyMatch[1]!.trim();

    // -----------------------------------------------------------------------
    // Phase 5: gh pr create
    //
    // The host runs `gh pr create` with the agent-authored title and body.
    // All args are shell-escaped to avoid injection issues.
    // -----------------------------------------------------------------------
    try {
      const cmd =
        `gh pr create --base ${shellEscape(defaultBranch)} ` +
        `--head ${shellEscape(remoteBranch)} ` +
        `--title ${shellEscape(prTitle)} ` +
        `--body ${shellEscape(prBody)}`;
      const url = execSync(cmd, { encoding: "utf8" }).trim();
      console.log(`  ✓ ${issueId}: opened ${url}`);
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      console.error(`  ✗ ${issueId}: gh pr create failed.\n${stderr}`);
    }
  } finally {
    await sandbox.close();
  }
}

console.log("\nAll done.");
