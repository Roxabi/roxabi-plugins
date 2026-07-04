---
name: compress
description: 'Compress agent/skill definitions using math/logic notation. Triggers: "compress" | "compress skill" | "compress agent" | "compress context" | "shorten this" | "make it formal" | "use formal notation" | "expand notation" | "lint notation" | "derive pattern from skills".'
version: 0.1.0
argument-hint: '[mode] [file path | glob | directory | plugin name]'
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Compress

Formal notation rewrite — reduce tokens, preserve semantics.

## Success

I := mode dispatched ∧ targets resolved ∧ per-section Δtokens reported ∧ (write → ledger row via S)

Let:
  μ      := mode ∈ {compress (default), derive, expand, lint, glossary}
  T      := resolved target files · N := |T|
  S      := `${CLAUDE_PLUGIN_ROOT}/scripts/count_tokens.py` — sole token counter ∧ sole ledger writer
  ref(μ) := `references/<μ>.md` next to this SKILL.md

## Entry

```
/compress file.md                  default mode, direct path
/compress plugins/*/agents/*.md    glob scope
/compress compress                 plugin name — discovered across both layouts
/compress lint <target>            mode lint — halts until references/lint.md ships
```

## Pipeline

| Phase | ID | Notes |
|-------|----|-------|
| 0 | dispatch | mode parse + mode-exists gate |
| 1 | scope | resolve T + read budget |
| 2 | analyze | pre-image `source_ref` + tokens_before via S |
| 3 | transform | apply ref(μ) rules |
| 4 | present | per-section Δtokens + user choice |
| 5 | write | verify + ledger append via S |

## Phase 0 — Dispatch

Parse the first token of `$ARGUMENTS`: ∈ μ set → mode; omitted → `compress`. Ambiguous (neither a mode nor a resolvable path/name) → ask "Mode or target?" (1–2 sentences), then dispatch. First token matching a mode always dispatches as mode — force scope interpretation with a path (e.g. `./lint`).
Mode valid ⟺ ref(μ) ∃. ∄ → halt: `mode "<μ>" not yet implemented` — ¬improvise a mode body. Today only `references/compress.md` ships → `derive|expand|lint|glossary` all halt.

## Phase 1 — Scope

Remaining args = scope: file path | glob | directory | plugin name. Paths and globs resolve as-is; a bare name is discovered across both layouts:
- marketplace: `plugins/<name>/skills/*/SKILL.md` ∧ `plugins/<name>/agents/*.md`
- legacy fallback: `.claude/skills/<name>/SKILL.md` ∨ `.claude/agents/<name>.md`

N = 0 → halt, list every attempted resolution. Name matches in both layouts → present choice between the candidates.

**Read budget:** N = 1 → proceed. N > 1 → exactly ONE batched present-choice (file list + size estimates) before any read beyond discovery. Cap N ≤ 10 per run; larger scope → chunk into sequential ≤10 runs, chunk plan stated up front. Results land as one consolidated diff with per-file opt-out.

## Phase 2 — Analyze

∀ f ∈ T, before any write:
- `source_ref(f)` := `git hash-object "<f>"` (fallback: `sha256sum`) — pre-image hash, captured now, carried to Phase 5
- tokens_before per section: `python3 S count "<f>"` — note the report's `method:` ∈ {anthropic-api, tiktoken-proxy, estimate}; also capture `agreement`/`calibration` when present
- total < ~200 tokens → warn (cheap pre-check heuristic), proceed only if confirmed
- mark compression candidates per ref(μ)

## Phase 3 — Transform

Read ref(μ), apply its rules. Compress mode body: symbols legend, transform rules R1–R10, ¬compress list, measured rationale — all in `references/compress.md`.

## Phase 4 — Present

Per-section table: `section | tokens_before | tokens_after | Δtokens` (candidate text re-counted via S). Flag every `Δtokens ≈ 0` section — prefer the readable form there. Never present char% or line% as savings — tokens are the only metric.
→ present choice **Yes** | **Preview** | **Adjust**. Preview → show full text, re-ask. Adjust → apply feedback, re-present.

## Phase 5 — Write

Write file. Verify: frontmatter intact ∧ `$ARGUMENTS` intact ∧ safety rules intact ∧ ¬semantic loss. Re-count via `python3 S count "<f>"` → tokens_after.
One ledger row per completed target, appended ONLY via S — generate one run ULID (`python3 S new-ulid`) and share it as `--correlation` across every row of a multi-file run:

```
python3 S append --target "<f>" --mode <μ> --source-ref <hash> \
  --tokens-before <n> --tokens-after <n> --correlation <run-ulid> \
  --sections-json '[{"name": "…", "tokens_before": …, "tokens_after": …}]' --method <m> \
  --proxy-agreement <bool> --calibration "<line>"  # when captured in Phase 2
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Agent (¬skill) | Preserve agent frontmatter |
| User rejects at Phase 4 | Halt |
| Mode-specific (already formal, no repeated concepts, mixed prose + code) | Per ref(μ) |

## Safety

1. ¬semantic loss — every condition, rule, edge case survives
2. ¬modify frontmatter
3. ¬delete safety rules
4. ¬auto-write — preview first
5. Preserve `$ARGUMENTS` for skills
6. ¬drop items from enumerations — compress wording only
7. Bash runs ONLY S (count/append/new-ulid) + the pre-image hash; the ledger has no Write/Edit path — S is its sole writer
8. Bash unavailable → `method: estimate` (labeled), `verify: skipped`, NO ledger row

$ARGUMENTS
