# Stack Configuration Reference

Let: α := agent(s) | σ := stack.yml field

`stack.yml` makes dev-core agents project-agnostic. Agents reference `{backend.path}`, `{commands.test}`, etc. from `.dev/stack.yml`, which they Read straight from the repo **first** — before resolving any `{field}`, ¬lazily when one field happens to be needed.

**The contract is read, never imported.** No `@`-import line may be added to `AGENTS.md` (or any host context file) to inject it: `@`-prefixed imports resolve harness-by-harness, while the `.dev/` contract must stay readable by any harness. Agents and tooling open `.dev/stack.yml` themselves. ¬∃ `.dev/stack.yml` → agents output:
> "`.dev/stack.yml` not found — run `/init` to generate the file, or `/R-dev-checkup` to diagnose."

## Field Reference

### Top-Level

| σ | Type | α | Purpose |
|---|------|---|---------|
| `schema_version` | string | checkup | Schema compat check |
| `runtime` | string | — | Runtime ID (informational) |
| `package_manager` | string | R-security-auditor, R-devops | Pkg mgr for audit/lockfile |

### `backend.*`

| σ | α | Purpose |
|---|---|---------|
| `backend.framework` | R-backend-dev | Framework conventions |
| `backend.orm` | R-backend-dev | ORM conventions (migrations, chain mocking) |
| `backend.path` | R-backend-dev, R-fixer, R-tester | Backend app root |

### `frontend.*`

| σ | α | Purpose |
|---|---|---------|
| `frontend.framework` | R-frontend-dev | Framework conventions |
| `frontend.path` | R-frontend-dev, R-fixer | Frontend app root |
| `frontend.ui_package` | R-frontend-dev | Shared UI import path |
| `frontend.ui_src` | R-frontend-dev | UI component exports dir |

### `shared.*`

| σ | α | Purpose |
|---|---|---------|
| `shared.types` | R-backend-dev, R-frontend-dev | Shared TS types path |
| `shared.ui` | R-frontend-dev, R-backend-dev (boundary) | Shared UI path |
| `shared.config` | R-devops, R-backend-dev (boundary) | Shared config path |

### `build.*`

| σ | α | Purpose |
|---|---|---------|
| `build.orchestrator` | R-devops | Build orchestrator name |
| `build.orchestrator_config` | R-devops | Orchestrator config file |
| `build.formatter` | R-devops | Formatter name |
| `build.formatter_config` | R-devops | Formatter config file |
| `build.formatter_fix_cmd` | R-devops | Auto-fix formatting cmd |

### `testing.*`

| σ | α | Purpose |
|---|---|---------|
| `testing.unit` | R-tester | Unit test framework |
| `testing.e2e` | R-tester | E2E test framework |

### `hooks.*`

| σ | α | Purpose |
|---|---|---------|
| `hooks.tool` | ci-setup, release-setup | Hook runner selection: `auto` \| `lefthook` \| `pre-commit` \| `husky` \| `none`. `auto` → infers from runtime (Python → pre-commit, else lefthook). Consumed by `/R-ci-setup` (installs pre-commit hooks) and `/R-release-setup` (wires commit-msg hook). |

### `deploy.*`

| σ | α | Purpose |
|---|---|---------|
| `deploy.platform` | R-devops | Deploy platform name |
| `deploy.secrets_cmd` | R-devops | Add-secrets cmd |

### `docs.*`

| σ | α | Purpose |
|---|---|---------|
| `docs.framework` | R-doc-writer | Optional site framework (`none` default; Fumadocs removed) |
| `docs.path` | R-doc-writer | Root doc dir |
| `docs.format` | R-doc-writer (informational) | Fixed `md` write path; field optional/compat only. Legacy `.mdx` read-only |

### `quality_gates.*`

Opt-in code-hygiene gates. Consumer: `skills/release-setup/cookbooks/quality-gates.md` (Phase 4.5 of `/R-release-setup`, steps N1–N8) — it copies `tools/check_file_length.sh`, `tools/check_folder_size.sh`, `tools/check_lib.sh` into the project, regenerates `tools/qg.conf` from σ, and merges hooks into `.pre-commit-config.yaml`. Nothing here is read at agent time; σ only feeds the generator, and the gates then run from `tools/qg.conf`.

Block-level gating: `quality_gates` absent → all gates off · sub-block absent ∨ `enabled: false` → that gate off. Generator entry guard (N1/N1a) also skips the whole block when `runtime ∉ {python, node}`, or when `schema_version` is **missing or** `< "1.0"` — a stack with no `schema_version` installs nothing, it is not treated as current. The version test is a string-literal comparison on the `major.minor` prefix (cookbook N1a), not semver parsing. `folder_size` and `import_layers` are Python-only — skipped on `runtime: node` whatever their `enabled:`.

Only the three sub-blocks below exist. No other key is implemented. Planned, not yet emitted by any generator: `secrets` (with a `tool: trufflehog|gitleaks` discriminator), `license`, `file_length.packages`, `custom_hooks`, `dup_test` — see #251; each is documented here only by the slice that ships its emitter.

#### `quality_gates.file_length`

| σ | Type | Req | Default (key **absent**) | Generator effect |
|---|------|-----|---------|------------------|
| `enabled` | bool | yes | — (absent = off) | `false` → gate skipped; never uninstalls an installed gate (D6) |
| `max_lines` | int | no | `300` | → `QG_FILE_MAX` in `tools/qg.conf` (N4a); script falls back to `300` when qg.conf is absent |
| `metric` | `raw` \| `sloc` | no | `raw` | → `QG_FILE_METRIC`; with `runtime` derives `QG_FILE_EXTS` + `QG_FILE_COUNTER` (`raw`→`wc`, `sloc`→`radon` python / `sloc-npm` node). `sloc` on Python also triggers `uv add --group dev "radon>=6.0"` (N4b) — the lower bound is load-bearing: radon 6.x ships the `raw -j` JSON format the gate parses |
| `globs` | list\<str\> | no | — | **None.** No code reads it — see Surprises |
| `exemptions_file` | path | no | `tools/file_exemptions.txt` | → `QG_FILE_EXEMPTIONS`; N4 creates the file with a header comment if absent, never overwrites |

Hook merged by N7: `id: check-file-length`, `entry: tools/check_file_length.sh`, `types: [python]`, `pass_filenames: false`, no `stages:` (runs on commit).

#### `quality_gates.folder_size`

| σ | Type | Req | Default (key **absent**) | Generator effect |
|---|------|-----|---------|------------------|
| `enabled` | bool | yes | — (absent = off) | Same semantics as `file_length.enabled` |
| `max_files` | int | no | `12` | → `QG_FOLDER_MAX`; script fallback `12`. Counted per directory, non-recursive (`find -maxdepth 1 -name "*.py"`) |
| `globs` | list\<str\> | no | — | **None.** No code reads it |
| `exemptions_file` | path | no | `tools/folder_exemptions.txt` | → `QG_FOLDER_EXEMPTIONS`; header seeded by N4, never overwritten |

Hook merged by N7: `id: check-folder-size`, `entry: tools/check_folder_size.sh`, `pass_filenames: false`, no `stages:`.

#### `quality_gates.import_layers`

| σ | Type | Req | Default (key **absent**) | Generator effect |
|---|------|-----|---------|------------------|
| `enabled` | bool | yes | — (absent = off) | `true` → N5 `uv add --group dev "import-linter>=2.0,<3.0"`, N6 `.importlinter` scaffold, N7 hook |
| `stage` | `pre-commit` \| `pre-push` | no | `pre-push` | → hook `stages: [<stage>]`, **applied on insert only** — see Surprises |
| `config` | path | no | — | **None.** N6 hardcodes `.importlinter`; an existing file is never rewritten, even under `--force` (D1) |

Hook merged by N7: `id: import-layers`, `entry: uv run lint-imports`, `language: system`, `pass_filenames: false`.

#### Exemption file format

`<path>  # <N> lines|files — <issue-url> <rationale>`. `<N>` is a **local cap**, not a bypass: the path fails the gate once it exceeds `N`. Matching is exact on the first whitespace field (`check_lib.sh` `is_exempt`), so a directory exemption does not cover its files.

**The cap parser reads too much of the line.** `exempt_cap` takes the leftmost match of `# *[0-9]+ *<unit>` *anywhere* after the path. Two consequences, not one: a second count later in the rationale is ignored (the leftmost wins), **and a line meant to carry no cap at all can acquire one** — an issue reference followed by the unit word is a match. `src/big.py  # full bypass, see #12 lines of generated code below` parses as a cap of `12`, and a 400-line file then fails with `exceeds declared exemption cap of 12`. Drop the unit word from rationales that carry an issue ref (`# see #12 for the refactor` is inert), or state the cap you actually mean.

**Back-compat is narrower than "no `# <N> <unit>` = full bypass".** A capless line is a full bypass only while it holds **at most two whitespace fields**. `assert_exempt_no_spaces` aborts on any non-comment line with `NF > 2` whose `$2` does not start with `#`, and it cannot tell a space-bearing path from a legacy two-field line with a rationale appended. Observed against a 400-line file at cap 300:

| Exemption line | rc |
|---|---|
| `src/big.py` | 0 (bypass) |
| `src/big.py https://github.com/…/546` | 0 (bypass) |
| `src/big.py https://github.com/…/546 legacy` | **1** — `ERROR: tools/file_exemptions.txt: exemption path contains spaces — paths with spaces are not supported` |
| `src/big.py  # 400 lines — #546 legacy` | 0 (capped form; `$2` is `#`, rationale free-form) |

That abort is an `exit 1` from a *sourced* helper, so it terminates the whole gate run before a single file is scanned: in the same repro a second, non-exempt 500-line file was never reported, and the only message names a cause (a path with spaces) that is not present. Trigger likelihood is high — `stack.yml.example:93` still advertises the legacy shape as `<path> <issue-url> (space-separated)`, so appending "why" to such a line lands exactly here. Rules that hold: keep capless lines to two fields, or add a `# <N> <unit>` cap and write the rationale after it.

#### Surprises — verified against the generator, not the example

- **`globs` is decorative.** `qg.conf` seeds `QG_FILE_ROOT` / `QG_FOLDER_ROOT` to a hardcoded `src/`; no step reads `globs`. Code outside `src/` is never scanned, and a repo with no `src/` **hard-fails** (`require_scan_root` exits 1, "A missing target is not a pass"). Escape hatches are env-only: `QG_FILE_ROOT=<dir>` / `QG_FOLDER_ROOT=<dir>`, or `QG_FILE_LENGTH_DISABLE=1` / `QG_FOLDER_SIZE_DISABLE=1` (`1|true|yes`).
- **A present-but-empty key is not an absent key.** Every default in the tables above is the *absent-key* default. The generator extracts with `(… or {}).get('<key>', <default>)` (N4a), so `max_lines:` written with nothing after it parses as YAML `null` and `.get` returns that `null` — not `300`. It serialises as `: "${QG_FILE_MAX:=None}"`, and the gate's `[ "$LINES" -gt "$MAX" ]` then fails as a *shell* error rather than a violation: `[: None: integer expression expected` on stderr, **exit 0**. A 400-line file passes under a nominal cap of 300; observed identically on the folder gate (16 files under a nominal 12 → exit 0). Because the merged hooks are `pass_filenames: false`, pre-commit shows output only on failure, so the green run hides the warning. Blanking a path key is the opposite failure: `exemptions_file:` empty points the gate at a file literally named `None`, so every exemption is ignored and the gate gets *stricter*; `metric:` empty is inert (anything ≠ `sloc` is raw). Write a value or omit the key — "leave it at the default" must be expressed by deleting the line.
- **The hook merge upserts by `id`.** N7 keys on `id`; an unknown id is inserted after `id: typecheck`, a known one is left alone (`--force` re-stamps `entry:` only). It never removes a hook, so **renaming a hook id leaves the old hook behind** and the project runs both.
- **`stage:` only lands at install.** `stages:` is preserved on every re-run including `--force` (D4). Flipping `stage` in σ after install changes nothing — edit `.pre-commit-config.yaml` by hand.
- **`raw` metric scans `*.py` only.** In `raw` mode (the default) the file gate ignores `QG_FILE_EXTS` and runs `find "$FIND_ROOT" -name "*.py"`. A `runtime: node` project on default `metric` gates zero files while reporting success; the merged hook additionally carries `types: [python]`. Node needs `metric: sloc`.
- **`tools/qg.conf` is generated, not owned.** It is rewritten from σ on every install and every `--force`; hand edits are lost. Precedence is env > `qg.conf` > script default (keys are emitted as `: "${VAR:=…}"`; an exported *empty* value counts as unset).
- **`enabled: false` never uninstalls** (D6). Scripts, hooks, exemption files and `.importlinter` all stay; removal is manual.
- **PyYAML rewrites `.pre-commit-config.yaml`** — comments in that file are stripped on every merge (N7 warns).

#### Divergences between sources (as of this writing)

| Source A | Source B | Disagreement |
|---|---|---|
| `stack.yml.example:87` "Python-only — stack-setup skips this section when runtime != python", plus four more Python-only claims: `dev-core/README.md:142`, `release-setup/README.md:32` ("triggers when `runtime == python`") and `:40` ("Non-Python runtimes exit Phase 4.5 immediately"), `release-setup/SKILL.md:111–116` (every `tools/` artifact annotated "python + quality_gates only") | `stack-setup/SKILL.md:254` conditional rules (`runtime ∈ {python, node, bun}`) ∧ cookbook N1 (`runtime ∈ {python, node}`) | Five sources say Python-only, two say wider. Node is installable per N1 yet documented everywhere as not applicable; `runtime: bun` gets a `quality_gates:` block stack-setup wrote and the generator refuses to install. Sharpest case: `release-setup/README.md:32` — the README of the very skill that dispatches N1, contradicting its own cookbook |
| `stack.yml.example` `quality_gates.file_length` (no `metric`) | cookbook N4a + `stack-setup/SKILL.md` template | `metric` is implemented and templated but missing from the shipped example |
| `stack.yml.example:93` exemption comment `<path> <issue-url> (space-separated)` | cookbook N4 + `check_lib.sh` (`exempt_cap`, `assert_exempt_no_spaces`) | Example omits the `# <N> lines\|files` local cap, the part that can fail the gate — and the two-field shape it does advertise aborts the entire run as soon as a third field (a rationale) is appended |
| `stack.yml.example` / `stack-setup` templates carry `globs` and `import_layers.config` | cookbook N4a/N6 | Both keys are inert; the example implies configurable scan roots and config paths that do not exist |

### `commands.*`

| σ | α | Purpose |
|---|---|---------|
| `commands.dev` | — | Start dev server |
| `commands.build` | R-devops | Build all packages |
| `commands.test` | R-tester, R-fixer | Run test suite |
| `commands.test:falsify` | implement, test, validate | Optional mechanical falsify gate. YAML key must be quoted (`"test:falsify"`). Absent → `/R-validate --full` ⏭; `/R-dev-implement` 6b falls back to git-stash |
| `commands.lint` | R-fixer, R-devops | Run linter |
| `commands.typecheck` | R-fixer, R-devops | Run type checker |
| `commands.format` | R-devops | Auto-format |
| `commands.install` | R-devops | Install deps |

### `artifacts.*`

| σ | α | Purpose |
|---|---|---------|
| `artifacts.analyses` | R-product-lead, R-architect | Analysis docs dir |
| `artifacts.specs` | R-product-lead | Specs dir |
| `artifacts.frames` | R-product-lead | Frames dir |
| `artifacts.plans` | R-product-lead, R-architect | Plans dir |

### `review.*`

Consumer: `plugins/dev-core/skills/dev-review/roster.sh` (the deterministic roster oracle — single-chunk spawns `agents[]`; multi-chunk spawns each `chunk_agents[i]`).

| σ | α | Purpose |
|---|---|---------|
| `review.roster.max_agents` | dev-review | Total cap per chunk, including the `R-adversarial` floor. Default `3` = floor + at most two specialists. Explicit `always` roles survive; when forced roles exceed the cap, the effective cap is raised with a warning |
| `review.roster.agents.<agent>` | dev-review | Per-agent override: `default` \| `always` \| `never`. Active roles: `R-adversarial`, `R-security-auditor`, `R-tester`, `R-frontend-dev`, `R-backend-dev`, `R-devops`, `R-architect`. `R-adversarial` is an immutable floor (`never` warns and is ignored) |

Selection is deterministic and evidence-ranked inside each chunk: security paths and axial `R-architect`
mode are strongest; the dominant FE/BE domain is chosen by changed-file count; then infra routes to
`R-devops` at every tier, oracle-false routes to `R-tester`, conservative structural signals route to
`R-architect`, and the secondary domain follows. Structural signals are explicit architecture/ADR paths,
workspace graph files (`nx.json`, `turbo.json[c]`, `pnpm-workspace.yaml`, dependency-cruiser config),
or a diff crossing configured frontend and backend boundaries. Plain `F-full` source does not route
to `R-architect`.

Deprecated compatibility keys remain parseable and always warn:

| Legacy key | Compatibility behavior |
|---|---|
| `review.roster.max_agents_review` | Default-off (`0`) flattened cap retained only for old configs; prefer the per-chunk `max_agents` model |
| `review.roster.verify_below_confidence` | Ignored. Findings are retained after deterministic deduplication; confidence alone never removes one |
| `review.roster.recall_min_delta` | Ignored. `/R-dev-review` controls the fresh isolated recall worker |
| `review.roster.agents.R-axial-adr-review` | Deprecated mode-specific override applies only to `R-architect` axial mode and warns; canonical `R-architect: always|never` has global precedence |
| `review.roster.agents.R-recall` | Deprecated override is ignored and warns; recall is no longer a roster manifest |
| `review.roster.agents.R-finding-verifier` | Deprecated override is ignored and warns; the verifier phase was removed |

### `standards.*`

| σ | α | Purpose |
|---|---|---------|
| `standards.backend` | R-backend-dev, R-fixer, R-tester | Backend patterns |
| `standards.frontend` | R-frontend-dev, R-fixer, R-tester | Frontend patterns + TS gotchas |
| `standards.testing` | R-tester, R-fixer, R-backend-dev, R-frontend-dev | Test patterns, mocking |
| `standards.code_review` | R-fixer | Code review conventions |
| `standards.architecture` | R-architect | ADRs + diagrams |
| `standards.configuration` | R-devops | Config conventions |
| `standards.deployment` | R-devops | Deploy procedures |
| `standards.troubleshooting` | R-devops | Troubleshooting guides |
| `standards.issue_management` | R-product-lead | Issue triage/mgmt |
| `standards.dev_process` | R-architect | Dev process tiers/phases |
| `standards.contributing` | R-doc-writer, R-architect | Contributing + doc format |

## Required Fields

`/R-dev-checkup` flags absence of: `schema_version`, `backend.path`, `frontend.path`, `commands.test`, `commands.lint`, `commands.typecheck`, `standards.testing`, `standards.backend`, `standards.frontend`

## Writing Good Standards Docs

Each `standards.*` → doc agents read before implementing. Framework-specific knowledge keeps agent bodies generic.

### `standards.testing` template

```markdown
## Framework Setup
- Test runner config (vitest.config.ts / jest.config.ts / etc.)
- Setup files and global teardown
- Environment selection (node vs jsdom)

## Import Conventions
- ESM extension requirements (e.g., `.js` extensions for Node ESM)
- Explicit imports from test framework (no globals)

## Controller / Handler Tests
- How to instantiate controllers directly
- Mock reset pattern (beforeEach)
- Decorator metadata verification

## Service / Repository Tests
- DB/ORM chain mocking pattern
- Factory helper shape (createMockDb, etc.)
- Multi-call sequences

## Exception Patterns
- Exception class shape
- Where exceptions live in the project

## Frontend Component Tests
- Provider wrapper pattern
- Query cache seeding vs real fetch
```

### `standards.backend` template

```markdown
## Module Structure
- One module per domain feature
- Controller → HTTP only, logic → services
- Domain exceptions: no framework imports

## ORM Conventions
- Migration directory and naming
- Chain patterns for queries

## API Conventions
- Request validation
- Response shapes
- Error codes
```

## Example Configs

### NestJS + TanStack Start

```yaml
schema_version: "1.0"
runtime: bun
package_manager: bun
backend:
  framework: nestjs
  orm: drizzle
  path: apps/api
frontend:
  framework: tanstack-start
  path: apps/web
  ui_package: "@repo/ui"
  ui_src: packages/ui/src
```

### Next.js + Express

```yaml
schema_version: "1.0"
runtime: node
package_manager: npm
backend:
  framework: express
  orm: prisma
  path: server
frontend:
  framework: nextjs
  path: app
  ui_package: "@/components/ui"
  ui_src: components/ui
```

### SvelteKit + Rails

```yaml
schema_version: "1.0"
runtime: node
package_manager: pnpm
backend:
  framework: rails
  orm: none
  path: backend
frontend:
  framework: sveltekit
  path: frontend
  ui_package: "$lib/components"
  ui_src: src/lib/components
```

## Missing Field Behavior

| Missing σ | Affected α | Behavior |
|-----------|-----------|---------|
| `backend.path` | R-backend-dev, R-fixer | Hard-stop error w/ /init fix |
| `frontend.path` | R-frontend-dev, R-fixer | Hard-stop error w/ /init fix |
| `standards.testing` | R-tester, R-fixer | Falls back to generic guidance |
| `commands.test` | R-tester, R-fixer | Cannot run tests; reports missing config |
| `standards.backend` | R-backend-dev | Skips framework-specific conventions |
| `standards.frontend` | R-frontend-dev | Skips TS gotchas + UI library patterns |
| `artifacts.*` | R-product-lead | Cannot write artifacts; reports path missing |
| `review.roster.*` | dev-review | Active default: `max_agents` 3 and every agent `default`. Compatibility-only `max_agents_review` defaults to `0`. Deprecated `verify_below_confidence` and `recall_min_delta` are ignored |
| `quality_gates.*` | release-setup | Never an error. Block absent → all gates off; sub-block absent → that gate off; per-key **absent** → generator default (`max_lines` 300, `max_files` 12, `metric` raw, `stage` pre-push, canonical exemption paths). A key **present with no value** is not absent: it reaches `qg.conf` as `None` and, for the numeric caps, turns the gate green on everything — see Surprises |
