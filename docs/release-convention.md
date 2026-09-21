# Release Convention

## Tag format

```
<component>/vX.Y.Z     # monorepo subdir package (e.g. roxabi-nats/v1.2.3)
vX.Y.Z                 # single-package repo (e.g. v0.5.0)
```

PRs: merge-commit only (¬squash) — squash causes history divergence on next promotion.

## Changelog

**Scope: this repo only** (`release.model: trunk`). It does ¬change the `/R-promote` machinery,
and a `staging-train` consumer MUST keep maintaining its changelog: `/R-promote` step 3 writes it
(`skills/promote/SKILL.md:29`, `references/release-artifacts.md` §4a) and step 9b ships the
section as the **release body** — `gh release create --notes "$CHANGELOG_CONTENT"`
(`SKILL.md:363`). Under trunk `release.yml` uses `--generate-notes` instead, so the file
is load-bearing there and inert here. Deleting it under staging-train would ship empty releases.

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

Historically: **racy and self-releasing**. The version was derived *at* merge from the payload's
commit types (`price.sh:117-132`), so concurrent PRs raced the number; and a follow-up PR adding
the heading was itself a payload that `price.sh:123` priced as a patch bump (D18), cutting
another release. D3 was ¬the blocker — it checks the parent count of the SHA being released,
so a 1-parent stamp reds only that run.

**Both hazards died with the tagger** (ADR-021). Nothing derives at merge, so nothing races and
nothing self-releases; the version is known at `git tag -a` time. In-tree headings are now
*possible*. They stay unused because the release body comes from `--generate-notes` and the
archive is byte-frozen — one writable surface, by design. Reopening the question means changing
the release-notes source first, ¬adding a heading beside it.

### Why `finalize.ts`'s `heading` witness stays null under trunk

`lib/finalize.ts:72-88` compares three witnesses against the derived version — PR title,
**CHANGELOG heading**, version file — and warns on disagreement (D7). A null witness is
silent (D12).

Under **staging-train** the version is known before the promotion PR merges, so an author writes
`## [X.Y.Z]` and the witness catches drift. Under trunk `finalize.ts` is not on the path at all —
nothing derives a version at merge, so there is no derivation for a witness to disagree with.
The null is deliberate, ¬an omission.

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
