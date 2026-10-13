# Oh My Pi (OMP) install

Roxabi plugins load on [Oh My Pi](https://github.com/can1357/oh-my-pi) via `.omp-plugin/marketplace.json` and per-plugin `package.json` `omp.extensions`.

## Add the marketplace

```bash
omp plugin marketplace add Roxabi/roxabi-plugins
```

Local checkout — repo root, not the catalog file:

```bash
omp plugin marketplace add /path/to/roxabi-plugins
```

## Install

```bash
omp plugin install omp-build@roxabi-marketplace
omp plugin install issue-triage@roxabi-marketplace
```

`omp-build` registers four user-only commands:

| Command | What it does |
|---------|--------------|
| `/feature` | One OMP feature — frame → GitHub issue → worktree → implement → bounded review/fix → land |
| `/promote` | Promote staging→main — pre-flight, version, changelog, PR, tag |
| `/cleanup` | Clean merged branches, worktrees and remotes after verification |
| `/ci-watch` | Watch every check on a PR head, then the merge, until the script deadline |

`registerCommand` is the user-only slash-command lane. Other skills resolve via `skill://` when their plugin is linked.

## Safety hooks

`plugins/omp-build/omp/index.ts` registers:

- Blocks bare `bun test` (use `bun run test` / Vitest)
- Principal-branch freeze (pre) on high-traffic `git switch` / `checkout` forms
- Security scan on `write` and OMP `edit` hashline payloads (fail-open on very large payloads)

Guards no-op unless a project contract file exists: `.dev/stack.yml` or `.dev/dev-core.yml`. Missing contract → one stderr warning per cwd, then silent no-op. `.claude/stack.yml` is not a contract.

No post-bash nudge (OMP would treat it as a user turn). No format hook (v1). Escape: `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1`.

## Paths

Bundled files: `skill://<skill>/<file>`.
`registerCommand` dumps `SKILL.md` as a fallback until marketplace install exposes `/skill:<name>`.
Legacy `$CLAUDE_PLUGIN_ROOT` / `$CLAUDE_SKILL_DIR` in skill bodies are expanded at dump time.
