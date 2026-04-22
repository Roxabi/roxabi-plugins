# Multi-Agent Code Quality Audit Playbook

## Overview

A reusable pattern for running comprehensive code quality audits using 67 parallel agents across 8 analysis domains. Produces actionable reports with prioritized findings and a technical debt score.

## Use Case

- Pre-release quality gate
- Quarterly code health assessment
- Post-refactor verification
- Security compliance review

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
Wave 1-2:   Architecture (8 agents)
Wave 3-4:   Security (8 agents)
Wave 5-6:   Code Smells (13 agents: 8 source + 5 test)
Wave 7-8:   Type Safety (8 agents)
Wave 9:     Async Patterns (8 agents)
Wave 10-11: Error Handling (8 agents)
Wave 12:    Test Quality (6 agents)
Wave 13-14: Tech Debt (8 agents)
Wave 15:    Synthesis (1 agent)
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

## Output Structure

```
artifacts/analyses/quality-audit/
├── STRATEGY.md              # Audit strategy definition
├── AGENT_PROMPTS.md         # Agent prompt templates
├── manifest.json            # Progress tracking
├── AUDIT-SUMMARY.md         # Final synthesized report
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
[Security vulns, data loss risks]

## High Priority (P1)
[Bugs, significant tech debt]

## Medium Priority (P2)
[Refactorings, improvements]

## Low Priority (P3)
[Minor cleanups]

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
| <50 files | 16 | 4 | 10 min |
| 50-200 files | 32 | 4 | 20 min |
| 200-500 files | 48 | 5 | 40 min |
| 500+ files | 67+ | 5 | 60+ min |

---

## Lessons Learned

### What Worked

1. **5-by-5 wave pattern** - Balanced parallelism without overwhelming context
2. **Background agents** - Main context stayed clean, received notifications on completion
3. **Manifest tracking** - Resume capability if interrupted
4. **Partition by code area** - Focused analysis, no duplicate work
5. **Consistent output format** - Easy synthesis at the end

### What to Improve

1. **Agent result extraction** - Large JSONL outputs require careful handling
2. **Error recovery** - Some agents hit API errors; retry logic needed
3. **Domain-specific prompts** - Some domains need more specific focus areas
4. **Synthesis context** - Reading 67 output files requires context management

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
mkdir -p artifacts/analyses/quality-audit/{architecture,security,code-smells,type-safety,async-patterns,error-handling,test-quality,tech-debt}

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
| Technical Debt Score | 72/100 |
| Duration | ~45 minutes |
| Agents Used | 67 |

### Top Findings

1. **Path traversal vulnerability** in STT client
2. **Callback execution from metadata** without validation
3. **Zero test coverage** on production agents
4. **52.51% line coverage** with critical gaps
5. **Layer violations** between core/infrastructure

---

## References

- Original audit: `lyra/artifacts/analyses/quality-audit/`
- Commit: `ed2c394` on `staging` branch
- Date: 2026-04-22
