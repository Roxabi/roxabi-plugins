# omp-build

OMP-only cycle: grill → validate spec → plan → impl → PR → review (≤2) → `reviewed` → watch merge.

Not a Claude/Grok factory — does not invoke host `/dev` or dev-core Skill() children.

## Install

Not in the marketplace catalog — install by **link** from a checkout of `roxabi-plugins` (monorepo subdir layout).

```bash
# from repo root
omp plugin link ./plugins/omp-build
ln -sfn "$(pwd)/plugins/omp-build/scripts/omp-wt.sh" ~/.local/bin/omp-wt
```

Requires `package.json` with `"omp": {}` (empty object is enough; `omp.extensions` is for in-process factories only).

Verify:

```bash
omp plugin doctor    # expect plugin:omp-build
omp plugin list      # npm Plugins → omp-build@0.0.0
```

`/build` loads `skills/build/` from the linked package (`~/.omp/plugins/node_modules/omp-build/`). Do **not** copy `SKILL.md` into `~/.omp/agent/skills/` — that shadows the plugin. `omp-wt` uses the repo script via PATH.

### After you change the plugin

| Change | Pick up |
|---|---|
| `skills/`, `commands/`, MCP config | `/reload-plugins` |
| `hooks/`, `omp.extensions`, **new/changed `agents/*.md`** | **restart** OMP session |

Symlinking into `~/.omp/agent/agents/` is not supported — use `link` + restart.

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

## Agents

OMP task agents in `agents/` (`model: "@advisor"`):

| Agent | Posture |
|---|---|
| `adversarial` | Red-team. Kill the priced claim. |
| `advisor` | Constructive second opinion. Strengthen, don't attack. Not the session WATCHDOG. |
| `elon` | The Algorithm. Read-only tools. Inventory (NAMED/UNNAMED/BINDING) → delete (named add-back) → simplify → accelerate → automate last. Process only, not Musk roleplay. |

Spawn: `task` `{ agent: "adversarial" | "advisor" | "elon", ... }`. Loaded via `omp-plugins` from the linked package `agents/`. Not the session WATCHDOG (`advisor.enabled`).
