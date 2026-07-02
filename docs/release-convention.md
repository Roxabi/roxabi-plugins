# Release Convention

## Tag format

```
<component>/vX.Y.Z     # monorepo subdir package (e.g. roxabi-nats/v1.2.3)
vX.Y.Z                 # single-package repo (e.g. v0.5.0)
```

PRs: merge-commit only (¬squash) — squash causes history divergence on next promotion.

## Branch convention for uv git deps

Roxabi Python repos consume cross-repo deps via `[tool.uv.sources]` in `pyproject.toml`.

| Branch | Ref style | When |
|--------|-----------|------|
| `staging` | `branch = "staging"` | Development — tracks latest staging SHA |
| `main` | `tag = "vX.Y.Z"` | Production — pinned to exact release tag |

This means `pyproject.toml` on `staging` uses `branch=`, and on `main` uses `tag=`. The swap is automated by `/promote` (Step 1b — pin-swap phase).

## `/promote` pin-swap phase

At promotion time (staging→main), `/promote` automatically:

1. Detects `[tool.uv.sources]` entries with `branch=`
2. Resolves the SHA pinned in `uv.lock` to a release tag on the remote (`git ls-remote --tags`)
3. Shows a user choice diff: `branch=staging → tag=vX.Y.Z`
4. On Apply: rewrites `pyproject.toml`, regenerates `uv.lock`, stages both

If no release tag exists at the locked SHA, promotion FAILS with:

```
FAIL: No release tag found at <pkg>@<sha8>.
Cut a release tag (e.g. <pkg>/vX.Y.Z) at <sha8> upstream first.
```

This is intentional friction — promotion must ship exactly what staging tested.

## Scope

uv-only (`[tool.uv.sources]`). pip / poetry / pnpm deferred until a real consumer appears.

## References

- `/promote` SKILL.md — Step 1b full spec
- `lib/pin-swap.ts` — implementation (pure functions, I/O-injected)
- `__tests__/pin-swap.test.ts` — unit tests
