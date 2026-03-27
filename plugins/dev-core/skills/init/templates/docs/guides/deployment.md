# Deployment Guide

Project-specific deployment procedures. Agents read this via `{standards.deployment}`.

> Universal patterns (CI/CD pipeline stages, Docker best practices, secret management) are embedded in the `devops` agent.
> This file documents **your project's specific** deployment setup.

## Environments

<!-- Document your deployment environments. Examples:
  | Environment | URL | Branch | Auto-deploy? |
  |-------------|-----|--------|:---:|
  | Production  | app.example.com | main | No (manual promote) |
  | Staging     | staging.example.com | staging | Yes |
  | Preview     | pr-N.example.com | PR branches | Yes |
-->

TODO: Document your environments.

## Deploy Process

<!-- Document how deployments work. Examples:
  - Vercel auto-deploys on push to staging
  - Production: /promote creates staging→main PR, merge triggers deploy
  - Rollback: revert commit on main, auto-redeploy
-->

TODO: Document your deploy process.

## Environment Variables

See [Configuration](../configuration.md) for the full env var table. Document only **per-environment overrides** here (e.g., staging vs production values, secrets rotation).

## Monitoring & Health Checks

<!-- Document how you monitor deployments. Examples:
  - Health endpoint: GET /api/health (returns 200 + version)
  - Error tracking: Sentry (auto-captured)
  - Uptime: Vercel Analytics
-->

TODO: Document monitoring setup.
