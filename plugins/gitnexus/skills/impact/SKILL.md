---
name: gitnexus-impact
argument-hint: '<symbol_name> [--direction upstream|downstream] [--depth N]'
description: Blast radius analysis — what breaks if you change a symbol. Triggers: "impact analysis" | "what breaks if" | "blast radius" | "gitnexus impact" | "is it safe to change" | "dependencies of".
version: 0.1.0
allowed-tools: Bash, Read
---

# GitNexus Impact

Blast radius analysis: find what breaks if you change a symbol. Essential before refactoring.

## Entry

```
/gitnexus-impact validateUser
/gitnexus-impact AuthService --direction downstream
/gitnexus-impact processOrder --depth 2
```

¬symbol → → DP(B) provide a symbol name.

## Step 0 — Pre-flight

```bash
gitnexus status
```

¬indexed → → DP(B) run `/gitnexus-analyze` first.

## Step 1 — Run Impact Analysis

```bash
gitnexus impact "$SYMBOL" $FLAGS
```

| Flag | Effect |
|------|--------|
| `--direction upstream` | Who depends on this (default) |
| `--direction downstream` | What this depends on |
| `--depth N` | Max relationship depth (default: 3) |
| `--include-tests` | Include test files |
| `--repo <name>` | Target specific repo |

## Step 2 — Parse JSON Output

```json
{
  "target": "validateUser",
  "direction": "upstream",
  "callers": [
    {
      "name": "loginHandler",
      "file": "src/auth/login.ts",
      "line": 42,
      "depth": 1,
      "confidence": 1.0
    }
  ],
  "risk_level": "HIGH",
  "affected_processes": ["LoginFlow", "TokenRefresh"],
  "summary": {
    "d1_count": 2,
    "d2_count": 5,
    "d3_count": 12
  }
}
```

## Step 3 — Present Results

**Target:** `validateUser`

**Direction:** upstream (what depends on this)

**Risk Level:** HIGH

---

**Depth 1 — WILL BREAK (direct callers):**

| Symbol | File | Line |
|--------|------|------|
| loginHandler | src/auth/login.ts | 42 |
| apiMiddleware | src/api/middleware.ts | 15 |

**Depth 2 — LIKELY AFFECTED:**

| Symbol | File |
|--------|------|
| authRouter | src/routes/auth.ts |
| sessionManager | src/auth/session.ts |

**Depth 3 — MAY NEED TESTING:**

12 transitive dependencies...

---

**Affected Processes:** LoginFlow, TokenRefresh

## Step 4 — Risk Assessment

| Affected | Risk |
|----------|------|
| <5 symbols, few processes | LOW |
| 5-15 symbols, 2-5 processes | MEDIUM |
| >15 symbols or many processes | HIGH |
| Critical path (auth, payments) | CRITICAL |

**HIGH or CRITICAL risk →** warn user before proceeding with edits.

## Step 5 — Recommendation

- **LOW:** Safe to edit, verify tests pass
- **MEDIUM:** Review d=1 items, update them, run integration tests
- **HIGH:** Draft plan, update all d=1 callers, full test suite
- **CRITICAL:** Flag to user — may need broader coordination

$ARGUMENTS
