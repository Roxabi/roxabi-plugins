# Code Review Standards

Project-specific review guidelines. Agents read this via `{standards.code_review}`.

> Universal patterns (security checklist, severity definitions) are embedded in the `security-auditor` agent.
> This file documents **your project's specific** review criteria.

## Review Checklist

- [ ] Code follows project patterns (see `backend-patterns` / `frontend-patterns`)
- [ ] Tests added/updated for all changed behavior
- [ ] No security vulnerabilities introduced (see security-auditor agent)
- [ ] Documentation updated if public API changed
- [ ] No TODO comments without linked issue
- [ ] Types are explicit (no `any` without justification)

## Conventional Comments

Reviews use Conventional Comments format:

| Label | Blocks merge? | When |
|-------|:---:|------|
| `issue(blocking):` | Yes | Bug, security, spec violation |
| `suggestion(blocking):` | Yes | Standard violation |
| `suggestion(non-blocking):` | No | Improvement idea |
| `nitpick:` | No | Style preference |
| `praise:` | No | Good work worth noting |

## Project-Specific Rules

<!-- Add review rules specific to your project. Examples:
  - All Prisma schema changes need migration review
  - New API endpoints need OpenAPI spec update
  - New shared components need Storybook story
-->

TODO: Add project-specific review rules.

## AI Quick Reference

<!-- Compressed imperative rules for dev-core agents. Keep under 10 lines. -->

TODO: Add concise, imperative rules for agents.
