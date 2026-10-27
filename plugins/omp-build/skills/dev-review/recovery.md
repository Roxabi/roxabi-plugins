# Operator-supervised recovery

Use this procedure only after a canonical review-bound or CI stop. It preserves the stopped PR; it does not reopen a bound, regenerate history, or mint a review result.

## 1. Preserve and diagnose

Before proposing a successor, preserve and read back the complete antecedent: its PR and worktree, branch/base/HEAD, mandate and binding chain, every canonical review/stop/control record, native findings and raw contributions, all consumed rounds, CI observations, proofs, and unresolved obligations. A legacy or malformed history remains evidence and a refusal; it is never converted into a fresh review or an empty history.

Prepare one operator-facing dossier that links that evidence and states:

- the causal diagnosis and disposition of every blocking finding and retained obligation;
- the revised scope, criterion-to-proof/test matrix, and correction plan;
- the proposed successor's issue, branch, base, worktree, PR relationship, and the antecedent it preserves;
- the consumed review/CI history, remaining constraints, and why a new PR is needed rather than another review of the stopped PR.

## 2. Checkpoint before creation

The operator must explicitly approve that dossier, its revised scope/plan, and a concrete execution checkpoint **before** any successor branch, worktree, mandate, binding, PR, review, or push is created. That approval is scoped to the stated checkpoint; it is not an automatic budget reset or permission for later changes.

For PR #118, the adopted succession is principle only. It does not supply this dossier, allocate a successor, or authorize the checkpoint or any execution.

## 3. Create and admit the successor

After the approved checkpoint, use the existing successor path and its current guards. Preserve the antecedent references and coordinates; do not overwrite the old PR, worktree, records, findings, or accounting. The successor starts with a fresh PR review bound, but the old consumed rounds remain part of the dossier and do not disappear.

Perform the revised work with real code, criteria-to-proof/test mapping, and observed proofs. Admit its current branch/base/Spec/config/input under the normal mandate and binding readers. Run a fresh independent native review on its exact HEAD, wait for the repository's required checks on that HEAD, and use normal `landPr`/watch/observed-merge admission. An old PR is not closed as replaced until the approved replacement has actually merged and the disposition is observed.

## Prohibited substitutions

No automated retry, `reviews: 0` reset, manual `reviewed` label, direct merge, legacy-comment conversion, fabricated record, or new writer substitutes for this procedure. A new refusal returns to causal diagnosis and a new explicit checkpoint; it does not extend the original approval.
