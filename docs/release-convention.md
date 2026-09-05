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
| GitHub Releases (`--generate-notes`) | **SSoT** — what shipped in which version. Emits merged-PR **titles + links**, ¬bodies |
| PR body | per-change prose: failure mode, migration path, why. One click from the release; the link is the contract, ¬the release text |
| `CHANGELOG.md` | **frozen archive** (`[0.4.0]` and older + an unversioned pile). ¬add entries |

One writable surface, by design. Two of them produced ~30 releases of drift: entries piled up
under `## Unreleased` while v0.5.0 … v4.0.1 shipped, so the heading was false for most of its
content. Enforced by `scripts/__tests__/changelog-archive.test.ts`, which byte-freezes the
archive region — a heading denylist is bypassed by `## [Unreleased]`, a trailing suffix, or
appending under the archive's own heading.

`release-consistency.yml:146` (`changelog_version()`) does parse this file, but matches
`## [X.Y.Z]` only and early-greens on this repo's trunk paths — it will not notice an entry
added to the unversioned pile. The freeze is the only control that does.

### Why in-tree per-version headings are ¬used under trunk

Not impossible — **racy and self-releasing**:

- **Stamp in the feature PR:** the version is derived *at* merge from the payload's commit types
  (`price.sh:117-132`), so an author can predict it only for a serial merge. Concurrent PRs race
  the number.
- **Stamp in a follow-up PR after the tag exists:** the cut PR is itself a payload, and
  `price.sh:123` defaults every conventional type — `docs:`, `chore:` — to a **patch bump**
  (D18). The cut would cut a release. `auto-release.sh:91`'s empty-payload no-op does not save
  it: `DERIVED != BASE`.

D3 is ¬the blocker. It checks the parent count of the SHA **being released**
(`auto-release.sh:44-51`): a 1-parent stamp reds *that* run only, and the next 2-parent merge
releases normally.

### Why `finalize.ts`'s `heading` witness stays null under trunk

`lib/finalize.ts:72-88` compares three witnesses against the derived version — PR title,
**CHANGELOG heading**, version file — and warns on disagreement (D7). A null witness is
silent (D12).

Under **staging-train** the version is known before the promotion PR merges, so an author writes
`## [X.Y.Z]` and the witness catches drift. Under trunk a heading written *after* a release is
still the **previous version** when the next release derives, so the witness would disagree on
every release, forever — noise, ¬signal.

`auto-release.sh:18,99` therefore passes no `--witness-*` flags (D4, with `version_files: []`).
That is deliberate, ¬an omission.

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
