---
name: xcli
description: 'Twitter/X CLI actions — post, read timeline, search, like, retweet, bookmark. No API keys, cookie-based auth. Triggers: "tweet" | "post on x" | "xcli" | "twitter cli" | "x post" | "timeline" | "search x" | "like tweet" | "retweet" | "bookmark".'
version: 0.1.0
argument-hint: '[command] [args]'
allowed-tools: Bash
---

# XCLI Skill

Run Clix (Twitter/X CLI) commands inside the containerized instance on M1.

Let:
  C := `ssh roxabituwer "podman exec clix clix"`

## Workflow

1. **Map intent** → clix subcommand + args
2. **Execute** via `$C <cmd> <args> --json`
3. **Parse JSON** → present result

## Commands

### Post a tweet

```bash
$C post "Hello world" --json
$C post "Reply text" --reply-to <tweet_id> --json
```

### Read timeline

```bash
$C feed --count 20 --json
$C feed --type following --count 50 --json
```

### Search

```bash
$C search "query" --type Top --count 20 --json
$C search "query" --type Latest --json
```

### Tweet detail

```bash
$C tweet <tweet_id> --json
$C tweet <tweet_id> --thread --json
```

### User info

```bash
$C user <handle> --json
$C user tweets <handle> --json
```

### Interactions

```bash
$C like <tweet_id> --json
$C unlike <tweet_id> --json
$C retweet <tweet_id> --json
$C unretweet <tweet_id> --json
$C bookmark <tweet_id> --json
$C unbookmark <tweet_id> --json
```

### Bookmarks

```bash
$C bookmarks --count 20 --json
```

### Auth check

```bash
$C auth status --json
```

## Safety

- Check auth first on any write operation: `$C auth status --json`
- Auth fail → instruct user to run `ssh roxabituwer "podman exec clix clix auth set --token <t> --ct0 <c>"`
- Respect rate limits — add 2s delay between bulk ops
- All commands use `--json` for structured parseable output

## Error Handling

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Success | Parse JSON, show result |
| 2 | Auth error | Ask user to set credentials |
| 3 | Rate limit | Wait 60s, retry once |
| 1 | Other error | Show stderr, abort |

## Multi-line tweets

Use heredoc or escaped newlines:
```bash
$C post "Line 1
Line 2" --json
```

$ARGUMENTS
