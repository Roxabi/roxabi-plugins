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

Called standalone, `/recheck` runs all three drift checks. **AQ only when signals are ambiguous** (`symbol-missing` and/or `dep-resolved`) — Proceed | Close | Abort. Pure `git-drift` is printed and auto-proceeds (no prompt).

When invoked by `/dev`, the same rules apply; the ambiguous DP adds **Update issue first** (re-runs `/issue-triage` then `/recheck` once). On the second run, Update is omitted.

Triggers: `"recheck"` | `"is this issue still valid"` | `"check drift"` | `"check issue staleness"`

## How it works

Three deterministic checks run in parallel (no LLM calls):

| Signal | What it checks | Means |
|---|---|---|
| git-drift | `git log --since=<issue.created_at>` on file paths cited in the issue body | Code has moved in the area the issue describes |
| symbol-missing | `grep` for symbols or error strings cited in the issue body | An identifier the issue references no longer exists in the tree |
| dep-resolved | `gh issue view <blocker> --json state` for each `blocked-by` link | A dependency the issue was waiting on is now closed |

When **all checks are clean**: prints `Issue still relevant.` (one line in pipeline mode; a richer summary with signal counts in standalone mode) and returns silently with no artifact written.

When **only git-drift fires** (informative): prints `## Drift Signals` + one proceed line — **no decision prompt**. Code moved nearby is expected; symbols still found and blockers still open (or none).

When **ambiguous signals fire** (`symbol-missing` and/or `dep-resolved`): prints `## Drift Signals`, then presents a decision prompt:

| Option | Pipeline | Standalone | Effect |
|---|---|---|---|
| Proceed anyway | ✓ | ✓ | Continue with the current premise; `/dev` moves to the next step |
| Update issue first | ✓ | — | Re-run `/issue-triage`, then re-run `/recheck` exactly once |
| Close as resolved/obsolete | ✓ | ✓ | `gh issue close N --reason completed` and abort `/dev` |
| Abort | ✓ | ✓ | Exit `/dev` cleanly; no issue mutation |

The **Update issue first** option is not available in standalone mode because there is no `/dev` context to loop back into — run `/issue-triage` manually and then call `/recheck #N` again.

## State

No on-disk artifact (per frame Out-of-Scope). Session-only tracking inside `/dev` (`Σ_s`), the same pattern used by `validate` and `ci-watch`. Starting a new `/dev` session on the same issue re-runs the check fresh — this is intentional, as deterministic checks are cheap and fresh state is more reliable than stale cached results.

## Effectiveness tracking

`/recheck` only earns its place in the pipeline if it actually catches stale issues. The original frame defines two checkpoints:

- **Success in 6 months:** at least one stale issue caught per month before `/implement` runs; zero S-tier issues silently re-implementing already-fixed bugs.
- **Revisit trigger (3-month window):** if `/recheck` fires zero *ambiguous* signals across three months of usage, **or** users still override/close more often than they Proceed when the DP fires, re-open the design (git-drift-only auto-proceed is expected and not counted as skip friction).

Tracking is **manual**: no metric is written to disk by design (no recheck-log artifact). Operators should periodically grep recent `/dev` runs for "Drift Signals" appearances and note skip-rate informally. If the revisit trigger fires, open an issue to re-evaluate.
