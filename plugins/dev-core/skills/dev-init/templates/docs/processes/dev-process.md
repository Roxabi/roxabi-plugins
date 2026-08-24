# Development Process

Project-specific development workflow. Agents read this via `{standards.dev_process}`.

## Branch Strategy

<!-- Document your branching model. Example:
  - main: production (protected, squash merge only)
  - staging: integration (auto-deploy to staging env)
  - feat/N-slug: feature branches (from staging)
  - fix/N-slug: bug fixes (from staging)
-->

TODO: Document your branch strategy.

## Workflow

<!-- Document the development flow for your team. Example:
  1. /dev #N → determines tier (S / F-lite / F-full)
  2. Frame → Spec → Plan (artifacts reviewed at each gate)
  3. Implement in worktree (git worktree add ../project-N)
  4. PR → review → fix → merge to staging
  5. /promote → staging→main PR → production deploy
-->

TODO: Document your development workflow.

## Code Ownership

<!-- Document who owns what. Examples:
  | Path | Owner | Review required? |
  |------|-------|:---:|
  | apps/web/ | Frontend team | Yes |
  | apps/api/ | Backend team | Yes |
  | packages/ui/ | Design system team | Yes |
  | .github/ | DevOps | Yes |
-->

TODO: Document code ownership.

## Release Process

<!-- Document how releases work. Examples:
  - /promote creates staging→main PR with changelog
  - Version bumps follow semver (breaking=major, feature=minor, fix=patch)
  - Tags created automatically on merge to main
-->

TODO: Document your release process.
