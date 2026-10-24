---
name: fix
argument-hint: '[#PR | #issue]'
description: >-
  OMP-only correction intake for an explicit open issue or PR. Captures review
  evidence by reference, publishes correction records, and never lands a change.
version: 0.5.0
---

# Fix

`/fix` is a correction-purpose workflow, not a general feature workflow. It resolves
one explicit existing issue/PR, or an unambiguous current GitHub context, before it
stores anything. Targetless, ambiguous, closed, stopped, stale or bound-incompatible
input stops and asks for the missing reference. It never creates a feature, arms,
labels `reviewed`, lands, or enters `/feature`.

## Record-native pipeline

1. **Bind.** Resolve the open target and its current head. A review-bound request
   additionally requires `nextReviewStep(cwd, pr, { reviewing: true })` to return
   `action: fix`: a PR-state prerequisite, not sufficient authority. The installed
   product separately admits the current mandate, binding, accepted Spec and
   selected decision, and rechecks authority before continuation and effects.
   `reason: ci-failed` goes through the admitted CI correction flow, not this
   review consumer. Stopped, stale, incomplete or incompatible authority refuses.
2. **Request.** Publish the raw operator contribution, then a limited-scope
   `fix-request` with `landing: false`. Existing structured review data is consumed
   by its confirmed record ID; it is not parsed, reclustered, relabelled, or
   reclassified.
3. **Intake.** Publish a correction-purpose `review-attempt` before activating
   the exact native batch. Every observed child—including malformed, incomplete,
   duplicate and unknown children—keeps all raw submissions, exact attempt indexes,
   expected slot provenance and actual child ID before any admission decision. Native
   callbacks only conserve and settle; intake, synthesis and effects advance
   sequentially outside callbacks.
4. **Synthesize.** One common correction-purpose decision receives the full
   confirmed contribution payloads (including originals and raw associations), exact
   operator scope and policy—not opaque IDs alone. It names admitted causes but
   cannot grant landing. The seven fields are exact: mechanism, fix, failure,
   restored, paths, proof and exact finding-member IDs. Missing, duplicate, unknown,
   unusable, or policy-ineligible members retain the obligation.
5. **Apply.** Before every apply, falsification, restoration or required-path
   revalidation, publish a distinct correction action inventory bound to the
   immutable candidate, request, decision and policy. Conserve every action child
   before interpreting it. Later falsification, restoration and revalidation bind
   the exact retained native-original contribution IDs for their prior apply proof;
   they never reconstruct that evidence from an opaque task hash or description. A
   usable model-reported failed apply on a verified unchanged worktree gets at most
   three same-plan attempts; structural, ownership, restore or native errors are
   terminal. An optional neighbor withdraws only after real revert and every
   required path revalidates.
6. **Falsify and close.** Falsification has at most two rounds, independent of
   apply retries. Before any native effect, bind the checked-out named non-default
   branch, candidate SHA, explicit destination ref, effective push URL, and its
   GitHub identity (the PR head repository, including a fork, or the issue target)
   with the observed remote ref; reject detached/default/mismatched state. Push that
   explicit SHA/ref with no tag following, verify the remote SHA,
   then publish correction, falsification, debt and final fix-result records through
   the common adapter. Projection is deterministic from those records; no parallel
   Markdown writer or Markdown business parser exists.

## Admission

Baseline selects only a well-formed cause with at least one blocking member. Active
`evidence-v1` additionally needs the independently accepted policy reference and a
selected `authorization: required` safe plan, or an
`optional-neighbor-of RC-N` with all six evidence-policy conditions plus
separability. A required parent completes before its optional neighbors. The policy
in `skill://dev-review/evidence-policy.md` remains authoritative; shadow is local
observation only and cannot patch, publish, file, label or route.

No cause identity is inferred by code: the model owns identity, merge, impact, final
label and cause membership. Known blockers remain blocking; unknown or unusable
required input refuses admission rather than producing a clean result.

## Falsification

Read `skill://fix/falsification.md`. A falsification pass requires at least one
production guard removal and every such removal to make the recorded proof fail on
the intended `failure:` scenario. Missing guard, unavailable infrastructure,
unrelated proof failure, error or inconclusive result is `skipped`, never pass.

## Debt

Retained obligations receive durable debt receipts. **Baseline** files one trusted
issue for each ineligible or failed blocking cause (with all its associated
findings), and one bundled issue for all nonblocking obligations in the run.
**evidence-v1** files each obligation only when it independently proves
`important AND urgent AND too-large`. Missing, false, unknown or disputed candidate
evidence remains retained and never clears a required blocker. A triage failure is a
durable `deferred` receipt, never a second unbound create attempt.

### Filing — trusted transport contract

The following recipe is the only admissible filing transport. It starts outside the
checkout so a tracked preload or `.env` cannot forge a filing receipt. Title/body
must be materialized into the temporary directory first; text never reaches the
command line.

```bash
FILE_DIR=$(mktemp -d -t "omp-build-fix-file-XXXXXX")
trap 'rm -rf "$FILE_DIR"' EXIT
# write "$FILE_DIR/title.txt" and "$FILE_DIR/body.md" with the write tool, then:
TRIAGE=$(realpath skill://issue-triage/triage.ts) && TRIAGE_REPO="${GITHUB_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
triage() { (: "${TRIAGE:?issue-triage unresolved}" "${TRIAGE_REPO:?repository unresolved}" && cd "$(dirname "$TRIAGE")" && GITHUB_REPO="$TRIAGE_REPO" bun --no-env-file "$TRIAGE" "$@"); }
triage create --title-file "$FILE_DIR/title.txt" --body-file "$FILE_DIR/body.md" ...
```

`issue-triage` retains relationship ownership: a follow-up is a sibling of the
source issue's parent, blocked by the source issue, never a child of it. A partial
create is repaired with `triage set`, never another `create`.

## Exit

Report record IDs, selected/retained causes, actual proof facts, each
`pass|fail|skipped` falsification result, and unresolved obligations. A skipped
falsification is not a successful proof. Next action is a fresh review of the moved
head; this workflow never arms or merges it.

$ARGUMENTS
