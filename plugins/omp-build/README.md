# omp-build

OMP-only cycle: grill → validate spec → plan → impl → PR → review (≤2) → `reviewed` → watch merge.

Not a Claude/Grok factory — does not invoke host `/dev` or dev-core Skill() children.

## Install

```bash
omp plugin marketplace add Roxabi/roxabi-plugins   # or the local checkout
omp plugin install omp-build@roxabi-marketplace
ln -sfn /path/to/roxabi-plugins/plugins/omp-build/scripts/omp-wt.sh ~/.local/bin/omp-wt
```

After a change lands on the marketplace source:

```bash
omp plugin marketplace update roxabi-marketplace
omp plugin upgrade omp-build@roxabi-marketplace
```

`/build` imports `workflow.js` from the installed plugin (`~/.omp/plugins/node_modules/omp-build/`). Do not put `SKILL.md` under `~/.omp/agent/skills/` — that shadows the plugin. `omp-wt` still uses the repo script via PATH.

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

Spawn: `task` `{ agent: "adversarial" | "advisor", ... }`.

With `claude-plugins` off, these files do not load from a marketplace install. Symlink them into `~/.omp/agent/agents/` (user discovery, no provider gate).
