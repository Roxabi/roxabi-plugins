# github-setup

Connect a project to a GitHub Project V2 board — labels, branch protection, workspace registration.

## Why

dev-core skills use GitHub Project fields (Status, Size, Priority) to track and display issue state. `/github-setup` creates or detects the project board, creates all required fields and labels, applies branch protection rules, migrates orphaned issues to the board, and registers the project in the shared workspace — so all skills have the configuration they need.

## Usage

```
/github-setup           Connect to GitHub (skips already-configured items)
/github-setup --force   Re-run all steps
```

Triggers: `"github setup"` | `"setup github project"` | `"connect github board"` | `"setup project board"`

## Phases

**Phase 1 — Auto-discover** — runs `init.ts discover` to find existing projects, fields, labels, branch protection, and Vercel config.

- **Project board** — auto-selects if one exists; creates new board if none (Technical or Company type); refreshes field IDs.
- **Labels** — detects missing type/area labels; offers to create all, type only, area only, or skip.
- **Branch protection** — applies protection rules on `main` and `staging` (required `ci` check, strict up-to-date); creates `PR_Main` ruleset.
- **Vercel** (optional) — configures Vercel token/project if detected.
- **Issue migration** — adds orphaned open issues to the board.

**Phase 2 — Confirm values** — displays the full configuration table; allows editing individual fields before writing.

**Phase 3 — Write config** — writes `.claude/dev-core.yml` (gitignored); runs scaffold script for `.env` and `.env.example`; installs `roxabi` shim at `~/.local/bin/roxabi`.

**Phase 4 — Workspace registration** — registers the project in the shared `workspace.json`; scans for other dev-core-configured repos on the filesystem and offers to bulk-register them.

## Safety

- Never overwrites `.claude/dev-core.yml` or `.env` without `--force` or confirmation
- Both files are always added to `.gitignore`
- Never stores secrets in `.env.example`

## Hub Enroll (opt-in, cross-repo taxonomy)

Part of the issue-taxonomy migration ([spec 119](../../../../artifacts/specs/119-issue-taxonomy-migration-spec.mdx), [issue #120](https://github.com/Roxabi/roxabi-plugins/issues/120)).

```bash
github-setup --hub-enroll
# or targeted:
bun plugins/dev-core/skills/init/init.ts hub-enroll --repo Roxabi/<repo>
```

Enrolls a repo into the `Roxabi Hub` Project V2:
- Verifies the 10 org-level Issue Types exist (bootstrap prereq).
- Pushes the auto-add-to-project workflow (`.github/workflows/hub-add.yml`).
- Checks `M0`/`M1`/`M2` milestones — **warns if missing**; does not seed (run `make milestones-sync` separately).

> Milestone seeding is a hard dependency on the external `milestones-sync` helper (out of scope here). Enrollment logs gaps but never mutates milestones.

See [`references/issue-taxonomy.md`](../../references/issue-taxonomy.md) for the cross-repo field contract.
