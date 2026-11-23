# Review evidence checklist

## Behavioural proof

- For non-S work, the success-criterion-to-test matrix must cover every success criterion. A missing matrix or unmet behavioural criterion blocks approval. The only `NO TEST` reasons are `infra-not-wired`, `prompt-logic-only`, `ui-manual-only`, and `out-of-scope`.
- For a browser criterion touching `frontend.path` or `shared.ui`, `ui-manual-only` is not sufficient when the base or head stack declares `commands.test_e2e`. Otherwise require a `### Browser check <criterion>` in the PR body with `- Steps:`, an HTTP(S) `- URL:`, and a concrete `- Observed:` result credibly performed for this head.
- Require evidence of consumer-visible behaviour at the candidate head. For a bug fix, a test should fail on the original scenario and pass after the fix. A test that still passes with the relevant guard removed does not prove the guard. Source-text, wiring-copy and mock-echo assertions do not prove behaviour.
- An allowed `NO TEST` reason still needs applicable evidence in place of a test. It does not excuse a safety invariant or count as a passing test.

## Findings

- Separate a missing or weak test from a missing matrix, an unmet criterion, or an evidenced regression. Those substantive defects are not downgraded to test suggestions.
- A missing or weak test is blocking when it leaves an acceptance criterion or safety invariant unproven and no admissible proof stands in its place. Safety covers merge, release, deploy, delete, publish, permissions, and automated stop or disarm. Otherwise report the gap as non-blocking.
- Retain every supported finding; deduplicate only the same defect. Confidence orders findings, not verdicts. Do not demand new proof where existing proof is admissible unless new evidence exposes a defect.
- Review the exact head and affected paths. Unknown coverage is not refutation: expand the review or report the unresolved obligation. A disputed or changed product promise goes to the operator.
