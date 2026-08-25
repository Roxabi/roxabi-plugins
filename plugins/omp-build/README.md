# omp-build

OMP-only cycle: grill → validate spec → plan → impl → PR → review (≤2) → `reviewed` → watch merge.

Not a Claude/Grok factory — does not invoke host `/dev` or dev-core Skill() children.

## Install

```bash
ln -sfn /path/to/roxabi-plugins/plugins/omp-build/skills/build ~/.omp/agent/skills/build
ln -sfn /path/to/roxabi-plugins/plugins/omp-build/scripts/omp-wt.sh ~/.local/bin/omp-wt
```

One copy of `workflow.js` (the repo). `/build` and `omp-wt` both use it.

## Launch

From a **clean** principal, fetched: **staging** if it exists, else `main`/`master`.

```bash
omp-wt 42                         # GitHub issue
omp-wt -s 60                      # Spark — client from origin (silex#176), else config
omp-wt -s 60 -c metalyde          # Spark, override client
omp-wt -s https://spark.gosilex.com/silex/developpement/cmt…  # Spark URL
omp-wt                            # prompt: GH # | spark URL | spark:<client>#N | subject
```

Creates ω (`<type>/<N>-<slug>` via `resolveNames`) and `omp --cwd` there. Then `/build`:

1. Grill + you type `validated` (parent turn — not `run()`)
2. `run()` = plan → impl → PR → review (≤2) → label `reviewed` → watch until merge

Skip grill when the spec is already `status: validated`.
