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

Requires `package.json` with `"omp": {}` (empty object is enough; `omp.extensions` is for in-process factories only).

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

## Agents

OMP task agents in `agents/` (`model: "@advisor"`):

| Agent | Posture |
|---|---|
| `adversarial` | Red-team. Kill the priced claim. |
| `advisor` | Constructive second opinion. Strengthen, don't attack. Not the session WATCHDOG. |
| `elon` | The Algorithm. Read-only tools. Inventory (NAMED/UNNAMED/BINDING) → delete (named add-back) → simplify → accelerate → automate last. Process only, not Musk roleplay. |

Spawn: `task` `{ agent: "adversarial" | "advisor" | "elon", ... }`. Read from `agents/` of whichever package root is in the extension lane — the `link` symlink, or the marketplace install's `node_modules` symlink once it is listed in `extensions:`. Not the session WATCHDOG (`advisor.enabled`).
