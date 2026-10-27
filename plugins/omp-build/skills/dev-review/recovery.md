# Operator-supervised PR #118 replacement

This is the concrete, adopted replacement path for legacy PR #118 and issue #107. It applies after a legacy-admission failure or a canonical review/CI stop; neither condition alone creates a successor. It is not a generic stopped-PR recovery mechanism.

## 1. Preserve and diagnose

Before proposing a replacement, preserve and read back #118's PR and worktree, branch/base/HEAD, two historical review cycles and lots, legacy diagnostics, findings, consumed rounds, CI observations, proofs, unresolved obligations, and every available record. Legacy history remains evidence and a refusal; it is never converted into a canonical review, mandate, binding, or empty history.

Prepare one operator-facing dossier that links that evidence and states:

- the causal diagnosis and disposition of every blocking finding and retained obligation;
- the revised scope, criterion-to-proof/test matrix, and correction plan;
- the proposed #107 branch, base, worktree, distinct PR relationship, and why #118 remains preserved;
- the consumed review/CI history, remaining constraints, and why a distinct PR is required.

## 2. Separate checkpoint

The operator must explicitly approve the dossier, revised scope/plan, and a concrete #118 replacement checkpoint **before** a replacement branch, worktree, mandate, binding, PR, review, or push is created. The checkpoint must expressly authorize a **first native #107 mandate under the replacement authority**. It is neither a reset of #118's accounting nor native admission by itself.

The adopted succession in principle supplies neither this checkpoint nor a current execution permission.

## 3. Re-establish the only supported native authority

After that checkpoint, re-read the complete native history for #107 and its parent histories through the existing trusted GitHub policy. `selectApplicableMandate` must return the genuine `refused`/`missing` absence: complete history, no claimed or confirmed mandate, and no conflicting, partial, incompatible, applicable, abandoned, revoked, paused, or stopped authority.

Any other result stops. It needs a separately supported and adopted transition; do not mint a first mandate, abandon authority to make it missing, or promise a generic replacement path.

## 4. Establish the replacement coordinates and first mandate

For the admitted absence only, calculate the current #107 branch with `branchFor`, resolve the base from fresh `main`, and use `prepareFeatureCheckout`/`runWorktreeBootstrap` in the resulting worktree. The branch must be recomputed at execution and differ from #118's historical branch; otherwise stop. Old worktrees and data stay intact.

Under the explicitly approved replacement authority, call `publishFirstMandate` for #107, then re-read the complete history and require `applicable`. Its `antecedent: null` is honest: #118 has no canonical mandate antecedent. #118's links, history, reviews, lots, and diagnostics stay in the dossier/Spec/provenance, not in a fabricated external record reference.

Do **not** use `publishSuccessorMandate` or `/feature new`: their ordinary path preserves prior branch/base and may bind the same PR, so it does not create this distinct replacement or a fresh PR bound.

## 5. Distinct PR and normal admission

Create the distinct PR from the newly admitted #107 branch, then use `confirmWorkflowBinding` on that PR's own number and read back the binding. Implement the revised work with real code, criterion-to-proof/test mapping, and observed proofs. Run a fresh independent native review on its exact HEAD, wait for its required checks, and use normal `landPr`/watch/observed-merge admission.

#118 remains preserved and is closed as replaced only after the approved distinct replacement has actually merged and the disposition is observed. No automatic retry, `reviews: 0` reset, manual `reviewed` label, direct merge, legacy-comment conversion, fabricated record, or new writer substitutes for this path.
