# Historical cause records

A cause groups final findings that share one mechanism; a shared file, reviewer or class is not a shared cause. The canonical decision partitions usable final findings into causes and retains unusable findings with diagnostics in `unassignedFindings`. `findingIds` reference final findings; those findings' `sourceFindingIds` reference the retained originals. Unknown or duplicate references refuse rather than being repaired. `causes: []` is not proof of approval.

Each `Cause` has `id`, `title`, `judgment`, and `proposedDisposition`, plus seven plan fields: `mechanism`, `fix`, `failure`, `restored`, `paths`, `proof`, and `findingIds`. `paths` are repository-local paths the plan covers. A correction receipt's `proofPaths` identify the proof implementation separately, which matters when adding a test without changing production paths.

`proof` describes the observation meant to fail before the correction and pass after it. `NO TEST` and skipped or inconclusive falsification are not a pass. A correction record cannot establish criterion satisfaction or landing.

The cited necessity, urgency and size judgments inform [cause disposition](../../GLOSSARY.md#language). A proposed disposition grants no authority. Missing, contested or contradictory blocking evidence stays pending; adjudication and reports belong to the original UW. A blocking sister remains an obligation until authoritative completion or a confirmed causal-dependency adjustment.
