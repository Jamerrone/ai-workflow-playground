# Task

Fix issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view`, with comments. If it has a parent PRD, pull that in too.

Only work on the issue specified.

# Context

Here are the last 10 commits:

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

# Workflow

1. **Explore** — read the issue carefully. Read the relevant source files and tests before writing any code.
2. **Plan** — decide what to change and why. Keep the change as small as possible.
3. **Execute** — use RGR (Red → Green → Repeat → Refactor): write a failing test first, then write the implementation to pass it.
4. **Verify** — run `npm run typecheck` and `npm run test` before committing. Fix any failures before proceeding.
5. **Commit** — make a single git commit. The message MUST:
   - Start with `RALPH:` prefix
   - Include the task completed and any PRD reference
   - List key decisions made
   - List files changed
   - Note any blockers for the next iteration

# Rules

- **Do NOT close the issue.** The host opens a PR whose body includes `Closes #{{ISSUE_NUMBER}}`; the issue closes automatically when the PR is merged.
- **Do NOT run `gh issue close`, `git push`, `git checkout`, or `gh pr create`.** The host handles all branch and PR operations.
- Do not leave commented-out code or TODO comments in committed code.
- If you are blocked (missing context, failing tests you cannot fix, external dependency), commit what you have with a clear blocker note in the commit message — the reviewer and PR will surface the situation.

# Done

Once your commit is made, output the completion signal:

<promise>COMPLETE</promise>
