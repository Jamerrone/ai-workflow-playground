# Context

You are authoring a Pull Request for the work just completed on branch `{{SOURCE_BRANCH}}`,
to be merged into `{{TARGET_BRANCH}}`.

## Issue

- ID: {{TASK_ID}}
- Title: {{ISSUE_TITLE}}

## Commits on this branch (vs `{{TARGET_BRANCH}}`)

!`git log --oneline {{TARGET_BRANCH}}..{{SOURCE_BRANCH}}`

## Diff stat

!`git diff --stat {{TARGET_BRANCH}}...{{SOURCE_BRANCH}}`

# Task

Read the issue context and the diff above. Then output **exactly** the following two
tags and nothing else outside them:

<pr-title>
A concise PR title in the form `<type>: <imperative summary>`. Under 72 characters.
</pr-title>

<pr-body>
{{CLOSES_LINE}}## Summary

What changed and why, in 1–4 sentences.

## Test Plan

How the change was verified (tests added, manual checks, etc.). Do NOT invent test
results — only describe what the diff actually contains.
</pr-body>

# Constraints

- Do not run `gh`, `git push`, `git commit`, or any branch-mutating command. The
  host will run `gh pr create` after parsing your output.
- Do not invent test results that don't appear in the diff.
- Do not include a "Generated with Sandcastle" footer.
- Do not add `--draft` semantics or any other CLI flags.
- Output the two tags above exactly once each. Anything outside them is ignored.

When done, output `<promise>COMPLETE</promise>` after the closing `</pr-body>`.
