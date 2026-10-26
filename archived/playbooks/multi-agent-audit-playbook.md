---
title: Multi-Agent Code Quality Audit Playbook
description: 67 parallel agents across 8 domains for comprehensive code quality audit
purpose: Generate actionable reports with prioritized findings and technical debt score
scope:
  - Pre-release quality gate
  - Quarterly code health assessment
  - Post-refactor verification
  - Security compliance review
dependencies:
  - Claude Code with sub-agent support
  - Partition scheme for codebase
  - Manifest tracking system
tags:
  - code-quality
  - audit
  - parallel-agents
  - tech-debt
  - security
  - architecture
version: "1.1"
last_updated: "2026-06-02"
---

# Multi-Agent Code Quality Audit Playbook

## Overview

A reusable pattern for running comprehensive code quality audits using 67 parallel agents across 8 analysis domains. Produces actionable reports with prioritized findings and a technical debt score.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      QUALITY AUDIT ENGINE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ Wave 1   │→ │ Wave 2   │→ │ Wave 3   │→ │ ... Wave │→ Synth  │
│  │ 5 agents │  │ 5 agents │  │ 5 agents │  │ 15       │         │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘         │
│                                                                  │
│  8 Domains × 8 Partitions + 6 Test Partitions + Synthesis = 67  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Strategy Document (`STRATEGY.md`)

Defines the audit scope, domains, partitioning scheme, and execution pattern.

```markdown
# Quality Audit Strategy

## Domains
| Domain | Focus |
|--------|-------|
| Architecture | Layer violations, circular deps, coupling |
| Axial Drift | Wrong-axis duplication (N×M), cross-cutting concerns |
| Security | OWASP, credentials, injection vectors |
| Code Smells | God classes, long functions, DRY |
| Type Safety | Any usage, missing hints, type: ignore |
| Async Patterns | Race conditions, blocking calls, leaks |
| Error Handling | Bare excepts, swallowed errors |
| Test Quality | Coverage, flaky patterns, mocking |
| Tech Debt | TODOs, deprecated APIs, magic numbers |

## Partitioning
| ID | File Patterns |
|----|---------------|
| P1-P8 | Source code partitions |
| T1-T6 | Test code partitions |

## Execution
- 5-by-5 wave pattern (5 agents per wave)
- Background execution with completion notifications
- Manifest tracking for resume capability
```

### 2. Agent Prompts (`AGENT_PROMPTS.md`)

Template prompts for each domain with consistent output format.

```markdown
## Task
Analyze {DOMAIN} for {PARTITION} area.

## Files to Analyze
{PATTERNS}

## Focus Areas
- {specific focus areas for domain}

## Output
Write findings to: artifacts/analyses/quality-audit/{DOMAIN}/{OUTPUT_FILE}

## Format
### Summary
### Findings (table)
### Metrics
### Recommendations
```

### 3. Manifest (`manifest.json`)

Progress tracking for resumable execution.

```json
{
  "status": "in_progress",
  "started": "2026-04-22T00:31:00Z",
  "completed_agents": ["arch-P1", "arch-P2", ...],
  "pending_agents": ["tech-P7", "synthesis"],
  "current_wave": 12,
  "waves": {
    "1": ["arch-P1", "arch-P2", "arch-P3", "arch-P4", "arch-P5"],
    ...
    "15": ["synthesis"]
  }
}
```

---

## Execution Pattern

### Wave Structure

```
Wave 1:     Axial Drift (2 agents: importlinter + axial-adr-review)
Wave 2-3:   Architecture (8 agents)
Wave 4-5:   Security (8 agents)
Wave 6-7:   Code Smells (13 agents: 8 source + 5 test)
Wave 8-9:   Type Safety (8 agents)
Wave 10:    Async Patterns (8 agents)
Wave 11-12: Error Handling (8 agents)
Wave 13:    Test Quality (6 agents)
Wave 14-15: Tech Debt (8 agents)
Wave 16:    Synthesis (1 agent)
```

### Per-Wave Execution

```python
# Pseudocode for wave execution
for wave in waves:
    agents = wave_agents[wave]

    # Launch all agents in parallel (background)
    for agent_id in agents:
        domain, partition = parse_agent_id(agent_id)
        prompt = build_prompt(domain, partition)
        spawn_agent(
            description=f"{domain} {partition}",
            prompt=prompt,
            run_in_background=True
        )

    # Wait for all agents in wave to complete
    wait_for_wave_completion(agents)

    # Extract results and write output files
    for agent_id in agents:
        result = extract_result(agent_id)
        write_output_file(domain, partition, result)

    # Update manifest
    update_manifest(wave, completed=agents)
```

---

## Axial Drift Audit

Axial drift is the duplication of cross-cutting concerns across non-primary axis siblings (the N×M trap). It requires **two-step verification**.

### Step 1: Structural Check (`importlinter`)

```bash
# Run the existing layer contract validator
importlinter
# or
uv run import-linter
```

**What it catches:**
- Forbidden imports between layers (e.g., `adapters` → `core` direct calls)
- Circular dependencies
- Contract violations defined in `.importlinter`

**Output:**
- `artifacts/analyses/quality-audit/axial-drift/importlinter-report.md`
- Exit code ≠ 0 = violations found

### Step 2: Semantic Drift Check (`axial-adr-review`)

Spawn the read-only `axial-adr-review` agent to check for wrong-axis duplication.

**Prerequisites:**
- Axial ADR exists (`axial: true` frontmatter in `docs/architecture/adr/`)
- Diff or spec to review (e.g., PR diff, planned changes)

**Agent invocation:**
```
agent: axial-adr-review
prompt: Review this diff for drift along the non-primary axis.
        Check for cross-cutting concerns duplicated across non-primary axis siblings.
        Emit Conventional Comments findings tagged with `target-axis-trap`.
```

**What it catches:**
- Same logic repeated in `infrastructure/stores/nats.py` and `infrastructure/stores/redis.py`
- Adapter-level retry logic that should be in `transport/`
- Parallel-path implementations of the same feature

### Step 3: Cocoindex Confirmation

Use semantic search to validate suspected duplication found in Steps 1–2.

```bash
# Example: confirm that "retry logic" is duplicated across stores
ccc search "retry logic" --path "infrastructure/stores/*" --limit 20

# Example: confirm that "auth middleware" pattern appears in multiple adapters
ccc search "auth middleware" --path "adapters/*" --limit 20

# Example: find all occurrences of a specific function pattern
ccc search "def wait_for_hub" --limit 20
```

**Heuristic:**
- If `ccc search` returns chunks with similarity > 0.85 in sibling modules on the non-primary axis, flag as `confirmed-drift`
- If similarity is 0.6–0.85, flag as `probable-drift` requiring manual review
- If < 0.6, discard as false positive

**Output:**
- `artifacts/analyses/quality-audit/axial-drift/cocoindex-confirmations.md`

---

## Cocoindex Cross-Domain Validation

Use semantic search (`ccc`) as a **second-opinion validator** for findings from other domains. It is not a primary detection tool, but it confirms or refutes suspicions with high recall.

### Security

```bash
# Confirm credential-handling patterns
ccc search "password" --limit 20
ccc search "API key" --limit 20
ccc search "token" --path "config/*" --limit 20
```

### Code Smells (DRY)

```bash
# Confirm suspected duplicated logic
ccc search "def extract_json" --limit 20
ccc search "parse_timestamp" --limit 20
```

### Type Safety

```bash
# Find unannotated public functions
ccc search "def process_" --lang python --limit 50
# Manual check: which return types are missing?
```

### Async Patterns

```bash
# Find blocking calls inside async functions
ccc search "requests.get" --path "adapters/*" --limit 20
ccc search "time.sleep" --path "src/*" --limit 20
```

### Error Handling

```bash
# Find bare except patterns
ccc search "except:" --lang python --limit 30
ccc search "pass  # ignore" --lang python --limit 20
```

### Tech Debt

```bash
# Find TODO/FIXME markers
ccc search "TODO:" --limit 50
ccc search "FIXME" --limit 50
ccc search "HACK" --limit 50
```

### Validation Heuristic

| Similarity Score | Interpretation |
|------------------|----------------|
| > 0.90 | Confirmed duplication / exact pattern match |
| 0.70–0.90 | Probable match; manual review required |
| 0.50–0.70 | Weak signal; likely false positive |
| < 0.50 | Discard |

**Rule:** Any finding flagged by a primary agent (architecture, security, code-smells) with no `ccc` confirmation in the top-5 results should be downgraded one severity level.

---

## Output Structure

```
artifacts/analyses/quality-audit/
├── STRATEGY.md              # Audit strategy definition
├── AGENT_PROMPTS.md         # Agent prompt templates
├── manifest.json            # Progress tracking
├── AUDIT-SUMMARY.md         # Final synthesized report
│
├── axial-drift/
│   ├── importlinter-report.md   # Layer contract violations
│   ├── axial-adr-review.md     # Wrong-axis duplication findings
│   └── cocoindex-confirmations.md  # Semantic-search confirmations
│
├── architecture/
│   ├── P01-core-hub.md
│   ├── P02-core-agent-cli.md
│   └── ... (P03-P08)
│
├── security/
│   └── ... (P01-P08)
│
├── code-smells/
│   ├── P01-P08.md          # Source code analysis
│   └── T01-T05.md          # Test code analysis
│
├── type-safety/
│   └── ... (P01-P08)
│
├── async-patterns/
│   └── ... (P01-P08)
│
├── error-handling/
│   └── ... (P01-P08)
│
├── test-quality/
│   └── T01-T06.md          # Test quality analysis
│
└── tech-debt/
    └── ... (P01-P08)
```

---

## Final Report Structure

The synthesis agent produces `AUDIT-SUMMARY.md`:

```markdown
# Code Quality Audit Summary

## Executive Summary
- Overall health assessment
- Security posture
- Test coverage status
- Key debt items

## Critical Issues (P0)
[Security vulns, data loss risks, axial drift blocking refactor]

## High Priority (P1)
[Bugs, significant tech debt, confirmed axial drift]

## Medium Priority (P2)
[Refactorings, improvements, probable axial drift]

## Low Priority (P3)
[Minor cleanups, weak drift signals]

## Axial Drift Summary
| Axis | Violations | N×M Traps | Cocoindex Confirmations |
|------|------------|-----------|------------------------|

## Metrics Dashboard
| Domain | Issues | P0 | P1 | P2 | P3 |
|--------|--------|----|----|----|----|

## Recommended Actions
[Prioritized with effort estimates]

## Technical Debt Score
[0-100 scale, 100 = pristine]

## Top 10 Quick Wins
[High impact, low effort actions]
```

---

## Partitioning Scheme

### Source Code (P1-P8)

| ID | Patterns | Description |
|----|----------|-------------|
| P1 | `core/hub/**/*.py` | Hub core logic |
| P2 | `core/agent/**/*.py`, `core/cli/**/*.py` | Agent + CLI layers |
| P3 | `core/commands/**/*.py`, `core/stores/**/*.py`, `core/pool/**/*.py`, `core/messaging/**/*.py` | Commands, stores, pool, messaging |
| P4 | `core/processors/**/*.py`, `core/memory/**/*.py`, `core/auth/**/*.py` | Processors, memory, auth |
| P5 | `adapters/**/*.py` | Platform adapters |
| P6 | `bootstrap/**/*.py` | Bootstrap/wiring |
| P7 | `infrastructure/**/*.py`, `nats/**/*.py` | Infrastructure + NATS |
| P8 | `llm/**/*.py`, `agents/**/*.py`, root files | LLM, agents, misc |

### Test Code (T1-T6)

| ID | Patterns | Description |
|----|----------|-------------|
| T1 | `tests/unit/core/**/*.py` | Core unit tests |
| T2 | `tests/unit/adapters/**/*.py`, `tests/unit/bootstrap/**/*.py` | Adapter + bootstrap tests |
| T3 | `tests/integration/**/*_test.py` (first half) | Integration tests A-M |
| T4 | `tests/integration/**/*_test.py` (second half) | Integration tests N-Z |
| T5 | `tests/e2e/**/*.py`, remaining tests | E2E + misc tests |
| T6 | Coverage analysis | Aggregate coverage metrics |

---

## Key Metrics Collected

### Per-Domain

| Domain | Key Metrics |
|--------|-------------|
| Architecture | Module coupling, circular deps, layer violations |
| Axial Drift | `importlinter` violations, wrong-axis duplication count, N×M traps |
| Security | OWASP coverage, credential handling, injection vectors |
| Code Smells | Long functions, god classes, DRY violations |
| Type Safety | `Any` count, `type: ignore` count, missing hints |
| Async Patterns | Race conditions, blocking calls, resource leaks |
| Error Handling | Bare excepts, swallowed exceptions, missing context |
| Test Quality | Coverage %, flaky patterns, mock usage |
| Tech Debt | TODOs, FIXMEs, deprecated patterns, magic numbers |

### Aggregate

- **Total Issues**: Sum across domains
- **Severity Distribution**: P0/P1/P2/P3 counts
- **Technical Debt Score**: Weighted aggregate (0-100)

---

## Scaling Guidelines

| Codebase Size | Agent Count | Wave Size | Est. Duration |
|---------------|-------------|-----------|---------------|
| <50 files | 18 | 4 | 12 min |
| 50-200 files | 34 | 4 | 22 min |
| 200-500 files | 50 | 5 | 45 min |
| 500+ files | 69+ | 5 | 65+ min |

**Overhead additions:**
- Axial drift: +2 agents, +3 min (importlinter + axial-adr-review)
- Cocoindex validation: +2 min per 10 confirmed findings (batchable)

---

## Lessons Learned

### What Worked

1. **5-by-5 wave pattern** - Balanced parallelism without overwhelming context
2. **Background agents** - Main context stayed clean, received notifications on completion
3. **Manifest tracking** - Resume capability if interrupted
4. **Partition by code area** - Focused analysis, no duplicate work
5. **Consistent output format** - Easy synthesis at the end
6. **Two-step axial drift** - `importlinter` + `axial-adr-review` catches structural and semantic drift
7. **Cocoindex confirmation** - Semantic search validates primary-agent findings with high recall

### What to Improve

1. **Agent result extraction** - Large JSONL outputs require careful handling
2. **Error recovery** - Some agents hit API errors; retry logic needed
3. **Domain-specific prompts** - Some domains need more specific focus areas
4. **Synthesis context** - Reading 67 output files requires context management
5. **Axial drift false positives** - `importlinter` catches structural violations, but `axial-adr-review` needs the axial ADR present; missing ADR = skip wave
6. **Cocoindex validation latency** - Semantic search adds ~2 min per confirmation; batch confirmations to reduce overhead
7. **N×M trap scoring** - `cocoindex` similarity > 0.85 is a reliable signal, but 0.70–0.90 requires human review; tune thresholds per project

---

## Reuse Instructions

### For a New Project

1. Create `artifacts/analyses/quality-audit/` directory
2. Copy `STRATEGY.md` and `AGENT_PROMPTS.md`
3. Adjust partition patterns to match project structure
4. Run wave-by-wave execution
5. Commit and push results

### Quick Start Command

```bash
# Initialize audit structure
mkdir -p artifacts/analyses/quality-audit/{axial-drift,architecture,security,code-smells,type-safety,async-patterns,error-handling,test-quality,tech-debt}

# Create manifest
cat > artifacts/analyses/quality-audit/manifest.json << 'EOF'
{"status": "pending", "started": null, "completed_agents": [], "pending_agents": [], "current_wave": 0, "waves": {}}
EOF
```

---

## Example: Lyra Audit Results

| Metric | Value |
|--------|-------|
| Files Analyzed | 282 source + 261 test |
| Total Issues | 160 |
| P0 (Critical) | 6 |
| P1 (High) | 19 |
| P2 (Medium) | 66 |
| P3 (Low) | 69 |
| Axial Drift Violations | 3 |
| N×M Traps | 2 |
| Cocoindex Confirmations | 8 |
| Technical Debt Score | 72/100 |
| Duration | ~45 minutes |
| Agents Used | 67 |

### Top Findings

1. **Path traversal vulnerability** in STT client
2. **Callback execution from metadata** without validation
3. **Zero test coverage** on production agents
4. **52.51% line coverage** with critical gaps
5. **Layer violations** between core/infrastructure
6. **Axial drift**: `infrastructure/stores/nats.py` and `redis.py` duplicate retry logic
7. **N×M trap**: Adapter-level auth checks duplicated across 3 adapters (confirmed by cocoindex search)

---

## References

- Original audit: `lyra/artifacts/analyses/quality-audit/`
- Commit: `ed2c394` on `staging` branch
- Date: 2026-04-22
