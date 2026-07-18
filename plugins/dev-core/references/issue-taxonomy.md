# Issue Taxonomy — Roxabi SSoT

Single fact source for issue metadata across every Roxabi repo.

**Model:** issues-only / labels-first. Issue metadata lives on **GitHub labels** + **native issue fields** (Issue Type, Milestone, Assignees, sub-issues, dependencies), scoped per-repo. There is **no required project board** — reads are repo-centric.

> **ProjectV2 board path removed (#268).** The hub Project V2 board integration — `config-helpers.ts` field IDs, `addToProject`, `isProjectConfigured()`, and the `migrate-*` scripts — was deleted from the code. Every write is now a label or native field; there is no board path. See §7 for the migration history that produced this issues-only model.

**Who reads this:** `roxabi-issues:issue-triage` (writer) · label/type bootstrap via `/dev-init:init` / org tooling · `lyra/scripts/dep-graph` · `roxabi-live` worker (repo-centric GraphQL readers).

---

## 1. Field set

| Field | Storage | Values (canonical → label) | Scope | Writer |
|---|---|---|---|---|
| **Priority** | label | `P0→P0-critical` · `P1→P1-high` · `P2→P2-medium` · `P3→P3-low` | Per-repo | issue-triage |
| **Size** | label | `S→size:S` · `F-lite→size:F-lite` · `F-full→size:F-full` | Per-repo | issue-triage |
| **Lane** | label | `<lane>→graph:lane/<lane>` (20 canonical lanes, see below) | Per-repo | issue-triage |
| **Status** | label | `status:Backlog` · `status:Analysis` · `status:Specs` · `status:In Progress` · `status:Review` · `status:Done` | Per-repo | issue-triage (`create` only — see note) |
| **Issue Type** | org-level native | `feat` `fix` `refactor` `docs` `test` `chore` `ci` `perf` `epic` `research` | Org (every repo inherits) | issue-triage (`updateIssueIssueType`) · github-setup (org bootstrap) |
| **Milestone** | native GH milestone | `M0` `M1` `M2` `…` | **Per-repo** (names kept consistent) | issue-triage · milestones-sync |
| **Assignees** | native | users | Per-repo (identity is org-wide) | manual · issue-triage |

**Canonical lanes** (`config-helpers.ts:DEFAULT_LANE_OPTIONS`): `a1 a2 a3 b c1 c2 c3 d e f g h i j k l m n o standalone`.

**Status note:** in the issues-only model, status is largely the native issue **open/closed** state. `issue-triage set` deliberately does **not** write `status:*` labels (dropped in #262 — redundant/noisy). `issue-triage create` does seed a `status:*` label.

**Native relations (no field needed):**
- **Sub-issues** — parent/child, cross-org · REST `…/sub_issues` · `…/parent`
- **blocked_by / blocking** — cross-repo · REST `…/dependencies/*`

---

## 2. Cross-repo behavior

| Field | Cross-repo? | Consequence |
|---|---|---|
| Priority · Size · Lane · Status | ❌ per-repo labels | set per repo; consistency is convention, not enforced |
| Issue Type | ✅ org-level | defined once, every repo inherits |
| Milestone | ❌ per-repo | `M3` must exist in every repo; keep names consistent; `milestones-sync` helper bootstraps |
| Assignees | ❌ per-repo | no cross-repo user list, but identity is org-wide |
| Sub-issues | ✅ cross-org | native |
| blocked_by / blocking | ✅ cross-repo | `addBlockedBy` hits EMU restrictions cross-org; not a concern for Roxabi |
| **Issue create target** | ⚙️ env/config | The CREATE target is cwd-bound by default. Override: set `GITHUB_REPO=owner/repo` (or `github_repo` in dev-core config). Caveat: retargets the whole invocation — bare `#N` refs resolve against the override; always use `OWNER/REPO#N`. |

---

## 3. Disambiguation

| Word | Meaning |
|---|---|
| `lane` (lowercase, layout.json key) | Dep-graph swim-lane grouping, `lanes[]` array in layout |
| `Lane` / `graph:lane/*` | The lane label — the SSoT for lane assignment |
| "swim-lane" | The rendered visual concept in dep-graph HTML |
| `Epic` | GH org-level Issue Type; any issue with sub-issues marked as such |
| `Milestone` (GH native) | The field used for roadmap phase bands on dep-graph |
| `Phase` | Not used. If you hear "phase", they mean Milestone. |

---

## 4. Plugin contracts

### `dev-core:issue-triage`
- **Writes:** Priority · Size · Lane · Status (create) labels · Issue Type (native) · Milestone · Assignees · sub-issue parent · blocked_by
- **Inputs:** user triage prompt + issue context
- **Mutates:** GitHub labels + native issue fields + native relations
- **Stale-label hygiene:** each `sync*Label` adds the target label and removes all other labels in the same set (`*_LABELS_SET`), so a field has exactly one value.
- **Domain tags untouched:** `deploy` · `ci` · `security` · `docs` · `performance` etc. are technical markers, not taxonomy — issue-triage never strips them.

### `dev-core:github-setup`
- **Org bootstrap:** create/verify org-level Issue Types (`feat fix refactor docs test chore ci perf epic research`).
- **Per-repo bootstrap:** seed standard labels (priority/size/lane/status) + milestones (`M0…MN`) with consistent names. Does **not** auto-enroll experimental or archived repos.

### Readers (`dep-graph`, `roxabi-live` worker)
- **Reads:** repo-centric — per-repo issues via GraphQL/REST, hydrating labels (priority/size/lane/status), `milestone`, `blockedBy`, `blocking`, `parent`, `subIssues`, `issueType`.
- **Caches:** `gh.json` (dep-graph) · D1 / corpus (roxabi-live).
- **Fallback:** on API failure, render last good cache with a stale-banner.

---

## 5. Anti-patterns

- ❌ Writing taxonomy as a free-form label outside the canonical sets — use the `sync*Label` maps so stale values are pruned
- ❌ Relying on `status:*` labels for lifecycle state on a normal repo — status is the native open/closed state; `set` does not write `status:*`
- ❌ Using GH milestone for "cross-repo roadmap phase" without sync — milestones are per-repo
- ❌ Using a custom "Phase" field **and** milestones — pick one (milestones win)
- ❌ `dev-core:github-setup` auto-enrolling every new org repo — opt-in only
- ❌ Reading issues without caching — always populate `gh.json` / D1 first

---

## 6. Legacy ProjectV2 board path — removed (#268)

The optional, `isProjectConfigured()`-gated board path was deleted in #268. `issue-triage` no longer mirrors fields to `ProjectV2ItemFieldSingleSelectValue` items; the `config-helpers.ts` field IDs, `GH_PROJECT_ID`, and `addToProject` are gone; and the `migrate-*` bridge scripts were removed. The issues-only model (§1) is the only path. See §7 for the history.

---

## 7. History (reference, do not execute)

The taxonomy moved **label → ProjectV2 field → label**:

```
v1  Labels-first (graph:lane/*, size:*, P*-…)              original
v2  Migrate to hub Project V2 single-select fields          board era
        (dual-write → backfill → flip readers → drop labels)
v3  Revert to labels-first / repo-centric; drop ProjectV2   #262 #263 #264 (2026-06-08)
        from the read path and from the issues-only model
```

v3 is current and complete. The board code was fully removed in #268 (the §6 path no longer exists); `dev-core:issues` (the board-era list/dashboard reader) was removed in #265.
