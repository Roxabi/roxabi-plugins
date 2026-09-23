---
title: "ADR-019: Plugin-owned falsify oracle (markdown is a report)"
description: >
  Executable run-falsify is the sole falsify oracle for τ≠S gates.
  Isolation = copy at HEAD plus the working-tree overlay. Proven record = falsify.json.
  Gate boolean = oracle_ok from --verify re-exec. parse-falsify demoted to ungated lint.
status: accepted
normative: true
date: 2026-08-21
superseded_in_part_by: [ADR-020]
---

> Implements Roxabi/roxabi-plugins#417 Shape 1 (V1).
> **Narrowed 2026-09-21 by ADR-020** — this ADR governs the Claude/Grok product only.
> The OMP product does not absorb `R-pr`, so it has no oracle producer and no tester
> falsify gate.

## Context

#416 shipped `parse-falsify.sh` and a thinner `/dev-review` roster. Gates still
measured **document shape** (`falsify_ok` from markdown tokens). Forged or
LLM-authored evidence could clear `/pr` and skip the tester without an executable
fail-under-absent → pass-under-restore of mapped unit/fast-integration tests.

## Decision

1. **Oracle ownership** — `plugins/dev-core/skills/pr/run-falsify.sh` is the sole
   executable falsify oracle for τ≠S. Consumer `test:falsify` / LLM `git stash` are
   not alternate oracles unless they exec this helper without swallowing non-zero.

2. **Isolation** — canonical API = **copy at HEAD**, with the working tree
   overlaid on top. Repo-global `git stash` is not the public API. Trap-backed
   in-place backup may exist only as an impl detail with restore guarantee.

   2a. **The overlay is intentional, and it changes what `oracle_ok` attests.**
   `snapshot_repo` runs `git archive HEAD` and then copies **the working tree**
   over it — `git ls-files -co --exclude-standard` is *cached* plus *others*,
   i.e. every tracked file plus every untracked non-ignored one, not only the
   modified ones. HEAD therefore survives only for paths absent from the working
   tree. The implement-time call requires exactly that: `/R-dev-implement`
   Step 6b runs the oracle on work that is `git add`-ed and deliberately **not**
   committed, so a HEAD-pure snapshot would prove nothing about the code just
   written. `oracle_ok` attests **the working tree as it stands at run time**,
   never the PR's HEAD.

   The snapshot also carries a **linked dependency surface** (#541): installed
   dependencies are gitignored, so the overlay alone never holds them and a
   `{commands.test}` such as `bun run test` would exit 127. Each entry of a
   `node_modules` next to a carried `package.json` is symlinked into a real
   directory of the snapshot; an entry that is itself a link into the repo (a
   workspace or `file:` package) is re-pointed at the snapshot's copy, so a
   deleted source is really gone. What a run creates at the top of `node_modules`
   stays in the snapshot, but writes *inside* an existing entry reach the real
   tree — vitest's `node_modules/.vite` results cache is the everyday case. A
   `.venv` is never linked: `uv run` re-syncs an editable install *through* a
   linked venv and rewrites the real one; a uv contract builds the snapshot's own
   venv instead. Every other ignored path (`.env`, other caches) stays out. The
   runner unsets the git location variables (`GIT_DIR`, `GIT_INDEX_FILE`, …) on
   entry, so the snapshot is not a git repository even under a git hook: a test
   that shells out to git inside it cannot be a falsify row.

   2b. **Named residual — the gate-time call inherits that, and the record
   cannot fix it.** `/R-pr` refuse and `/R-dev-review` tester-skip read
   `oracle_ok` from a `--verify` re-exec on the same snapshot path, so against a
   dirty tree they proceed on code that is not in the PR. Note what a closure
   may **not** assume: `--verify` writes its fresh record to a throwaway and
   never rewrites `artifacts/reviews/{N}-falsify.json`, and the only value that
   reaches a gate is the `oracle_ok=` line on stdout — so a new JSON field is
   invisible to the reader that matters, and the committed artifact carries the
   implement-time run, which is dirty by construction. Closing this means
   emitting the tree state on the same stdout contract the gates already parse.
   That is a code change, tracked as #539, not this ADR's to make. Until then a
   gate-time `oracle_ok` is only as strong as the cleanliness of the tree it ran
   in.

   2c. **The gate no longer takes its command from the artifact (#541) — the
   PR still decides what a green row proves, and its tests still run.**
   `verify()` rebuilds its map from the committed
   `artifacts/reviews/{N}-falsify.json`, and until #541 it executed each row's
   `test_cmd` through `bash -lc`, so a PR author chose what ran on a reviewer's
   machine. Now a row's `test_cmd` must be exactly the contract's test command
   followed by plain relative paths, each a file the snapshot carries, and the
   runner executes that argv — with no shell anywhere in the runner. The
   contract's test command is `.dev/stack.yml` `commands.test_file` when present
   (a command that runs exactly the files named after it — what turbo root
   scripts and `unittest discover` cannot do), else `commands.test`. It is read
   by a deliberately small subset of YAML, not a YAML parser: a single-line plain
   or quoted value of a direct child of the one top-level `commands:`, plain
   ASCII words with no `VAR=` prefix. Whatever that subset cannot read the way
   YAML would — a duplicate key, a multi-line or unclosed value, tabs,
   non-ASCII — is refused, never guessed. A non-conforming row, a malformed row,
   or a source that is absolute or has an empty, `.` or `..` segment is refused
   before **any** row runs, with `oracle_reason=refused-test-cmd:row<i>`. Test
   paths are an allowlist, because they reach argv; sources are not, because
   they are only hashed and deleted inside the snapshot. The reason names the
   first refused row of the check that failed: shape is checked before the
   snapshot is built, and presence in the snapshot after it. A direct run
   (`/R-dev-implement` Step 6b, `--map`) names every row that check refused, with
   its `sc_id`, on stderr, which `/R-pr` gather-state discards. A contract that
   is unusable refuses everything (`missing-test-command` /
   `unsupported-test-command`), and `/R-pr` routes those to `.dev/stack.yml`, not
   to Step 6b. A source that still resolves outside the snapshot (a committed
   symlink) fails its row as `source-escape` instead of being deleted, and any
   input that makes the runner raise ends as `oracle_ok=false
   oracle_reason=runner-error` — never as a missing verdict.

   What the artifact still decides. First, the trailing tokens are arguments to
   the runner, and the only check on them is that each one names a file the
   snapshot carries. Which files exist is up to the PR, and the runner reads each
   token however it wants. Under `make test` a committed file named `publish`
   selects the `publish` target, and under pytest a token can import a non-test
   module or collect a `.rst` file's doctests. Second, `sources` and the test
   files. A row is proven when the test fails with its sources absent and passes
   with them present, and nothing checks what the test asserts or which files the
   row names as sources. A row whose source is its own test file, the runner
   script, or a file the test only loads therefore verifies green. The row shape
   cannot close either gap. Both belong to #569 (row-result classification and
   trust gating).

   **Named residual.** Everything the re-exec runs is still PR content: the
   contract is read from the checked-out tree, `commands.test` is typically
   indirect (`bun run test` → `package.json`), the test files are PR code that
   runs as the reviewer — including writing to the stdout the gates read
   `oracle_ok` from — and the row picks the runner's arguments. `--verify` on an
   untrusted checkout is therefore as dangerous as running the contract's test
   command, with arguments the PR chose, on the PR's tree, and its `oracle_ok` is
   advisory. Gating the re-exec on the PR author's trust — and pricing what a
   green row proves — is tracked as #569.

3. **Proven record** — `artifacts/reviews/{N}-falsify.json` (`schema_version: "1"`)
   holds `head`, `runner_id`, `rows[]`, `oracle_ok`. Markdown `*-falsify.md` is an
   optional render, never a gate input.

4. **Gate boolean graph** — `/R-pr` refuse and `/R-dev-review` tester-skip read
   only **`oracle_ok`** from `run-falsify --verify` (full re-exec of mapped rows),
   which §2b and §2c qualify: that boolean is about the tree the re-exec ran in,
   and on an untrusted checkout it is advisory (#569).
   Schema-parse of a pre-written green JSON alone → ¬`oracle_ok`.
   `falsify_ok` from `parse-falsify.sh` is removed from refuse/skip paths.
   `parse-falsify.sh` may remain as ungated markdown hygiene.

5. **Empty / all-exempt** — τ≠S with zero FAIL→PASS unit/FI rows (including
   all-exempt matrices) ⇒ `oracle_ok=false`.

6. **Roster — claim-axis is cut, not pending.** V1 keeps structural path triggers
   for architect/devops/security-auditor, and that is the settled posture.
   Recorded 2026-09-22 (#469): the earlier "claim-axis spawn is V2" wording read
   as a deferral, and HEAD has since accepted path-only as the posture rather
   than a stepping stone — `roster.ts` keys `gates['R-security-auditor']` off
   `path_hit` alone, `claims` is parsed and exposed but is not a spawn disjunct,
   and two tests pin it — cited by full path, because a bare filename here
   resolves to the wrong control (`plugins/omp-build/agents/__tests__/roster.test.ts`
   exists, tests the agent manifest, and mentions `R-security-auditor`, so a
   reader verifying a bare citation gets a plausible hit and stops):
   `plugins/dev-core/skills/dev-review/__tests__/skill-roster-parity.test.ts`
   ("keeps security path-only routing") and
   `plugins/dev-core/skills/dev-review/__tests__/roster.integration.test.ts`
   ("claim tags on non-security Δ do not spawn (cut)"). The omp-build snapshot
   carries the same two (#492). Claim-axis spawn will not ship unless it is
   separately repriced as its own decision.

## Consequences

- `/R-dev-implement` Step 6b, `/R-pr` gather-state, and `/R-dev-review` must call the helper.
- Kit/boilerplate can later invoke the same script; not an AC of #417 V1.
- Verify cost may run 2–3× (implement + pr + review); same-`head` session cache is
  optional later — never a receipt-only bypass.

## References

- Issue #417 · Spec `artifacts/specs/417-plugin-owned-falsify-runner-spec.md`
- Analysis Shape 1 · Frame `artifacts/frames/417-plugin-owned-falsify-runner-frame.md`
