# Derive Mode

Mode body for `/compress derive <scope>` — loaded by SKILL.md Phase 3 when μ = derive. Mines repeated extraction units across a scoped corpus to propose new shared patterns or principles. The sole function of this reference file is to flip SKILL.md's `ref(μ) ∃` check to true for μ=derive; landing here halts the "mode not yet implemented" gate. No new description triggers — "derive pattern from skills" ships with the skill.

## Dispatch

`/compress derive <glob|dir|plugin>` is explicit-mode only. A bare `/compress <file>` never enters derive mode — it routes to the default compress mode. The derive mode requires the user to name it explicitly to guard against phantom derivations running without intentional scope selection. The mere existence of this reference file (`plugins/compress/skills/compress/references/derive.md`) is what flips the `ref(μ) ∃` predicate in SKILL.md Phase 0, unlocking the mode dispatch.

## Scope & Caps

Named constants:

```
MAX_FILES = 40
MAX_BYTES = 400_000
```

Scope resolution (SKILL.md Phase 1): file path | glob | directory | plugin name — same discovery mechanism; this mode's read-budget cap is set independently (§ Scope & Caps below), not inherited from Phase 1's N ≤ 10.

Over-cap scope → halt with chunking advice: "Scope exceeds MAX_FILES or MAX_BYTES; chunk into ≤40 files or ≤400k bytes per run." Per-file Task fan-out: each subagent reads EXACTLY its one file and returns signatures only (never the whole corpus in one context window) — this is the train-C single-file cap pattern. No merged read of the entire scope.

Read budget: N = 1 → proceed. N > 1 → exactly ONE batched present-choice (file list + size estimates) before any read. Cap N ≤ 40 per run; larger scope → chunk into sequential ≤40 runs, chunk plan stated up front. Results land as one consolidated report with per-file opt-out.

## Normalization

This is a DETERMINISTIC SPEC, executed exactly as written, never paraphrased as vague prose:

**Extraction unit** ("the construct") — one of the following:
- a `Let:` block binding line (a single `variable := definition` assignment within a Let block)
- an `I :=` / `V :=` contract line (a single integrity or value invariant)
- one table row (including header row, treated as a row)
- one `O_<name>` operation line (a single step or operation in an `O_name { … }` workflow)
- a guard-function line (a single conditional or gating predicate, e.g., `∃ X ⇒ do Y`)
- a status-glyph vocabulary line (a single entry in a glyph mapping, e.g., `✓ = success`)
- a heading plus its first paragraph (when repetition spans whole sections — heading markup preserved, paragraph text normalized)

Segmentation happens BEFORE normalization; each unit yields one signature.

**Rules, in this exact order:**

1. **NFC-normalize** the text (Unicode normalization form C).
2. **KEEP structural tokens verbatim** — glyphs and glyph sequences (∀∃∄∈∉∧∨¬→⟺:=← etc, never placeheld), structural keywords (`Let:`, the `I :=` / `V :=` markers themselves, `O_` prefix, table pipes `|`, heading markup `#`). KEEP has PRECEDENCE over all substitution rules.
3. **Placeholder substitution** (intra-order, longest-match-first):
   - backtick code spans → `<CODE>`
   - quoted strings → `<STR>`
   - file/path literals → `<PATH>`
   - numeric literals → `<NUM>`
   - contiguous identifiers (alphanumeric + underscore + hyphen) → `<VAR>` (e.g., `MAX_FILES` is ONE `<VAR>`; compound identifiers like `pipeline_done` normalize as ONE `<VAR>`; the bound identifier after a kept `I :=` marker is also normalized: `I := pipeline_done` → `I := <VAR>`)
4. **Collapse whitespace runs** (multiple spaces → single space; preserve line structure).

The normalized string IS the signature key. Two or more occurrences of identical signatures cluster together. Semantic-equivalence merges (when the LLM judges two distinct keys as semantically equivalent) must appear in the report labeled as `judged-equivalent`, showing BOTH keys.

## GATE

Named constants and predicates:

```
MIN_OCCURRENCES = 3
MIN_FILES = 3
FRESHNESS_DAYS = 7
```

Explicitly state: these are labeled placeholders, not calibrated thresholds. Every real measurement is produced by a tool command, never hand-waved.

Stability predicate: `git log -1 --format=%ct -- "<file>"` outputs the UNIX timestamp of the file's most recent commit; iff `(now - timestamp) > FRESHNESS_DAYS * 86400` seconds, the file is marked stable. Command failure or empty output (untracked file, git unavailable) → treat as ¬stable (fail-closed) — never assume freshness absent a timestamp.

Amortization rule: extraction is allowed iff co-occurrence-in-one-context-window (the file chain passed to a single Task agent) OR declared as a SSoT objective (explicitly stated in the scope request).

**Measurement procedure (verbatim, executable):**

∀ potential principle candidate (a cluster of repeated signatures):
1. Write each fragment (the pointer line, one inline instance, the emitted principle draft) to a scratch temp file — each as a separate file.
2. Run `python3 count_tokens.py count <tmp>` on each scratch file → read the JSON report field: under `method: tiktoken-proxy` read `report['tokens_o200k']` (or under `method: estimate` / `method: anthropic-api` read `report['tokens']`); record `agreement` if present.
3. Record BOTH: repo-static Δ (savings if the principle were adopted in the actual source) AND runtime per-invocation Δ (tokens spent in this run to emit the principle draft). Hand-estimates are forbidden — every number in the double-entry must be tool-produced.

Gate application:

| Predicate | Action |
|-----------|--------|
| `\|signatures\| < MIN_OCCURRENCES` | FAIL — cluster too small, skip |
| `\|files_in_cluster\| < MIN_FILES` | FAIL — cluster spans too few files, skip |
| `∃ file ∈ cluster ∧ ¬stable` | FAIL — active file in cluster, gate requires FRESHNESS_DAYS age, skip |
| All predicates PASS | Proceed to ROUTE |

## ROUTE

For every cluster that passes the GATE, determine **schema_fit** via LLM judgment over the enumeration {strong, ambiguous, poor}. This is NOT a numeric threshold — it is a deliberate judgment call. State explicitly: there are no fake numeric cutoffs here. Include a one-line justification for every schema_fit assignment.

- **strong** → fold-in proposal into the EXISTING shared target (diff against it, never a duplicate sibling)
- **ambiguous** → new-pattern proposal via present-choice (ask the user: **Emit as principle** | **Dark matter** | **Skip**)
- **poor** → dark matter verbatim (listed in the report, never forced into abstraction)

## CONFLICT

Overlap detection: iff a candidate signature or principle overlaps with an existing pattern in the shared reference target (e.g., `${CLAUDE_PLUGIN_ROOT}/../shared/references/notation.md` or `references/compress.md`), and the two carry opposed polarity or contradictory rules, a conflict exists.

Conflict handling: present-choice showing BOTH texts (the candidate and the existing pattern). State explicitly: no silent-merge path exists in this mode's text. The user's choice is recorded and carries through to the EMIT step.

## EMIT

R11 pointer contract: every external reference follows this form exactly:

```
Q := read ${CLAUDE_PLUGIN_ROOT}/../shared/references/<f>.md — <gloss>
```

Never use bare `→ REF(n)` style pointers. The Let-bound form `Q := read …` is the house idiom.

Output check — before presenting any derived rule or principle to the user, grep the mode's own draft for the bare-pointer regex pattern `→ *[A-Z]+\([0-9n]+\)` and reject + rewrite on any hit. This guard rejects poorly-formatted pointers.

**R12 template** — embed exactly as shown, genericized, no real paths:

```
## <Principle name> (validated on <instance>: <before → after metric>)

∀ <scope>: <rule body>

trigger: <machine-checkable predicate>

ref: <source instance 1> · <source instance 2> · …

gloss: <≤1-line NL name + docstring>

confidence: <0-100> · ambiguity_flags: [<flags>]
```

Field semantics:
- `confidence` ∈ [0,100] ∩ ℤ (an integer percentage)
- `ambiguity_flags` — controlled vocabulary exactly: `{conflict, subjective, incomplete, semantic-judgment, schema-fit-boundary}`, or `[]` if empty

Report format (pinned fields, per cluster):

```
## Cluster <n>: <name>

signature key: <normalized string>

occurrence table (sorted by file, line):
| file:line | construct | context |
| ... | ... | ... |

gate results:
  MIN_OCCURRENCES: PASS | FAIL — <value>
  MIN_FILES: PASS | FAIL — <value>
  FRESHNESS_DAYS: PASS | FAIL — <tool output>

route: <fold-in <target> | new-pattern | dark-matter> · schema_fit: <strong|ambiguous|poor> — <one-line justification>

emission: <R11 draft + pointers> | <R12 principle block> | skipped: <break-even arithmetic with tool output>

double-entry deltas:
  repo-static: ±N tokens · runtime/invocation: ±M tokens
  N/A for gate-failed or dark-matter dispositions — no principle draft exists to measure

unified diff (if emitting)
```

Cluster-level report trailer contains:

- **Dark-matter list** — all clusters routed to dark matter (listed verbatim, never forced into abstraction)
- **Gate-failed list** — all clusters that failed a predicate (its OWN disposition, NOT lumped into dark-matter)
- **Deliberate-loss list** — clusters that passed GATE and ROUTE but the user accepted a present-choice to skip (recorded with acceptance identity)
- **coverage map** — every mined instance_id keyed as `(file, line, signature-key)`; disposition per instance ∈ {pattern, principle, dark-matter, gate-failed, deliberate-loss}; coverage identity: `|pattern| + |principle| + |dark-matter| + |gate-failed| + |deliberate-loss| = |all_mined_instances|`, zero uncounted

Ledger row: one Observation appended ONLY via S (SKILL.md's sole ledger writer) — compose the append line with the scope string as a single argv token, never re-parsed by shell:

```
SOURCE_REF=$(git rev-parse HEAD)
python3 S append --target "<scope-string>" --mode derivation \
  --source-ref "$SOURCE_REF" --tokens-before 0 --tokens-after 0 \
  --sections-json '<per-cluster disposition counts as sections>' --correlation <run-ulid>
```

The row lands with `category=derivation` (free-form mode field — deliberately distinct from the `derive` dispatch keyword; ledger rows read as nouns).

## Validate

Derive.md's OWN verifier spawn prompt (explicitly NOT verify.md's compress anchor-specific spawn template — that one is anchor-driven and cannot drive derive verification):

Materialize the complete report to ONE scratch file (single-file cap pattern — the sole persistent write remains the ledger row; the scratch file is transient). Spawn ONE fresh Task reader that reads exactly that scratch file and checks:

1. **Coverage identity** — every mined instance_id has a disposition; arithmetic: `|pattern| + |principle| + |dark-matter| + |gate-failed| + |deliberate-loss| = |all_mined_instances|` (zero uncounted).
2. **Deliberate-loss attestation** — every entry in the deliberate-loss list carries its present-choice acceptance (the choice made, the user's intent).
3. **Spot-reproduction** — pick one emitted R12 principle and one `ref:` instance from its source; judge whether following that principle reproduces the instance in the source file. Record this as an LLM judgment call. Explicitly disclose: "spot-reproduction is not mechanized in this train — judgment-only verification."

Record the verification outcome; the report links to it.

## cortex_link

This section is a schema de-risking statement only (feeds roxabi-cortex Retain with SCHEMA evidence only, never calibration). State: the ≥3 / ≥3 thresholds (MIN_OCCURRENCES, MIN_FILES) are labeled placeholders in this mode body; they do not ship as calibrated constants in any downstream system. Background references (e.g., D15, GEPA, LILO, RC-x prior runs) are cited for context only and carry NO load-bearing requirements. Every principle that this mode emits must be validated in cortex's write gate independently — derive.md's derivation is input, not gospel. Roxabi-cortex owns the final schema.

## Report-only statement

Derive.md produces zero writes to any scoped or repo file (no edits to notation.md, no changes to target files, no new files created in the source tree). The SOLE write is the ledger row appended via `S append` — this row is IDEMPOTENT and read-only to the reporter (the mode never deletes or edits it). The supersede-not-destroy principle applies: this mode never destroys existing patterns; future v2+ apply paths (should they exist) will handle overwrite semantics, not this train.

## Worked Examples

① **I/V Boilerplate (dogfood — example-only, this plugin's own convention)**

Source: `plugins/compress/skills/compress/SKILL.md` lines 15–22 contain multiple `I :=` and `V :=` binding lines. Extraction:

```
Signatures extracted:
  I := <VAR> ∧ <VAR> ∧ <VAR>
  V := <VAR> = <NUM>
  ref(<VAR>) := `<PATH>` — <VAR> ∧ <VAR>
```

Occurrence count: 3 across the same file. Gate: MIN_OCCURRENCES PASS, MIN_FILES FAIL (single file). Action: **Skip — gate-failed**.

② **Pipeline Verify-Tables (dogfood, example-only)**

Source: Multiple compress reference files (`compress.md`, `expand.md`, `lint.md`) all contain `| Step | Action |` verify tables with similar structure. Extraction:

```
Signature: | <VAR> | <VAR> |
```

Occurrence: 12 instances across 3 files. Gate: MIN_OCCURRENCES PASS, MIN_FILES PASS, FRESHNESS_DAYS PASS (all stable). Route: **strong schema-fit** — this is the standard `| Phase | Notes |` pattern already documented in `${CLAUDE_PLUGIN_ROOT}/../shared/references/notation.md`. Action: **Fold-in** to existing shared reference, diff against `## Core Table`.

```
$ python3 count_tokens.py count /tmp/instance_row.txt
{ "tokens_o200k": 6, "method": "tiktoken-proxy", "agreement": true }
```

double-entry deltas: repo-static: −48 tokens (12 instances × 6 tokens = 72 today; fold-in reuses the existing canonical row (0 new tokens) + 12 × 2-token pointers = 24 → Δ = 24 − 72) · runtime/invocation: +12 tokens (diff-against-existing cost; no new principle drafted)

③ **Status-Glyph Vocabulary (dogfood, example-only)**

Source: `plugins/compress/skills/compress/references/lint.md` contains:

```
⏳ = waiting
✓ = success
✗ = failure
⚠ = warning
```

Each glyph appears individually in multiple skill files. Extraction:

```
Signature: <VAR> = <VAR>
```

Occurrence: 8 instances across 4 files. Gate: all PASS. Route: **strong** — this is the glyph registry. Action: **Fold-in** to `${CLAUDE_PLUGIN_ROOT}/../shared/references/notation.md` § Reserved-Variable Registry, update counts.

```
$ python3 count_tokens.py count /tmp/glyph_instance.txt
{ "tokens_o200k": 4, "method": "tiktoken-proxy", "agreement": true }
```

double-entry deltas: repo-static: −24 tokens (8 instances × 4 tokens = 32 today; registry update reuses the existing entry (0 new tokens) + 8 × 1-token pointers = 8 → Δ = 8 − 32) · runtime/invocation: +10 tokens (registry-diff cost; no new principle drafted)

④ **Generic non-Roxabi Example — Shared Retry-Policy Paragraph**

Imagine an external ecosystem with N skills, each carrying an identical retry-policy prose block:

```
Retry policy: on transient errors (timeout, rate-limit), retry up to 3 times with exponential backoff. 
Final failure → escalate to human.
```

This block appears in 6 distinct skill READMEs across 5 different projects (shared reference materials). Extraction:

```
Signature (normalized): Retry policy: on <VAR>, retry up to <NUM> times with exponential backoff. Final failure → escalate to human.
```

Occurrence: 6 across 5 files. Gate: all PASS. Route: **ambiguous** schema-fit (is this a policy principle or domain-specific guidance?). Action: **present-choice** → **Emit as principle** selected.

Principle emitted:

```
## Retry Policy (validated on N skill READMEs: shared verbatim → single shared reference)

∀ transient error ∈ {timeout, rate-limit}: retry(arg, count=3, strategy=exponential-backoff)

trigger: error handling path encounters transient failure

ref: project-A/skills/X/README.md line 42 · project-B/skills/Y/README.md line 18 · …

gloss: standard retry pattern — 3 attempts with exponential backoff, escalate on final failure

confidence: 85 · ambiguity_flags: [subjective, schema-fit-boundary]
```

```
$ python3 count_tokens.py count /tmp/retry_instance.txt
{ "tokens_o200k": 28, "method": "tiktoken-proxy", "agreement": true }
$ python3 count_tokens.py count /tmp/retry_principle_draft.txt
{ "tokens_o200k": 60, "method": "tiktoken-proxy", "agreement": true }
```

double-entry deltas: repo-static: −96 tokens (6 instances × 28 tokens = 168 today; 1 principle (60) + 6 × 2-token pointers = 72 → Δ = 72 − 168) · runtime/invocation: +60 tokens (draft + describe + present cost)

confidence: 85 · ambiguity_flags: [subjective, schema-fit-boundary]
```

⑤ **Poor-Fit Cluster — Dark Matter Verbatim (never forced into abstraction)**

Source: Three files contain superficially similar setup instructions:

File A: `Init phase: connect to database, load config, spawn workers.`
File B: `Startup sequence: open DB connection, read configuration, launch daemon tasks.`
File C: `Boot routine: establish DB link, pull settings, fork worker processes.`

Normalized signatures:
- A: `<VAR> phase: <VAR> to <VAR>, <VAR> config, <VAR> workers.`
- B: `<VAR> sequence: <VAR> DB connection, read configuration, launch daemon tasks.`
- C: `<VAR> routine: <VAR> DB link, <VAR> settings, <VAR> worker processes.`

LLM judgment: semantically equivalent (all three describe system startup). Merge: `Startup procedure: connect to database, load config, start workers.` Occurrence: 3 files, 3 instances. Gate: all PASS. Route: **poor** schema-fit — these are domain-specific vernacular (A, B, and C use different terminology for the same concept, but abstracting further would lose the domain context). Action: **dark matter verbatim** — listed in the report, never forced into a principle:

```
## Cluster: startup vocabulary

Instances (verbatim):
  file-A.md:12: Init phase: connect to database, load config, spawn workers.
  file-B.md:8: Startup sequence: open DB connection, read configuration, launch daemon tasks.
  file-C.md:5: Boot routine: establish DB link, pull settings, fork worker processes.

Route: dark-matter (poor schema-fit — domain-specific vernacular, no cross-domain principle)
```

⑥ **Break-Even Skip Example (full arithmetic shown, no hand-waves)**

Source: A small cluster of method signatures repeated 3 times across 3 files.

Signature: `function(<VAR>: <VAR>, <VAR>: <VAR>) → <VAR>`

Gate: all PASS. Route: **ambiguous** schema-fit. Present-choice offered.

Break-even arithmetic (all tool outputs — every instance measured individually, no hand-estimates):

```
Fragment 1 (occurrence instance 1):
  $ python3 count_tokens.py count /tmp/instance1.txt
  { "tokens_o200k": 8, "method": "tiktoken-proxy", "agreement": true }

Fragment 2 (occurrence instance 2):
  $ python3 count_tokens.py count /tmp/instance2.txt
  { "tokens_o200k": 9, "method": "tiktoken-proxy", "agreement": true }

Fragment 3 (occurrence instance 3):
  $ python3 count_tokens.py count /tmp/instance3.txt
  { "tokens_o200k": 8, "method": "tiktoken-proxy", "agreement": true }

Fragment 4 (principle draft):
  $ python3 count_tokens.py count /tmp/principle_draft.txt
  { "tokens_o200k": 45, "method": "tiktoken-proxy", "agreement": true }

Repo-static calculation (if principle adopted):
  instance 1 + instance 2 + instance 3 = 8 + 9 + 8 = 25 tokens (current)
  1 principle + 3 pointers = 45 + (3 × 2) = 51 tokens (proposed)
  Δ = 51 − 25 = +26 tokens (net loss)

Runtime per-invocation cost:
  Draft + describe + present cost = 45 tokens
  Savings if user accepts: 0 tokens (because repo-static is net loss)
  Break-even threshold: 45 ≤ 25? NO.

Disposition: **Skipped — break-even arithmetic shows net token loss (+26 repo-static); runtime cost (45 tokens) exceeds savings; user choice: **Skip**.
```

---

$ARGUMENTS
