# issue-triage

Triage and create GitHub issues — size, priority, lane, and type labels plus blocked-by / parent-child relations. Labels and native GitHub relations only; no Projects V2.

## Why

Raw GitHub issues lack structure. This plugin adds Size (S / F-lite / F-full), Priority (P0→P3), Lane, and Type via native labels and issue relations, so the backlog is plannable and a frontier query — "what is grabbable right now?" — is answerable from GitHub alone. It is the single writer of issue relations and tiers; the consuming project states how they are used, e.g. [`docs/agents/issue-tracker.md`](../../docs/agents/issue-tracker.md) in this repo.

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
/issue-triage set 42 --body-file path/to/body.md
/issue-triage set 42 --clear-body
/issue-triage set 91 --blocked-by 117
/issue-triage set 164 --parent 163
/issue-triage create --title "..." --size S --priority Medium --type feat --lane b --parent 163
```

`set --body` / `--body-file` replaces the issue body and prints `Body #N` or `Body owner/repo#N`. An empty body is refused; `--clear-body` is the only clear. A pull-request number rewrites the PR description (`PATCH /repos/{owner}/{repo}/issues/{n}`); `set` does not GET the target to refuse one.

Adopt a repository. `init` writes `docs/agents/issue-tracker.md` only when that file is absent, at the git toplevel. An existing contract is kept (`contract: keep-existing`) and is the label vocabulary: a `Label | Colour` table, or canonical names in the template list. A contract that does not parse prints `vocabulary: none parsed from docs/agents/issue-tracker.md` and exits non-zero. `--repo` other than the local repo is refused; owner/repo names are compared case-insensitively, so `Acme/product` is the local repo of an origin spelled `acme/product`. Missing labels are created in the contract's colours; an existing label is never recoloured, and a case mismatch is reported instead of created.

Run the `issue-triage` skill's CLI: `init [--dry-run] [--repo owner/repo] [--root checkout]`. `--root` selects the local contract's git toplevel for reading and writing; it does not change Bun's startup directory or select the GitHub repository. When starting in the trusted CLI directory, preserve the target separately with `GITHUB_REPO`. Without `--root`, contract lookup retains the current-directory behavior.

Contract-path confinement resolves every ancestor and final symlink. External physical contract destinations, non-directory ancestors, cycles and chains exceeding 40 symlink expansions are refused before GitHub or contract writes. Missing internal targets retain their full path and are created at the resolved physical destination. The original contract path is rechecked after creating its physical parent; this is not atomic protection against concurrent filesystem changes.

A trailing slash on an internal directory ancestor is allowed, including when that directory must be created. A final contract target ending in `/` or `/.` is directory-required and is refused: the contract must remain a usable file.

Internal relative targets remain usable when their spelling traverses the checkout's parent before returning inside. Containment is checked on the physical contract destination, not on an intermediate traversal position.

Symlink targets are read as bytes and accepted only when UTF-8 decoding preserves them exactly. A non-text target is refused before GitHub or contract writes rather than replaced by a different filename.

An existing final target must be a regular file. A special file such as a FIFO is refused before the synchronous contract read, including during `--dry-run`, rather than blocking until another process opens it.

`create` accepts the same field flags as `set`: `--size`, `--priority`, `--lane`, `--type`, plus `--parent`, `--add-child`, `--blocked-by`, `--blocks`.

Cross-repo: prefix `GITHUB_REPO=<owner/repo>`, and use fully-qualified `OWNER/REPO#N` refs when that env is set. Sibling deferral preserves the origin parent's full coordinate, even when another repository contains the same issue number. `set --rm-parent` resolves that actual parent and prints `RemovedParent=OWNER/REPO#N`; it never rebinds the parent's number to the subject repository. The shared lookup helper is `getParentRef`, returning the complete reference or `null`; the numeric-only helper was removed.

Filing from a checkout you do not trust (a PR under review): start Bun in this skill's directory with `--no-env-file`, the target in `GITHUB_REPO` (yours when exported, else the checkout's `origin` remote (`gh repo view` only when origin is absent; an origin that is not a github.com `owner/repo` remote (GitLab, a local path, extra path segments) is refused, credentials redacted, never replaced by `gh`'s answer), never the checkout's `.dev/dev-core.yml` pin) and absolute `--title-file` / `--body-file` paths. The Deferred Follow-Ups recipe requires the origin issue and a successful parent lookup before creating its sibling; an empty parent keeps both issues top-level. Mis-parent repair reuses that launcher, parent value and confirmed-read state in the same shell: a failed or unattempted lookup refuses before any repair mutation, and removal or restoration failure stops later writes. Bun reads `bunfig.toml` and `.env` from its startup directory, so a preload committed in the checkout would otherwise run first.

Startup separation assumes the resolved CLI and its directory are operator-trusted. A normal installed cache is separate from the candidate checkout; a development link into candidate-controlled source does not establish that trust boundary. This launcher is not a validator or sandbox for the CLI it resolves.

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

P1 fires on either of two triggers: the milestone in progress, or a shipped check that reports a pass when it should fail or stop. The full rubric is in the skill's Priority Guidelines; the consuming project's contract binds it to the repository.

## Maintenance

Keep literal harness placeholders intact when changing the OMP path-rewrite implementation; lint maintenance must not change expansion behavior. Publish OMP changes with matching, newer versions in `package.json` and `.omp-plugin/marketplace.json`; Claude's hash-keyed delivery is unchanged.

## Verification

Use CI's native package entrypoint for contract confinement and Linux process-lifetime checks:

```bash
bun run test \
  plugins/issue-triage/skills/issue-triage/__tests__/init-root.integration.test.ts \
  plugins/issue-triage/skills/issue-triage/__tests__/init.test.ts \
  plugins/issue-triage/skills/issue-triage/__tests__/runner-lifetime.integration.test.ts
```

The contract integration suite exercises the actual CLI and filesystem: internal chains and missing parents, external-target refusal, and simple, mutual and expanding cycles without GitHub mutations.

The lifetime suite starts real child processes, checks that owned descendants stop executing, and accepts a zombie independently of PID disappearance. Unexpected `/proc` read errors remain failures. Process checks use native child-process APIs rather than the test setup's Bun shim; a direct Bun invocation of Vitest is not a substitute for the CI entrypoint.

## License

MIT
