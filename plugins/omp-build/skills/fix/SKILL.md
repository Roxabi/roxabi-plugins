---
name: fix
argument-hint: '[#PR | #issue]'
description: >-
  OMP-only correction intake for an explicit open issue or PR, and bounded
  interrupted-correction recovery. Captures evidence by reference and never lands.
version: 0.6.0
---

# Fix

`/fix` is a correction-purpose workflow, not a general feature workflow. It resolves
one explicit existing PR or open issue reference, or an unambiguous current GitHub context, before it
stores anything. An issue reference aliases its unique current authenticated bound open PR; check out
that PR's branch first. An issue without such a PR is refused before writes; correction without a PR
is unsupported. Targetless, ambiguous, closed, stopped, stale or incompatible input stops.
It never creates a feature, arms, labels `reviewed`, lands, or enters `/feature`.

## Record-native pipeline

1. **Bind.** Resolve the open target and its current head. A review-bound request
   additionally requires `nextReviewStep(cwd, pr, { reviewing: true })` to return
   `action: fix`: a PR-state prerequisite, not sufficient authority. The installed
   product separately admits the current mandate, binding, accepted Spec and
   selected decision, and rechecks authority before continuation and effects.
   `reason: ci-failed` goes through the admitted CI correction flow, not this
   review consumer. Stopped, stale, incomplete or incompatible authority refuses.
   On `fix-publish-remote-credential-refused` or `fix-publish-remote-head-mismatch`,
   report the code without the URL and stop before publication; use the push-binding
   guidance in [README](../../README.md).
   Before C0/R publication, the host completes preparation/origin checks and
   confirms a durable `fix-owner` under the shared destination mutex. An existing
   owner is a stop; follow the interrupted branch below rather than minting a root.
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
   operator scope and policy—not opaque IDs alone. It partitions every usable
   finding into exactly one cause and retains every unusable finding with diagnostics.
   Each cause has the seven-field plan, cited necessary/urgent/too-large judgments,
   and a proposed disposition. Persist and confirm every assessed outcome on the
   original UW before applying any admitted `fix-original` cause.
5. **Apply.** Before every apply, falsification, restoration or required-path
   revalidation, publish a distinct correction action inventory bound to the
   immutable candidate, request, decision and policy. Conserve every action child
   before interpreting it. Later falsification, restoration and revalidation bind
   the exact retained native-original contribution IDs for their prior apply proof;
   they never reconstruct that evidence from an opaque task hash or description. A
   usable model-reported failed apply on a verified unchanged worktree gets at most
   three same-plan attempts; structural, ownership, restore or native errors are
   terminal.
6. **Falsify and close.** Falsification has at most two rounds, independent of
   apply retries. Before any native effect, bind the checked-out named non-default
   branch, candidate SHA, explicit destination ref, effective push URL, and its
   GitHub identity (the PR head repository, including a fork)
   with the observed remote ref; reject detached/default/mismatched state. Push that
   explicit SHA/ref with no tag following, verify the remote SHA,
   then publish correction, falsification and final fix-result records through
   the common adapter, with scoped references to the confirmed dispositions.

## Admission

The original UW and its accepted Spec must match the authenticated correction
inputs. The engine assesses each cause mechanically from its per-dimension cited
judgments; only `fix-original` outcomes enter correction, subject to the existing
mandate, authority and continuation gates. Missing or contested blocking evidence
holds the original for motivated adjudication; insufficient nonblocking evidence
becomes a report. No cause identity is inferred by code.

## Interrupted correction

1. **Inspect.** Use the factual `/uw` or correction-refusal hint. Call
   `omp_build_recover_interrupted_fix` with only the authenticated PR number;
   the current host and engine select the owner, evidence and eligible transition.
2. **Confirm.** Wait for genuine root-operator confirmation of the exact proposal.
   Neutral predecision closure permits a fresh ordinary `/fix` on the same UW/PR.
   Unstarted existing-review adoption continues the original R/D and bounds;
   it does not run a request-producing preparer.
3. **Honor holds.** Native/startup or plan entry, missing originating witness,
   spent work, stale authority and ambiguous effects remain held. Report the
   actual reason; model text, process absence and local caches grant no authority.
   Preserve raw history and local data. See the
   [supported cuts and host limits](../../README.md#bounded-correction-recovery).

## Falsification

Read `skill://fix/falsification.md`. A falsification pass requires at least one
production guard removal and every such removal to make the recorded proof fail on
the intended `failure:` scenario. Missing guard, unavailable infrastructure,
unrelated proof failure, error or inconclusive result is `skipped`, never pass.

## Reports and sisters

Reports are durable outcomes on the original UW, not issues. List or explicitly
promote them with `/uw`; promotion requires authenticated operator confirmation of
the exact framed request. A sister is proposed for necessary, urgent work too large
for the original and created only after exact operator confirmation. A blocking
sister holds the original; a nonblocking sister waits for the original. No automatic
grouped filing occurs, and a pending or failed operation never clears a blocker.

## Exit

Report record IDs, selected/retained causes, actual proof facts, each
`pass|fail|skipped` falsification result, and unresolved obligations. A skipped
falsification is not a successful proof. Next action is a fresh review of the moved
head; this workflow never arms or merges it.

$ARGUMENTS
