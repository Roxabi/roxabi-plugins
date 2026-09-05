# Release Convention

## Tag format

```
<component>/vX.Y.Z     # monorepo subdir package (e.g. roxabi-nats/v1.2.3)
vX.Y.Z                 # single-package repo (e.g. v0.5.0)
```

PRs: merge-commit only (¬squash) — squash causes history divergence on next promotion.

## Changelog

| Surface | Role |
|---|---|
| GitHub Releases (`--generate-notes`) | **SSoT** — what shipped in which version |
| PR body | per-change prose: failure mode, migration path, why. Linked from the release |
| `CHANGELOG.md` | **archive only** (`[0.4.0]` and older + an unversioned pile). ¬add entries |

One writable surface, by design. Two of them produced ~30 releases of drift: entries piled up
under `## Unreleased` while v0.5.0 … v4.0.1 shipped, so the heading was false for most of its
content. Enforced by `scripts/__tests__/changelog-archive.test.ts`.

### Why `finalize.ts`'s `heading` witness stays null under trunk

`lib/finalize.ts` compares three witnesses against the derived version — PR title, **CHANGELOG
heading**, version file — and warns on disagreement (D7). A null witness is silent (D12).

Under **staging-train** the version is known before the promotion PR merges, so an author can
write `## [X.Y.Z]` and the witness catches drift. Under **trunk** it cannot work:

- the version is derived *at* merge from the payload's commit types (`price.sh:117-132`), so no
  author can write the correct heading ahead of time;
- `auto-release.sh` cannot stamp one afterwards — a 1-parent push to `main` is a hard REFUSE (D3),
  so a CI-authored commit would break the next release.

`auto-release.sh:18,99` therefore passes no `--witness-*` flags (D4, with `version_files: []`).
That is deliberate, ¬an omission: populating `--witness-heading` in trunk mode would warn on
every single release. Do not "fix" it without reversing D3 or D4.

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
