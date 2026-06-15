# First Principles Cookbook for AI Code Development

Irreducible building blocks + concrete recipes.

---

## The 5 Irreducible Blocks

| Block | Definition | Verification |
|---|---|---|
| **Intent** | What success looks like | Test/grep/read proves it |
| **Decomposition** | Atomic work units | Each unit independently verifiable |
| **Verification** | Ground-truth feedback | Tests pass, compiler clean, lint clear |
| **State** | Cross-context persistence | Git, JSON files, memory system |
| **Tool definitions** | Precise schemas | Input/output types, preconditions |

**Core principle:** Never trust → always verify with evidence.

---

## Recipe 1: Before Starting Any Task

```markdown
## Intent Check (pre-flight)

1. **Success criterion:** [single verifiable statement]
2. **Evidence method:** [test name | grep pattern | file path]
3. **Atomic steps:** [list of independently verifiable units]

If any line is blank → STOP and clarify.
```

**Example:**
```
Success: voiceCLI --text "hello" outputs audio file
Evidence: test_tts_basic.py passes
Steps: 1) read config schema 2) implement generate() 3) add test
```

---

## Recipe 2: Decomposition Pattern

**Rule:** A step is atomic if:
- It produces **one** verifiable artifact (file, test, output)
- It can be **completed** in a single agent turn
- Failure is **traceable** to that step alone

**Pattern:**
```
Task: "Add retry logic to API client"

❌ Bad decomposition:
  - Improve API client reliability

✅ Good decomposition:
  1. Read current client code → identify call sites
  2. Add retry decorator to _request method
  3. Add unit test for retry on 503
  4. Run test → verify pass
```

---

## Recipe 3: Verification Loop

```markdown
## Evaluator-Optimizer Cycle

1. Model produces output
2. Model self-checks against success criterion
3. If fail → model diagnoses from ground-truth (test output, error)
4. Model patches → re-run verification
5. Repeat until pass or max iterations (3)
```

**Implementation in prompt:**
```
After making changes:
1. Run the relevant test
2. If test fails, read the error output
3. Fix the specific issue identified
4. Re-run until pass
Report final test status.
```

---

## Recipe 4: State Persistence

**Rule:** Any task spanning >1 context window needs explicit state.

**Pattern:**
```
# Progress file: .claude/progress/<task-id>.json

{
  "task": "Add retry logic",
  "steps": [
    {"id": 1, "desc": "Read client code", "status": "done", "artifact": "src/client.py"},
    {"id": 2, "desc": "Add retry decorator", "status": "in_progress"},
    {"id": 3, "desc": "Add test", "status": "pending"}
  ],
  "blocked_by": null,
  "next_action": "Add @retry decorator to _request method"
}
```

**When to use:**
- Multi-day tasks
- Tasks requiring user input mid-stream
- Tasks with complex dependency chains

---

## Recipe 5: Tool Definition Hygiene

**Bad:**
```python
def process(data):
    """Process the data."""
    ...
```

**Good:**
```python
def process(data: dict[str, Any]) -> dict[str, Any]:
    """
    Transform input data to output format.

    Preconditions:
    - data must contain 'id' key
    - data['id'] must be valid UUID string

    Returns:
    - {'status': 'ok', 'result': ...} on success
    - {'status': 'error', 'message': ...} on failure
    """
```

**Rule:** Every tool needs input type + output type + preconditions.

---

## Recipe 6: Intent-First Skill Design

**Template for skill definition:**

```markdown
---
name: my-skill
intent: [single-line success criterion]
verification: [how to verify success]
---

## Purpose
[Why this skill exists]

## Success Criterion
[Measurable outcome]

## Steps
1. [atomic step 1] → verify: [method]
2. [atomic step 2] → verify: [method]
...

## Failure Mode
If [condition], report [diagnostic] and STOP.
```

**Example:**
```markdown
---
name: test-coverage
intent: Achieve 80% coverage on modified files
verification: pytest --cov output shows ≥80%
---
```

---

## Recipe 7: Anti-Patterns Checklist

| Anti-pattern | Why it fails | Fix |
|---|---|---|
| "Refactor X" (no criterion) | Intent unclear | "Refactor X so tests pass in <1s" |
| "Fix bugs" (no scope) | Decomposition vague | "Fix bugs A, B, C in file Y" |
| Trusting model's "it works" | No verification | Require test run + output |
| 50-step plan | Not atomic | Break into subtasks with state |
| "Make it better" | Subjective | "Reduce cyclomatic complexity to <10" |

---

## Recipe 8: First-Principles Debug

**When stuck:**

```
1. State the problem as a claim
2. What evidence would prove/disprove it?
3. Gather that evidence (read file, run test, grep)
4. Update claim based on evidence
5. Repeat until root cause identified
```

**Example:**
```
Claim: "The API is timing out"
Evidence: Check logs → "connection refused"
Updated claim: "The API server isn't running"
Evidence: Check supervisor → program stopped
Root cause: supervisor config missing autostart=true
```

---

## Applying to dev-core

| dev-core phase | First-principles check |
|---|---|
| **plan** | Intent explicit? Steps atomic? State defined? |
| **implement** | Each step verifiable? Ground-truth feedback loop? |
| **test** | Success criterion met? Evidence captured? |
| **release** | Verification complete? State persisted (git tag)? |

---

## Quick Reference Card

```
INTENT    → Success criterion + evidence method
DECOMPOSE → Atomic steps, each verifiable
VERIFY    → Test run → read output → patch → re-run
STATE     → JSON progress file for multi-window tasks
TOOLS     → Input type + output type + preconditions
```

**Before any task, ask:**
1. What does success look like?
2. How will I verify it?
3. What's the smallest first step?
