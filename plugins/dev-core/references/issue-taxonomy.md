# Issue Taxonomy — Roxabi SSoT

Single fact source for issue metadata across every Roxabi repo (`lyra`, `voiceCLI`, `roxabi-vault`, `imageCLI`, `roxabi-forge`, `roxabi-intel`, `roxabi-idna`, `roxabi-plugins`).

**Who reads this:** `dev-core:issue-triage` · `dev-core:github-setup` · `dev-core:issues` · `lyra/scripts/dep-graph` · `lyra/scripts/corpus` · future `roxabi-dashboard`.

---

## 1. Field set

| Field | GH object | Values | Scope | Reader(s) | Writer(s) |
|---|---|---|---|---|---|
| **Lane** | Project V2 single_select | `a1` `a2` `a3` `b` `c1` `c2` `c3` `d` `e` `f` `g` `h` `i` `j` `k` `l` `m` `n` `o` `standalone` | Hub project (spans all repos) | dep-graph · dashboard | issue-triage |
| **Priority** | Project V2 single_select | `P0` `P1` `P2` `P3` | Hub project | dashboard · issues | issue-triage |
| **Size** | Project V2 single_select | `S` `F-lite` `F-full` | Hub project | dep-graph · issues | issue-triage |
| **Status** | Project V2 built-in | `Todo` `Ready` `In Progress` `Blocked` `Done` | Hub project | dep-graph · dashboard | issue-triage · auto-derived |
| **Milestone** | Native GH milestone | `M0` `M1` `M2` `…` | **Per-repo** (names kept consistent) | dep-graph (band headers) | issue-triage · milestones-sync |
| **Issue Type** | Org-level native | Current (pre-Phase 1): `Bug` `Feature` `Epic` `Chore` `Research` → Target (post-Phase 1): `feat` `fix` `refactor` `docs` `test` `chore` `ci` `perf` `epic` `research` | Org (applies to every repo) | dep-graph · dashboard | issue-triage · github-setup (org bootstrap) |
| **Assignees** | Native | users | Repo (GH native) | dashboard | manual · issue-triage |

**Native relations (no field needed):**
- **Sub-issues** — parent/child, cross-org since 2025-09 · REST `…/sub_issues` · `…/parent`
- **blocked_by / blocking** — cross-repo, public preview · REST `…/dependencies/*`

---

## 2. Cross-repo behavior

| Field | Cross-repo? | Consequence |
|---|---|---|
| Lane · Priority · Size · Status | ✅ one hub project | set once, read everywhere |
| Issue Type | ✅ org-level | defined once, every repo inherits |
| Milestone | ❌ per-repo | `M3` must exist in every repo; keep names consistent; `make milestones-sync` helper bootstraps |
| Assignees | ❌ per-repo | no cross-repo user list, but user identity is org-wide |
| Sub-issues | ✅ cross-org | |
| blocked_by / blocking | ✅ cross-repo | `addBlockedBy` hits EMU restrictions cross-org; not a concern for Roxabi |

---

## 3. What was removed

| Removed | Replaced by | Reason |
|---|---|---|
| Label `graph:lane/*` | `Lane` project field | mutable, driftable, per-repo namespace |
| Label `size:*` | `Size` project field | same |
| Label `graph:standalone` | `Lane = standalone` option | one fact, one place |
| Label `graph:defer` | Bump `Milestone` to later `M*` | "defer" was scheduling in disguise |
| `layout.json meta.label_prefix` | — | no label discovery anymore |
| `layout.json lanes[].epic` (lane-defining) | Lanes are field-defined; epics are issues with sub-issues | epic no longer anchors a lane |
| Label-drift audit (`make dep-graph audit`) | **Repurpose** to validate project-field coverage | no labels to audit |

**Kept as domain tags (per-repo, unchanged):** `deploy` · `ci` · `security` · `docs` · `performance` · etc. These are technical domain markers, not taxonomy.

---

## 4. Disambiguation

| Word | Meaning |
|---|---|
| `lane` (lowercase, layout.json key) | Dep-graph swim-lane grouping, `lanes[]` array in layout |
| `Lane` (Titlecase) | The GH Project V2 custom field — the SSoT for lane assignment |
| "swim-lane" | The rendered visual concept in dep-graph HTML |
| `epic` (lowercase, layout.json deprecated) | Old lane-anchor slot — **gone** post-migration |
| `Epic` (Titlecase) | GH org-level Issue Type; any issue with sub-issues marked as such |
| `Milestone` (GH native) | The field used for roadmap phase bands on dep-graph |
| `Phase` | Not used. If you hear "phase", they mean Milestone. |

---

## 5. Plugin contracts

### `dev-core:issue-triage`
- **Writes:** Lane · Priority · Size · Status · Milestone · Issue Type · Assignees · sub-issue parent · blocked_by
- **Inputs:** user triage prompt + issue context
- **Mutates:** GH Project V2 items (field values) + native issue fields + native relations
- **Never writes:** raw labels for taxonomy (domain tags only)
- **Phase 3 dual-write override:** during dual-write, also writes `graph:lane/*`, `size:*`, and Conventional Commits title prefix alongside hub fields.
- "Never writes labels for taxonomy" is the **post-Phase 6** invariant; pre-cutover, the override above applies.

### `dev-core:github-setup`
- **One-shot org bootstrap:**
  - Create/verify org-level Issue Types (post-Phase 1 target set: feat/fix/refactor/docs/test/chore/ci/perf/epic/research — pre-migration names Bug/Feature/Chore/Research get renamed; Epic retained as-is)
  - Create/verify hub Project V2 + 4 custom fields (Lane/Priority/Size + Status options)
- **Per-repo bootstrap (opt-in flag `--hub-enroll`):**
  - Add repo to hub project via auto-add workflow
  - Seed milestones (`M0…MN`) with consistent names
  - Does **not** auto-enroll experimental or archived repos

### `dev-core:issues` (and `dep-graph`)
- **Reads:** single paginated GraphQL query on `organization.projectV2.items` — one call hydrates `fieldValues` (Lane/Priority/Size/Status), `content.milestone`, `content.blockedBy`, `content.blocking`, `content.parent`, `content.subIssues`, `content.issueType`. All fields GA — no preview APIs in the hot path.
- **Caches:** `gh.json` (dep-graph) / `~/.roxabi/corpus.db` (corpus)
- **Fallback:** if hub project API fails, render last good cache with a stale-banner

---

## 6. dep-graph fetch contract

**One paginated GraphQL query** on `organization.projectV2.items` hydrates every fact. No REST fan-out, no preview APIs.

| Fact | Path in GraphQL response |
|---|---|
| **Discovery** | `organization.projectV2(number: N).items.nodes[]` (paginated) |
| **Lane / Priority / Size** | `item.fieldValues.nodes` → `ProjectV2ItemFieldSingleSelectValue.field.name + .name` |
| **Status** | same node type, `field.name == "Status"`; auto-derived from issue state (CLOSED → Done) |
| **Milestone / band headers** | `item.content.milestone.title` |
| **Edges (blocked_by/blocking)** | `item.content.blockedBy.nodes[]` + `item.content.blocking.nodes[]` — each node carries `repository.nameWithOwner`, cross-repo native |
| **Parent/child** | `item.content.parent` + `item.content.subIssues.nodes[]` |
| **Epic marker** | `item.content.issueType.name == "Epic"` |

Shape verified end-to-end by spike on `Roxabi/lyra#717` in hub project #23 (2026-04-21). Keep `gh.json` as a versioned cache for rate-limit resilience and offline render, shape-assert first non-empty response, fail fast on schema mismatch.

**Superseded REST paths** (no longer needed): `/repos/{r}/issues/{n}` per issue · `/repos/{r}/issues/{n}/dependencies/blocked_by` · `/repos/{r}/issues/{n}/dependencies/blocking` · `gh issue list --label graph:lane/*`.

---

## 7. Migration order (reference)

Fact source for the migration spec. Do not execute from this doc.

```
0. Publish SSoT + link from consumer SKILL.md files    (discoverability)
1. Create hub project + fields + Issue Types           (setup)
2. Dual-write: issue-triage writes labels AND fields   (safety window)
3. Backfill: script label → field per repo             (migrate data)
4. Flip dep-graph fetch to read fields                 (cutover)
5. Stop writing labels; drop graph:* labels per repo   (cleanup)
6. Repurpose audit to validate field coverage          (guardrail)
7. Roll out to new repos via --hub-enroll              (default)
```

---

## 8. Anti-patterns

- ❌ Creating a new `graph:*` label for taxonomy — use a project field
- ❌ Using GH milestone for "cross-repo roadmap phase" without sync — milestones are per-repo
- ❌ Using a custom "Phase" field **and** milestones — pick one (milestones win)
- ❌ Setting `Lane` via label — the field is the fact source
- ❌ `dev-core:github-setup` auto-enrolling every new org repo — opt-in only
- ❌ Reading field values without caching — always populate `gh.json` (dep-graph) / `corpus.db` (corpus) first
- ❌ Using preview APIs in the hot read path — all fields consumed by dep-graph and `dev-core:issues` must be GA
