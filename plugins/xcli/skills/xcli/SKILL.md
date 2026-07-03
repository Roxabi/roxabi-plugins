---
name: xcli
description: 'Twitter/X CLI — post, read timeline, search, like, retweet, bookmark. Cookie-based auth with live browser refresh before writes. Triggers: "tweet" | "post on x" | "xcli" | "twitter cli" | "x post" | "timeline" | "search x" | "like tweet" | "retweet" | "bookmark" | "auth refresh".'
version: 0.2.0
argument-hint: '[command] [args]'
allowed-tools: Bash, Read, Write, Edit
---

# XCLI Skill

Twitter/X CLI for Roxabi. Cookie auth, no API keys. Write commands auto-refresh cookies from the live browser session before posting.

## Invocation paths

| Context | Binary |
|---|---|
| Local dev checkout | `~/projects/roxabi-xcli/.venv/bin/clix` |
| PyPI / generic | `uvx clix0` or `clix` on PATH |
| M1 container | `~/.roxabi/clix/bin/xcli` (reads `~/.roxabi/clix/config.json`) |

Prefer local venv on the workstation; use the container wrapper only when posting from M1.

## Auth

Stored credentials: `~/.config/clix/auth.json` (multi-account: `pro`, `perso`, …).

```bash
# First-time setup — extract from Opera Developer (Linux)
clix auth login --browser opera-developer --account pro

# Manual refresh (optional — writes also refresh automatically)
clix auth refresh --account pro

# Check
clix auth status --account pro --json
```

**Write flow (automatic on every `post` / `like` / `rt` / …):**

1. Read live cookies from `write.refresh_browser` (default `opera-developer`)
2. Persist full jar to the active account in `auth.json`
3. Warm up session (`GET /home`) if `write.warmup = true`
4. Enforce `write.min_interval_seconds` cooldown (default 45s)
5. POST with stable TLS impersonate (`chrome131`)
6. On X errors 226/344 → backoff 60s/300s, refresh cookies, retry

## Config

`~/.config/clix/config.toml` — create only if you need overrides:

```toml
[write]
refresh_browser = "opera-developer"
min_interval_seconds = 45
impersonate = "chrome131"
warmup = true
```

Disable browser refresh: `CLIX_REFRESH_BROWSER=none` or `refresh_browser = null` in TOML (not recommended for writes).

## Commands

All commands support `--json`. Use `--account pro` to target a stored account.

### Post a tweet

```bash
clix post "Hello world"
clix post "Reply text" --reply-to <tweet_id> --account pro
```

Wait at least 45s between posts. If you get exit code 3 (rate limit / anti-bot), wait several minutes before retrying.

### Read timeline

```bash
clix feed --count 20
clix feed --type following --count 50
```

### Search

```bash
clix search "query" --type Latest --count 20
```

### Interactions (all use write hardening)

```bash
clix like <tweet_id>
clix unlike <tweet_id>
clix retweet <tweet_id>
clix unretweet <tweet_id>
clix bookmark <tweet_id>
clix unbookmark <tweet_id>
clix delete <tweet_id> --force
```

### Auth

```bash
clix auth status
clix auth refresh [--account pro] [--browser opera-developer]
clix auth login --browser opera-developer --account pro
clix auth import cookies.json --account pro
```

## Agent workflow

1. Before any write: ensure user is logged into X in Opera Developer
2. Run write command — refresh is automatic; do **not** burst multiple posts in one turn
3. On exit 2 → auth missing/expired → `clix auth refresh` or ask user to re-login in browser
4. On exit 3 → cooldown or X anti-bot → wait, then single retry (do not loop)

## Error handling

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Success | Parse JSON |
| 1 | Usage / API error | Show help or error body |
| 2 | Auth error | `clix auth refresh` or `clix auth login` |
| 3 | Write cooldown or anti-bot (226/344) | Wait 60s+, refresh, retry once |

## M1 container note

Browser cookie extraction does not work inside the container. For containerized use, refresh on the host then copy tokens:

```bash
# host
clix auth refresh --account pro
podman exec clix clix auth set --token <auth_token> --ct0 <ct0>
```

Or mount/sync `~/.config/clix/auth.json` into the container.

$ARGUMENTS