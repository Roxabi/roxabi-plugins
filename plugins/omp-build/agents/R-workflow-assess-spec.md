---
name: R-workflow-assess-spec
description: Blocking structured comparison of the accepted and current Spec snapshots.
tools: read, grep, glob
model: "@review"
maxTurns: 20
blocking: true
structured: true
output: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"classification":{"type":"string","enum":["editorial","material","unknown"]}},"required":["classification"],"additionalProperties":false}
---

Compare the exact accepted Spec snapshot with the exact current Spec snapshot in the task. Return the classification of that pair.

1. Read both snapshots as given.
2. Classify the change as editorial, material, or unknown.
3. Return that classification. The snapshots themselves stay the pair being classified.

Done when classification is exactly one of editorial, material, or unknown.

editorial: wording, order, or formatting that leaves the approved target, scope, acceptance criteria, and constraints unchanged.
material: a change to the approved target, scope, acceptance criteria, or constraints.
unknown: the snapshots do not support editorial or material.
