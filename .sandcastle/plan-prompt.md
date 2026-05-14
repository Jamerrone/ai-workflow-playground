# Context

## Open issues

!`gh issue list --state open --label ready-for-agent --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

## Recent commits (last 10)

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

## Issues with open PRs (DO NOT pick these)

The following issue IDs already have an open Sandcastle pull request awaiting human review. **Do not pick them — pick a different issue:** {{SKIP_ISSUE_IDS}}

# Task

Pick the **single** highest-priority open issue that is:

- not in the skip list above
- not blocked by another open issue

If the issue appears to be a PRD and it has implementation issues which link to it, the PRD cannot be worked on.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B's requirements depend on a decision or API shape that A will establish

## Priority order

1. **Bug fixes** — broken behaviour affecting users
2. **Tracer bullets** — thin end-to-end slices that prove an approach works
3. **Polish** — improving existing functionality (error messages, UX, docs)
4. **Refactors** — internal cleanups with no user-visible change

# Output

Output your pick as a JSON object wrapped in `<plan>` tags:

<plan>
{"number": "42", "title": "Fix auth bug"}
</plan>

If every open issue is in the skip list or blocked, output an empty plan:

<plan>
{}
</plan>
