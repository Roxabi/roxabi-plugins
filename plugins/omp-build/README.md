# omp-build

OMP-only cycle: grill → validate spec → plan → impl → PR → review (≤2) → `reviewed` → watch merge.

Not a Claude/Grok factory — does not invoke host `/dev` or dev-core Skill() children.

## Install

OMP marketplace — catalogued in `.omp-plugin/marketplace.json` only (OMP-only plugin, absent from the Claude Code catalog).

```bash
omp plugin marketplace add Roxabi/roxabi-plugins   # once per machine
omp plugin marketplace update roxabi-marketplace   # after a catalog change lands
omp plugin install omp-build@roxabi-marketplace
ln -sfn ~/.omp/plugins/node_modules/omp-build/scripts/omp-wt.sh ~/.local/bin/omp-wt
```

**Then arm the surfaces.** With the `claude-plugins` provider disabled, a marketplace install loads only `package.json#omp.extensions` — `skills/` and `agents/` stay dark, because the realpath filter that hides marketplace roots lives in the *installed* lane that both `omp-plugins` (skills/commands/hooks) and the agents gate read. Add the stable `node_modules` symlink to `extensions:` in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/plugins/node_modules/omp-build
```

Then **restart** the OMP session — agents and extension modules are not picked up by `/reload-plugins`.

Keep this package **legacy**: no `plugin.json` at the package root. With one, `agent-plugins` unions the cache directory and the `node_modules` symlink as two distinct path strings and loads every skill twice.

### Local authoring (link)

Alternative to the catalog install, from a checkout of `roxabi-plugins` (monorepo subdir layout):

```bash
# from repo root
omp plugin link ./plugins/omp-build
ln -sfn "$(pwd)/plugins/omp-build/scripts/omp-wt.sh" ~/.local/bin/omp-wt
```

Requires `package.json` with an `omp` key. `omp.extensions` is the in-process lane — this plugin ships `./omp/index.ts` there (see [Guards](#guards)).

Verify:

```bash
omp plugin doctor    # expect plugin:omp-build (link lane; a marketplace install has no plugin:* line)
omp plugin list      # npm Plugins → omp-build@0.1.0
```

Either way `/build` loads `skills/build/` from `~/.omp/plugins/node_modules/omp-build/`. Do **not** copy `SKILL.md` into `~/.omp/agent/skills/` — that shadows the plugin. `omp-wt` uses the script that symlink points at.

### After you change the plugin

| Change | Pick up |
|---|---|
| `skills/`, `commands/`, MCP config | `/reload-plugins` |
| `hooks/`, `omp.extensions`, **new/changed `agents/*.md`** | **restart** OMP session |

Symlinking into `~/.omp/agent/agents/` is not supported — use `link` (or the catalog install armed by `extensions:`) + restart.

## Launch

From a **clean** principal, fetched: **staging** if it exists, else `main`/`master`.

```bash
omp-wt 42                         # GitHub issue
omp-wt -s 60                      # Spark — client from origin (silex#176), else config
omp-wt -s 60 -c metalyde          # Spark, override client
omp-wt -s https://spark.gosilex.com/silex/developpement/cmt…  # Spark URL
omp-wt                            # prompt: GH # | spark URL | spark:<client>#N | subject
```

stderr is the log (`omp-wt: …`). Spark `{error:…}` is fatal even when `spark.sh` exits 0. A numeric `-s N` with no client (`-c`, `slug#N`, origin by-repo, or spark config) exits 1 instead of fetching the wrong ticket.


Creates ω (`<type>/<N>-<slug>` via `resolveNames`) and `omp --cwd` there. Then `/build`:

1. Grill + you type `validated` (parent turn — not `run()`)
2. `run()` = plan → impl → PR → review (≤2) → label `reviewed` → watch until merge

Skip grill when the spec is already `status: validated`.

## Slash commands

| Command | Lane |
|---|---|
| `/feature` | `omp/index.ts` → `registerCommand('feature')`, in-process. Dumps `skills/feature/SKILL.md` |

Slash-only, on the one lane there is: `registerCommand` is the user lane,
`registerTool` is the LLM one, and the model cannot reach a command — that is the
whole property, and it is sufficient. The skill body's `disable-model-invocation`
is **not** a second gate: omp normalises it to `hide`, which omits the skill from
the prompt listing while `skill://feature` and `/skill:feature` still reach it
(omp 18.2.9). Requires a **restart** (extension module), not `/reload-plugins`.

`/feature` from the Principal creates ω, installs it, prints `omp --cwd <ω>` and
stops — the in-session cwd hop is not extension-facing (ADR-020 §3), and the
relaunch names ω's **directory**, never `/wt`: that command mints a fresh branch
in `~/.omp/wt/…` instead of entering the worktree just built. Inside ω with no
ticket it frames: grill → spec → tickets through `issue-triage`, then stops at the
frontier. Mode 2 (implement → review → land) is #494; `/build` carries it until
then.

## Guards

The plugin arms its guard chain **in-process**, through `omp.extensions` → `omp/index.ts`. It intercepts `tool_call` and refuses, before the tool runs:

| Tool | Refusal |
|---|---|
| `bash` | bare `bun test` (`bun run test` passes) |
| `bash` | `git switch`/`checkout` off `staging\|main\|master` **in the principal worktree** — escape hatch `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1` |
| `write`, `edit` | content matching the hardcoded-secret / SQL-injection / command-injection table |

The scan **fails open** above `SECURITY_SCAN_MAX_BYTES` (256 KB): a payload larger than the ceiling is not scanned at all. Once `dev-core` is uninstalled there is no second layer behind this one.

Guards are **off** unless the project declares the host-neutral contract (`.dev/stack.yml` or `.dev/dev-core.yml`); without it the interceptor is a no-op and warns once per cwd.

`omp/guards.ts`, `hooks/`, `agents/R-*` (except `R-advisor`) and `skills/shared/` are a **frozen snapshot** (ADR-020): omp-build resolves nothing through a sibling plugin at runtime, so it stays installable on its own. The snapshot is not resynced.

`skills/shared/` holds `lib.sh` (base-branch / worktree helpers, sourced as `. "$SCRIPT_DIR/../shared/lib.sh"`) and its `artifact-classify.ts` closure. No `references/` directory travels: the one reference a snapshotted agent cited is inlined into `R-architect` itself, because a `${CLAUDE_PLUGIN_ROOT}` token only expands in SKILL.md bodies — never in an agent body, and never at all in this plugin. `skills/dev-review/SKILL.md` Phase 1 is `lib.sh`'s first in-plugin caller (`detect_base_branch`); `cleanup` (#495) is the other one still to land.

> **Known caveat, this slice only.** While both this plugin and `dev-core` are installed, both interceptors see the same `tool_call` and reach the same verdict — the snapshots are byte-identical and read the same escape hatch. Expect the refusal, and the no-contract warning, to be reported **once per plugin**: each extension owns a private warned-cwd set, so neither dedupes the other.

## Agents

OMP task agents in `agents/`. **Two** are OMP-native (`R-advisor`, `elon` — `model: "@advisor"`, typed `output:` schema); **five** are frozen snapshots of `dev-core` review agents (ADR-020 decision 7). Every agent carries an explicit `tools:` pin: the snapshots arrived with their posture stated in prose only, and a read-only floor whose read-only-ness is unenforced is not a control.

| Agent | Posture |
|---|---|
| `R-adversarial` | Review floor. Red-team the priced claim: bypass, fleet-regression, operational, assumption-kill, vacuous-guard, scope-attack — **plus the OWASP lens**, because `R-security-auditor` is not spawned by default. Sibling-drop applies only to siblings actually in the `Spawned roster:`; absent roster ⇒ it owns everything. |
| `R-advisor` | Constructive second opinion. Strengthen, don't attack. Not the session WATCHDOG (`advisor.enabled`, `/advisor`, `WATCHDOG.yml`). |
| `R-architect` | System design + cross-cutting consistency. Two modes: normal (ADRs, tier) and axial (read-only drift review against the unique `axial: true` ADR; the procedure is inlined at the end of the agent file). Pinned read-only here — omp-build spawns it as a review role. |
| `R-devops` | Config, CI/CD, Docker, dependencies. Review mode by default — findings only, no config edits. |
| `R-tester` | Test generation + coverage + negative-test judgement. The executable falsify oracle is **cut** on OMP (ADR-020 decision 8): no producer, so no `oracle_ok`. |
| `R-security-auditor` | OWASP inventory. Spawned on `path_hit` (Δ ∩ auth/secrets/crypto), not by default. |
| `elon` | The Algorithm. Read-only tools. Inventory (NAMED/UNNAMED/BINDING) → delete (named add-back) → simplify → accelerate → automate last. Process only, not Musk roleplay. |

Spawn: `task` `{ agent: "R-adversarial" | "R-advisor" | "R-architect" | "R-devops" | "R-tester" | "R-security-auditor" | "elon", ... }`. Read from `agents/` of whichever package root is in the extension lane — the `link` symlink, or the marketplace install's `node_modules` symlink once it is listed in `extensions:`. `R-advisor` is a spawnable task agent, **not** the session WATCHDOG (`advisor.enabled`).

`R-frontend-dev`, `R-backend-dev`, `R-fixer`, `R-doc-writer` and `R-product-lead` are deliberately absent (ADR-020 decision 7): their concerns fall to the `R-adversarial` floor through the sibling-drop rule.

## Skills

| Skill | Lane |
|---|---|
| `build` | `/build`, then `workflow.js` |
| `feature` | `/feature` (registered command) |
| `dev-review` | model-invocable · the five-role review panel |
| `fix` | model-invocable · applies the findings, inline |

`dev-review` and `fix` are the #492 snapshot of dev-core's `dev-review`/`fix` pair, cut to this plugin's roster: five dispatchable roles, `R-tester` armed by changed-test evidence alone, and every finding applied in-session. They read their own bundled files through `skill://dev-review/<file>`. `lib.sh` is the exception: it sits one level up, in a non-skill directory, and `skill://` rejects `..`, so `dev-review` Phase 1 traverses from `$SKILL_DIR` instead. **Nothing in this plugin exports `SKILL_DIR`** — only `/feature` prints a skill directory (`omp/index.ts`) — so that fence asserts the variable (`${SKILL_DIR:?…}`) and stops when it is unset, rather than sourcing `/../shared/lib.sh` and detecting a base branch against nothing.

**The names are deliberately not `R-dev-review`/`R-fix`.** Skill discovery dedups by `name` across every provider, first-wins: while `dev-core` is still installed next to this plugin, identical names would make one of the two workflows shadow the other silently — and the shadowed one is the panel the operator thinks is running. Snapshotted agent bodies still call the workflow `/R-dev-review` in prose; that is a label, not an invocation, and the dispatch prompt in `skills/dev-review/SKILL.md` is the contract they actually obey.
