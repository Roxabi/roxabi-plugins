# pr

Create or update a pull request with a Conventional Commits title, issue linking, and guard rails.

## Why

PRs created by hand often have inconsistent titles, missing issue links, and no lifecycle table. `/pr` generates a structured PR with a Conventional Commits title, a lifecycle table (Intent → Analysis → Spec → Implementation → Verification), and a test plan — then rebases the feature branch on the latest base so reviewers see a minimal diff.

## Usage

```
/pr                 Create PR (auto-detects base branch and issue number)
/pr --draft         Create as draft
/pr --base main     Override base branch
```

Triggers: `"create PR"` | `"open PR"` | `"submit PR"` | `"open a pull request"` | `"make a PR"` | `"raise a PR"`

## How it works

1. **Guard rails** — refuses to PR from `staging`/`main`/`master`; refuses if no commits ahead; offers to update if PR already exists; pushes branch if not yet pushed; warns on lint/typecheck failures.
2. **Content generation** — reads commits + diff + lifecycle artifacts (analysis, spec) to generate title (`<type>(<scope>): <desc>`, ≤70 chars) and body.
3. **Create** — runs `gh pr create`; updates issue status to `Review`.
4. **Rebase** — fetches latest base, rebases if behind, force-pushes with lease (no `--force`).
5. **CI** — informs you to run `/ci-watch` to monitor CI.

## PR body template

- Summary bullets
- Lifecycle table (phase → artifact → status)
- Test plan checklist
- `Closes #N`

## Safety

- Never PRs from `staging`, `main`, or `master`
- Only `--force-with-lease` during rebase — never bare `--force`
- Rebase conflicts → abort and defer to user

## Chain position

**Predecessor:** `/implement` | **Successor:** `/ci-watch`
