# issue-triage

Triage and create GitHub issues — size, priority, lane, and type labels plus blocked-by / parent-child relations. Labels and native GitHub relations only; no Projects V2.

## Why

Raw GitHub issues lack structure. This plugin adds Size (S / F-lite / F-full), Priority (P0→P3), Lane, and Type via native labels and issue relations, so the backlog is plannable and a frontier query — "what is grabbable right now?" — is answerable from GitHub alone. It is the single writer of issue relations and tiers; the consuming project states how they are used, e.g. [`docs/agents/issue-tracker.md`](../../docs/agents/issue-tracker.md) in this repo.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install issue-triage
```

OMP:

```bash
omp plugin install issue-triage@roxabi-marketplace
# or from a checkout:
omp plugin link ./plugins/issue-triage
```

Requires authenticated `gh` (`gh auth status`).

OMP `/issue-triage` dumps the skill with `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` expanded (extension; restart after install). Claude substitutes those placeholders at skill load.

## Usage

Triggers: `"triage"` | `"create issue"` | `"set size"` | `"set priority"` | `"blocked by"` | `"set parent"` | `"child of"` | `"sub-issue"` | `"file an issue"` | `"log a bug"` | `"open an issue"` | `"file a bug"` | `"add issue"` | `"new issue"` | `"set lane"` | `"set type"`.

```
/issue-triage list                           List all open issues (tree view)
/issue-triage list --untriaged               Show issues missing Size or Priority
/issue-triage set 42 --size M --priority High
/issue-triage set 42 --body-file path/to/body.md
/issue-triage set 42 --clear-body
/issue-triage set 91 --blocked-by 117
/issue-triage set 164 --parent 163
/issue-triage create --title "..." --size S --priority Medium --type feat --lane b --parent 163
```

`set --body` / `--body-file` replaces the issue body and prints `Body #N` or `Body owner/repo#N`. An empty body is refused; `--clear-body` is the only clear. A pull-request number rewrites the PR description (`PATCH /repos/{owner}/{repo}/issues/{n}`); `set` does not GET the target to refuse one.

Adopt a repository. `init` writes `docs/agents/issue-tracker.md` only when that file is absent, at the git toplevel. An existing contract is kept (`contract: keep-existing`) and is the label vocabulary: a `Label | Colour` table, or canonical names in the template list. A contract that does not parse prints `vocabulary: none parsed from docs/agents/issue-tracker.md` and exits non-zero. `--repo` other than the local repo is refused. Missing labels are created in the contract's colours; an existing label is never recoloured, and a case mismatch is reported instead of created.

Run the `issue-triage` skill's CLI: `init [--dry-run] [--repo owner/repo]`.

`create` accepts the same field flags as `set`: `--size`, `--priority`, `--lane`, `--type`, plus `--parent`, `--add-child`, `--blocked-by`, `--blocks`.

Cross-repo: prefix `GITHUB_REPO=<owner/repo>`, and use fully-qualified `OWNER/REPO#N` refs when that env is set.

Deferred follow-ups normally share the origin's parent. For newly deferred
non-blocking work only, omit `--parent` when that parent is the active delivery
epic; retain Origin, acceptance criteria, size and the origin's native blocked-by
edge. Blocking filings and planned delivery slices keep the parent. An existing
open issue that already tracks the item is reused without reparenting, even when
it is detached or historically remains an epic child. This is the caller's filing
policy, not a new CLI flag or scheduler filter; see the skill's Deferred Follow-Ups.
Final review of a nested delivery epic preserves its enclosing sibling parent;
only a top-level delivery epic has no such parent to pass.

## Size

| Size | Description |
|------|-------------|
| **XS** | Trivial, < 1 hour |
| **S** | Small, < 4 hours |
| **M** | Medium, 1–2 days |
| **L** | Large, 3–5 days |
| **XL** | Very large, > 1 week |

Canonical labels written: `size:S` / `size:F-lite` / `size:F-full`. Legacy `XS/S/M/L/XL` are accepted as `--size` and alias to those (`M`→`F-lite`, `L`/`XL`→`F-full`).

## Priority

| Priority | Action |
|----------|--------|
| **Urgent** (P0) | Do immediately |
| **High** (P1) | Do this sprint |
| **Medium** (P2) | Plan for next sprint |
| **Low** (P3) | Backlog |

P1 fires on either of two triggers: the milestone in progress, or a shipped check that reports a pass when it should fail or stop. The full rubric is in the skill's Priority Guidelines; the consuming project's contract binds it to the repository.

## License

MIT
