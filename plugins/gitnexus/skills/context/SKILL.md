---
name: gitnexus-context
argument-hint: '<symbol_name> [--file <path>] [--content]'
description: 360-degree view of a code symbol — callers, callees, processes it participates in. Triggers: "symbol context" | "show callers" | "gitnexus context" | "who uses this" | "what does X call".
version: 0.1.0
allowed-tools: Bash, Read
---

# GitNexus Context

Get a 360° view of a single symbol: categorized incoming/outgoing references, process participation, file location.

## Entry

```
/gitnexus-context validateUser
/gitnexus-context AuthService --file src/services/auth.ts
/gitnexus-context getUser --uid "Function:src/db.ts:getUser#0"
```

¬symbol → → DP(B) provide a symbol name.

## Step 0 — Pre-flight

```bash
gitnexus status
```

¬indexed → → DP(B) run `/gitnexus-analyze` first.

## Step 1 — Run Context

```bash
gitnexus context "$SYMBOL" $FLAGS
```

| Flag | Effect |
|------|--------|
| `--file <path>` | Disambiguate common names |
| `--uid <uid>` | Direct UID from prior results (zero ambiguity) |
| `--content` | Include full symbol source code |
| `--repo <name>` | Target specific repo |

## Step 2 — Parse JSON Output

```json
{
  "symbol": {
    "name": "validateUser",
    "type": "Function",
    "file": "src/auth/validation.ts",
    "line": 42
  },
  "callers": [
    {"name": "loginHandler", "file": "src/auth/login.ts", "line": 15, "confidence": 1.0}
  ],
  "callees": [
    {"name": "checkToken", "file": "src/auth/tokens.ts", "line": 8}
  ],
  "processes": ["LoginFlow", "TokenRefresh"],
  "references": {
    "imports": [...],
    "extends": [...],
    "implements": [...]
  }
}
```

## Step 3 — Present Results

**Symbol:** `validateUser` (Function) — `src/auth/validation.ts:42`

**Callers (who calls this):**

| Symbol | File | Line | Confidence |
|--------|------|------|------------|
| loginHandler | src/auth/login.ts | 15 | 1.0 |
| apiMiddleware | src/api/middleware.ts | 8 | 1.0 |

**Callees (what this calls):**

| Symbol | File |
|--------|------|
| checkToken | src/auth/tokens.ts |
| logAttempt | src/utils/log.ts |

**Processes (execution flows):** LoginFlow, TokenRefresh

**Other references:** imports, extends, implements, field accesses

## Step 4 — Follow-up

- Planning to edit → `/gitnexus-impact $SYMBOL`
- Want process trace → see process paths above

$ARGUMENTS
