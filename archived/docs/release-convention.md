# Release Convention

## Explicit annotated tags

This repository releases only when a maintainer pushes an annotated tag on `main`:

```bash
git tag -a roxabi-plugins/vX.Y.Z -m "Release roxabi-plugins vX.Y.Z"
git push origin roxabi-plugins/vX.Y.Z
```

[`.github/workflows/release.yml`](../.github/workflows/release.yml) is triggered by
`roxabi-plugins/v*`. It verifies that the tag is annotated, points at the triggering commit, and
that the commit is reachable from `main`, then creates the GitHub Release with generated notes.
Merging to `main` does not create a release or derive a version.

## Changelog

| Surface | Role |
|---|---|
| GitHub Releases | Source of truth for shipped versions; generated notes link merged PRs. |
| PR body | Per-change context: failure mode, migration path, and rationale. |
| `CHANGELOG.md` | Byte-frozen historical archive; do not add entries. |

The changelog's frozen region is guarded by
`scripts/__tests__/changelog-archive.test.ts`. The release workflow does not consume it.

### Staging-train consumers

This convention is scoped to this repository's explicit-tag release workflow. A
`staging-train` consumer still maintains its own changelog and uses its release body as required
by that consumer's promotion process; this repository's frozen archive does not change that
contract.
