# Engineer Base Protocol

> Base profile for implementation agents (R-backend-dev, R-frontend-dev). See [base.md](./base.md) for universal protocol.



## Standards

MUST read the relevant standards file before writing code. Standards contain framework conventions, ORM/UI patterns, TypeScript rules, and project-specific constraints.

## Implementation Confidence

Confidence <70% on implementation approach → message R-architect before writing code.

## Quality Gates

After implementation: run `{commands.lint} && {commands.typecheck} && {commands.test}`. ✗ → fix before reporting done. Config failures → message R-devops.
