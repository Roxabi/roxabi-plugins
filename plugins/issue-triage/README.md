# issue-triage

Triage and create GitHub issues — size, priority, lane, and type labels plus blocked-by / parent-child relations. Labels and native GitHub relations only; no Projects V2.

## Why

Raw GitHub issues lack structure. This plugin adds Size (XS→XL), Priority (P0→P3), Lane, and Type via native labels and issue relations so the backlog is plannable and downstream skills (`/dev`, `/plan`) get the metadata they need. Optional companion of [dev-core](../dev-core/README.md).

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install issue-triage
```

OMP:

```bash
omp plugin install issue-triage@roxabi-marketplace
# or from a checkout:
omp plugin link ./plugins/issue-triage
```

Requires authenticated `gh` (`gh auth status`).

OMP `/issue-triage` dumps the skill with `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` expanded (extension; restart after install). Claude substitutes those placeholders at skill load.

## Usage

Triggers: `"triage"` | `"create issue"` | `"set size"` | `"set priority"` | `"blocked by"` | `"set parent"` | `"child of"` | `"sub-issue"` | `"file an issue"` | `"log a bug"` | `"open an issue"` | `"file a bug"` | `"add issue"` | `"new issue"` | `"set lane"` | `"set type"`.

```
/issue-triage list                           List all open issues (tree view)
/issue-triage list --untriaged               Show issues missing Size or Priority
/issue-triage set 42 --size M --priority High
/issue-triage set 91 --blocked-by 117
/issue-triage set 164 --parent 163
/issue-triage create --title "..." --size S --priority Medium --type feat --lane b --parent 163
```

`create` accepts the same field flags as `set`: `--size`, `--priority`, `--lane`, `--type`, plus `--parent`, `--add-child`, `--blocked-by`, `--blocks`.

Cross-repo: prefix `GITHUB_REPO=<owner/repo>`, and use fully-qualified `OWNER/REPO#N` refs when that env is set.

## Size

| Size | Description |
|------|-------------|
| **XS** | Trivial, < 1 hour |
| **S** | Small, < 4 hours |
| **M** | Medium, 1–2 days |
| **L** | Large, 3–5 days |
| **XL** | Very large, > 1 week |

Canonical labels written: `size:S` / `size:F-lite` / `size:F-full`. Legacy `XS/S/M/L/XL` are accepted as `--size` and alias to those (`M`→`F-lite`, `L`/`XL`→`F-full`).

## Priority

| Priority | Action |
|----------|--------|
| **Urgent** (P0) | Do immediately |
| **High** (P1) | Do this sprint |
| **Medium** (P2) | Plan for next sprint |
| **Low** (P3) | Backlog |

## License

MIT
