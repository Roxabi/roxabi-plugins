# recheck

Drift-check a GitHub issue before any work begins. Catches stale issues (code evolved, symbols renamed, blockers resolved) before `/dev` spends time on a premise that no longer holds.

## Why

Issues age. By the time `/dev` fires, the fix may already exist, symbols may have been renamed or removed, or blocking dependencies may have closed — making the original premise invalid or redundant.

The riskiest path is S-tier: `/dev` jumps straight from triage to implementation with no intermediate gates (frame, analyze, spec, and plan are all skipped). Without `/recheck`, a stale S-tier issue produces committed work on a dead premise with no checkpoint to catch it.

`/recheck` is the fail-fast guard between `/issue-triage` and `/frame`, and it runs for every tier (S, F-lite, F-full) with no skip path.

## Usage

```
/recheck #N
```

Called standalone, `/recheck` runs all three drift checks, then presents a 3-option decision prompt (Proceed | Close | Abort) if any signal fires.

When invoked by `/dev` as part of the pipeline, the same checks run but the decision prompt includes a fourth option — **Update issue first** — which re-runs `/issue-triage` and then re-runs `/recheck` exactly once. If signals still fire on the second run, the Update option is removed and the user must choose a terminal outcome.

Triggers: `"recheck"` | `"is this issue still valid"` | `"check drift"` | `"check issue staleness"`

## How it works

Three deterministic checks run in parallel (no LLM calls):

| Signal | What it checks | Means |
|---|---|---|
| git-drift | `git log --since=<issue.created_at>` on file paths cited in the issue body | Code has moved in the area the issue describes |
| symbol-missing | `grep` for symbols or error strings cited in the issue body | An identifier the issue references no longer exists in the tree |
| dep-resolved | `gh issue view <blocker> --json state` for each `blocked-by` link | A dependency the issue was waiting on is now closed |

When **all checks are clean**: prints `Issue still relevant.` (one line in pipeline mode; a richer summary with signal counts in standalone mode) and returns silently with no artifact written.

When **any signal fires**: prints a `## Drift Signals` summary listing each signal kind and its evidence (commit SHAs, missing symbol names, closed blocker numbers), then presents a decision prompt:

| Option | Pipeline | Standalone | Effect |
|---|---|---|---|
| Proceed anyway | ✓ | ✓ | Continue with the current premise; `/dev` moves to the next step |
| Update issue first | ✓ | — | Re-run `/issue-triage`, then re-run `/recheck` exactly once |
| Close as resolved/obsolete | ✓ | ✓ | `gh issue close N --reason completed` and abort `/dev` |
| Abort | ✓ | ✓ | Exit `/dev` cleanly; no issue mutation |

The **Update issue first** option is not available in standalone mode because there is no `/dev` context to loop back into — run `/issue-triage` manually and then call `/recheck #N` again.

## State

No on-disk artifact (per frame Out-of-Scope). Session-only tracking inside `/dev` (`Σ_s`), the same pattern used by `validate` and `ci-watch`. Starting a new `/dev` session on the same issue re-runs the check fresh — this is intentional, as deterministic checks are cheap and fresh state is more reliable than stale cached results.
