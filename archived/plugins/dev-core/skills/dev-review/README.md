# dev-review

`/R-dev-review` reviews a branch or PR with a small evidence-selected panel, merges Conventional Comments once, and produces a fail-closed verdict. The workflow preserves spec, secret, and human gates while keeping review separate from `/R-fix`.

## Usage

```text
/R-dev-review         Review current branch vs staging/main
/R-dev-review #42     Review PR #42
```

Triggers: `"code review"` | `"review changes"` | `"review PR #42"` | `"check my code"` | `"do a code review"`

## Workflow

1. **Gather changes** — read the full diff and changed files; note binaries and warn above 50 files.
2. **Secret preflight** — scan for hardcoded credentials, redact matches, and require Review/Abort input when any match exists.
3. **Spec compliance** — when an approved spec exists, check every criterion and emit a blocking finding for every gap. Preserve the complete met/missing mirror for display.
4. **Chunk** — partition large diffs and retain boundary digests so each worker sees its scope and cross-chunk interfaces.
5. **Select and run the panel** — call `roster.sh` once for a single chunk or once in allocation mode for all chunks. Spawn exactly the returned roles per chunk.
6. **Recall cross-chunk classes** — after review workers finish, build the deterministic class index. For each canonical class present in at least two chunks with at least three unique callsites, spawn one fresh native generic read-only worker. It receives only the class, callsites, ±10 context lines, and cross-chunk index; RC-3 confirms sibling scope and RC-6 searches for uncited instances. Every emitted finding is blocking. Single-chunk reviews and `candidate/*` classes skip recall; there is no diff-size knob.
7. **Merge, render, and post once** — deterministically deduplicate findings, keep every remaining finding, group them, compute the verdict, render each finding exactly once, then post that same body when a PR exists.
8. **Human decision** — Fix now (`/R-fix`) | Merge as-is | Stop.

## Per-chunk panel

Each chunk has the `R-adversarial` floor plus at most two specialists by default (`max_agents=3`). The oracle prioritizes proved relevance from the chunk, not manifest order.

| Role | Expected evidence trigger | Focus |
|------|---------------------------|-------|
| `R-adversarial` | always; floor | red-team + OWASP lens |
| `R-security-auditor` | strong auth, secrets, or crypto path/diff evidence | OWASP, secrets, injection, auth |
| `R-architect` | axial ADR + root axial path; otherwise architecture/ADR path, workspace graph config, or configured FE+BE crossing | axial N×M drift, boundaries, coupling |
| `R-frontend-dev` | frontend prefix/extension evidence; dominant domain first, secondary last | components, hooks, client behavior |
| `R-backend-dev` | configured backend-prefix evidence; dominant domain first, secondary last | APIs, contracts, errors |
| `R-devops` | infra/config/deploy evidence, with no tier gate | config, deploy, infra |
| `R-tester` | changed-test evidence and failed oracle, after devops in priority | coverage, edge cases, tautology |

Roster priority is floor → security path → architect axial mode → dominant FE/BE domain → devops → tester → architect structural mode → secondary FE/BE domain. FE/BE dominance is by chunk file count. Architect requires axial or structural evidence; F-full alone is cold. Project `always`/`never` overrides remain authoritative, and forced roles bypass the cap. `max_agents_review` defaults to `0`, exists only for allocation compatibility, and warns whenever explicitly configured. Legacy recall sizing and override inputs are ignored with warnings. The roster returns only dispatch roles; isolated recall remains native to this workflow.

## Finding format

```text
<label>: <description>
  file.ts:42
  -- agent-name
  Root cause: <why>
  Class: [<canonical-class>, ...]
  Raw callsites: [{file: <path>, line: <n>}, ...]
  Solutions:
    1. <primary> (recommended)
    2. <alternative>
  Confidence: 87%
```

`Class` and `Raw callsites` are optional only when no class applies. Confidence prices a hypothesis; it controls ordering and `/R-fix` routing, never whether the finding survives.

## Deduplication and verdict

Deduplication is deterministic: same file/line issue keeps max confidence; one `(file, class)` finding keeps max confidence; intersecting class sets at one location merge callsites after subsumption. Every deduplicated finding remains, and recall-source findings normalize to blocking.

| Condition | Verdict |
|-----------|---------|
| Any blocking finding | Request changes |
| Warnings only | Approve with comments |
| Suggestions/praise only | Approve |
| No findings | Approve (clean) |

## Output integrity

The single review body is ordered `Spec → Standards → grouped findings → roster disclosures → verdict`. Spec and Standards rows are non-Conventional-Comment-shaped and never duplicate a finding, so `/R-fix` creates one task per actionable finding. Standards remains an orchestrator-only judgement pass and never affects verdict.

Findings remain hypotheses, and repeat runs can differ because review workers are LLMs. The adversarial and security manifests are read-only by contract; the native recall worker is freshly isolated and explicitly limited to Read/Grep/Glob. Dual-use specialists are constrained to findings-only behavior by the review prompt. Every worker is forbidden from recursively spawning or invoking `/R-dev-review`.

## Chain position

**Predecessor:** `/R-validate` | **Successor:** `/R-fix` (changes) or merge (approved)
