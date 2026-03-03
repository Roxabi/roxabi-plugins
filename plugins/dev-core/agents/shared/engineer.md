# Engineer Base Protocol

> Base profile for implementation agents (backend-dev, frontend-dev). See [base.md](./base.md) for universal protocol.



## Standards

MUST read the relevant standards file before writing code. Standards contain framework conventions, ORM/UI patterns, TypeScript rules, and project-specific constraints.

## Implementation Confidence

Confidence <70% on implementation approach → message architect before writing code.

## Quality Gates

After implementation: run `{commands.lint} && {commands.typecheck} && {commands.test}`. ✗ → fix before reporting done. Config failures → message devops.
