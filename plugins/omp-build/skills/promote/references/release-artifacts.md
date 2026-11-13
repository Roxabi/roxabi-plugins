# Release Artifacts — Version, Changelog, Commit

Let: V := version | Δ := changelog entry

## Compute Version (Step 2)

`$VERSION` is a **pure derivation** — never typed, never guessed. The sole deriver is
[`price.sh`](skill://promote/price.sh) (spec S2): component-scoped tag glob, **reachability-based** `BASE`,
payload `rev-list --no-merges ^BASE_SHA <heads>`, bump per D18. It is the *only* place a version is
computed; the PR title, CHANGELOG heading and version file are all **witnesses** of it, never sources.

### 2a. Resolve the component (guard)

```bash
COMPONENT=$(yq -r '.release.component // "null"' .dev/stack.yml 2>/dev/null \
  || python3 -c 'import yaml;print((yaml.safe_load(open(".dev/stack.yml")).get("release") or {}).get("component") or "null")')
```

`COMPONENT` is `null`/empty → **REFUSE** (S6/D13). Never fall back to a bare tag —
`null/v0.1.0` is silent and wrong. Print a paste-ready block (component = the newest `*/v*` tag prefix):

```yaml
release:
  component: <name>
  version_files: []
```

Two keys, because two are read: `release.component` scopes the tag glob and the
`<component>/vX.Y.Z` prefix, `release.version_files` lists the files stamped in
Step 2b and compared in the drift guard. dev-core's block also carried
`class: NONE | PRODUCER | TRIGGER`, defined by a document that did not travel
here (ADR-020 §3) and read by nothing in omp-build — a paste-ready block whose
field the reader cannot resolve is an instruction to guess, so it is dropped
rather than restated from memory. `release.model` is separate and optional
(`staging-train` when absent) — see `## Trunk mode` in the skill body.

### 2b. Preview via price.sh

```bash
T=$(realpath skill://promote/price.sh) || {
  printf 'REFUSE: cannot resolve skill://promote/price.sh\n'
  exit 1
}
PREVIEW=$(bash "$T" "$COMPONENT" origin/main origin/main origin/staging); RC=$?
```

| `price.sh` exit | Meaning | Action |
|---|---|---|
| `0` | `$PREVIEW` = bare `X.Y.Z` | `VERSION="${COMPONENT}/v${PREVIEW}"` |
| `10` | no reachable tag = **first release** | `VERSION="${COMPONENT}/v0.1.0"`; if `git tag -l "${COMPONENT}/v*"` is **non-empty** (tags exist but unreachable), **warn** — a higher tag may live on a staging lineage |
| `≥1` other | git/arg error | **REFUSE** — never invent a version |

The preview is a proposal, not consent. Offer **Use {VERSION}** or **Stop**.
`--finalize` derives the version from the merge and cannot honor a custom version.
If the repository needs a different version or a multi-component release that this
derivation cannot represent, stop before the first write and follow its own release procedure.

## Stamp Version Files (Step 2b)

Write the previewed version into every path in `release.version_files` **before** the promotion PR,
so each file becomes a witness of the derivation (S4/D12/D14).
For `--dry-run`, report the proposed stamps without writing them.

```bash
FILES=$(yq -r '.release.version_files[]?' .dev/stack.yml 2>/dev/null \
  || python3 -c 'import yaml;[print(p) for p in ((yaml.safe_load(open(".dev/stack.yml")).get("release") or {}).get("version_files") or [])]')
```

- `version_files: []` → **no-op, green.** 9 of 14 repos ship this — a file that does not exist cannot drift.
- A listed path that is **missing** → **REFUSE** (config lies).
- Otherwise replace the version token in each file with `${PREVIEW}` (bare `X.Y.Z`, no tag prefix
  inside the file), and stage it alongside the changelog in Step 4.

> The stamp is intentionally pre-merge, so between step 2b and the post-merge tag the file is
> *legitimately ahead* of the newest tag — `release-consistency` (push path) fails only when a file
> is **behind** its tag, never ahead (D14).

## Release surfaces (Steps 3–4 and finalize)

1. **Inventory.** Establish the previous production boundary and candidate SHA, version and delivery date from repository history, merged PRs and available deployment evidence. Inventory the actual delta between those boundaries, including direct commits and hotfixes, not only PRs merged to staging. If the production boundary is unknown, qualify it and establish the delivered scope before claiming coverage. Keep changes in staging that are not delivered in `Unreleased`.
2. **Discover.** Read the project's documentation and inventory its routes and release surfaces, then trace any user-facing changelog through its actual data source (RSC, API, static catalogue or other). Record the technical changelog and rendered-source paths. If a catalogue exists, update it; do not create a separate third journal. If the project uses minor-version pages as its rendered source, update the existing minor page or create the next minor page following that project's convention. Do not assume `docs/changelog/vX-Y.md` is rendered. When the inventory establishes absence of a secondary public surface, record **N/A** with the inspected sources and rationale in summary, PR and finalize; the technical changelog remains mandatory. Never create a new interface or journal just to satisfy this gate. Failed reads or uncertain discovery are not proof of absence: stop and resolve them.
3. **Prepare applicable surfaces in the candidate before freeze, review, CI and smoke.** Update the technical changelog for the delivered delta and, when a user-facing source exists, include every change useful to users there, filtered of internal-only detail and written in the project's language. Both must agree on version, date and delivered scope; preserve the project's editorial format and stable historical context. Before publishing the candidate, verify the version derivation, exact technical release section and applicable public notes against the intended delta. Record the paths or sourced N/A and evidence mapping the inventory to the entries in the promotion summary and PR checklist. A newly tagged release uses its exact version and date.
4. **Finalize gate.** Before finalize consent, read the mandatory technical changelog and any discovered user-facing source from the promotion merge SHA, not the current worktree; verify the expected release and inventory coverage, or substantiate N/A from that SHA. If a required surface is absent, incomplete or cannot be verified, stop and use the repository's correction procedure. Never rewrite a historical tag or mutate anything before consent. This editorial gate is separate from the version derivation and witness warnings.
5. **Delivery proof.** Tag and GitHub Release are not evidence of deployment. After an authorized deploy, verify any actual production changelog surface authenticated if required: actual entries and version anchor, plus referenced media if present. Record dated evidence linked to the deployment; do not declare delivery complete without synchronized applicable notes and that proof, or the sourced N/A. Respect the repository's deployment and authorization procedure.

For an out-of-train hotfix or delivery without a new tag, follow the repository's hotfix procedure: record a dated correction under the existing version in all applicable surfaces, preserving its original date. Do not invent a version, tag or publication, or rerun finalize for that correction. This is not an additional `/promote` route.

## Commit release surfaces to staging (Step 4)

Stage the applicable discovered paths and any version files using the repository's
`AGENTS.md`/`CLAUDE.md` conventions; use a Conventional Commit subject such as
`chore(release): add $VERSION changelog` where compatible. Commit to staging,
not main, so the applicable surfaces are included in the staging→main PR. Respect
the operator's authorization and the project's branch protection.
