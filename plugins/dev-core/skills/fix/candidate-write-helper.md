# Candidate Write Helper

Single source of truth for all `candidate-classes.jsonl` write sites.
Referenced by: `fix/SKILL.md` §F6, `fix/falsification.md` Parking Lot Protocol,
and any future write site (graduation cron, Slice 5, etc.).

∀ site that appends to `candidate-classes.jsonl` MUST follow this protocol exactly.
¬inline these rules — reference this file.

## Schema

Every entry written to `candidate-classes.jsonl`:

```
{
  class:        string   — candidate/<slug> matching ^candidate/[a-z][a-z0-9-]{1,48}$
  finding_id:   string   — sha8 of (class + file + line), stable per location
  pr:           string   — PR identifier (see pr field rules below)
  hit_at:       string   — ISO-8601 timestamp of the write
  agent_slug:   string   — trusted agent identity (closed enum in review-classes.yml)
  spec_version: "1"      — REQUIRED; graduation cron rejects entries lacking this field
}
```

Additional fields (e.g. `file`, `line`, `description`, `source`) may be appended by the
write site for human readability but are not consumed by the graduation cron.

## pr Field Rules (F6)

Three cases, evaluated in order:

**Case 1 — null:** `pr = null` → drop entry silently. ¬D.append. No PR context means
the entry cannot count toward the graduation gate's ≥2-distinct-PRs criterion.

**Case 2 — malformed:** `pr` does not match:
```
^(local:[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?:[0-9a-f]{8}|[1-9][0-9]{0,9})$
```
→ drop entry + D.append at write site:
```
D.append({
  tag:         "candidate-pr-malformed",
  file:        <write-site-identifier>,     ← MUST be statically known (see Provenance)
  line:        <n>,                          ← MUST be from write-site position tracking
  description: "candidate pr field violates pr-format-regex — entry dropped (no coercion)",
  phase:       "<phase-slug>"               ← phase of the invoking write site (e.g. "1", "6.5")
})
```
Drop semantics: entry silently dropped; ¬coercion, ¬fallback identity.

Attack vectors blocked by this regex:
- JSONL injection: sha8 containing `\n{...}` → manufactured graduation hits
- Shell injection: sha8 containing `$(...)` → code execution if `pr` interpolated unquoted
- Path traversal: branch-slug containing `/` → mktemp path escape
- Zero-padded numeric bypass: `"01"` no longer matches numeric branch

**Case 3 — valid:** `pr` matches regex → proceed with write.

Non-PR runs: use synthetic `local:<branch-slug>:<sha8>` format. `local:*` hits count toward
frequency (≥3×/30d) but NOT toward the ≥2-distinct-PRs promotion gate (advisory only).

## Provenance Constraint

In every D.append call at a write site:
- `file` MUST be the **statically-known** write-site identifier (e.g. `"fix/SKILL.md"`, `"falsification.md"`)
- `line` MUST be a **non-negative integer** from the write-site's own position tracking

NEITHER field may be derived from candidate entry content. Rationale: a crafted `\n`, `"`,
or `}` in a candidate field could corrupt the diagnostic bus if file/line were interpolated
from entry data (JSONL injection).

## agent_slug Authorization

`agent_slug` is a **closed enumeration** of trusted identities defined in
`${CLAUDE_SKILL_DIR}/../code-review/review-classes.yml` (normative derivation section).

Graduation cron MUST reject (drop, not coerce) any entry where `agent_slug` is absent
or not in the trusted list.

## finding_id Derivation

`finding_id = sha8(class + ":" + file + ":" + str(line))`

Use the first 8 hex characters of SHA-256. Purpose: stable per-location dedup key for the
graduation cron; not a security identifier.

## Write-Site Checklist

Before appending to `candidate-classes.jsonl`, every write site MUST:

1. Evaluate `pr` against the three cases above (null → drop; malformed → drop + D.append; valid → proceed)
2. Derive `finding_id` from `sha8(class + ":" + file + ":" + str(line))`
3. Set `hit_at` to current ISO-8601 timestamp
4. Set `spec_version: "1"`
5. Include `agent_slug` from the invoking agent's identity
6. Apply provenance constraint to any D.append call
