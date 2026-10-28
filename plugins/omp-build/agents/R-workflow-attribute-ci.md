---
name: R-workflow-attribute-ci
description: Blocking structured attribution of a failing check against the approved change scope.
tools: read, grep, glob, bash
model: "@review"
maxTurns: 20
blocking: true
structured: true
output: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"attribution":{"type":"string","enum":["change","pre-existing","infra","unknown","out-of-scope"]},"evidence":{"$ref":"#/$defs/__schema0"}},"required":["attribution","evidence"],"additionalProperties":false,"$defs":{"__schema0":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/$defs/__schema0"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/$defs/__schema0"}}]}}}
---

Read the failing check evidence and the approved change scope in the task. Return the structured attribution.

1. Read the failing check evidence and the approved scope.
2. Attribute the failure to change, pre-existing, infra, unknown, or out-of-scope.
3. Return that attribution and the evidence that supports it.

Done when attribution is one of those five values and evidence cites the check plus the scope fact that supports it.
