---
name: xcli
description: 'Twitter/X CLI actions — post, read timeline, search, like, retweet, bookmark. No API keys, cookie-based auth. Triggers: "tweet" | "post on x" | "xcli" | "twitter cli" | "x post" | "timeline" | "search x" | "like tweet" | "retweet" | "bookmark".'
version: 0.1.0
argument-hint: '[command] [args]'
allowed-tools: Bash, Read, Write, Edit
---

# XCLI Skill

Wrapper around the containerized Clix CLI on M1. Uses the local script `~/.roxabi/clix/bin/xcli` which reads config from `~/.roxabi/clix/config.json`.

## Config

File: `~/.roxabi/clix/config.json`

```json
{
  "host": "localhost",
  "container": "clix"
}
```

- `host`: `localhost` for local podman exec, or `roxabituwer` for SSH remote
- `container`: name of the running clix container

## Authenticate

Browser cookie extraction does not work inside the container. Use manual auth:

```bash
podman exec clix clix auth set --token <auth_token> --ct0 <ct0>
```

Or via the wrapper (reads same container):

```bash
~/.roxabi/clix/bin/xcli auth set --token <t> --ct0 <c>
```

## Commands

All commands return JSON by default. Use `--no-json` for human output.

### Post a tweet

```bash
~/.roxabi/clix/bin/xcli post "Hello world"
~/.roxabi/clix/bin/xcli post "Reply text" --reply-to <tweet_id>
```

### Read timeline

```bash
~/.roxabi/clix/bin/xcli feed --count 20
~/.roxabi/clix/bin/xcli feed --type following --count 50
```

### Search

```bash
~/.roxabi/clix/bin/xcli search "query" --type Top --count 20
~/.roxabi/clix/bin/xcli search "query" --type Latest
```

### Tweet detail

```bash
~/.roxabi/clix/bin/xcli tweet <tweet_id>
~/.roxabi/clix/bin/xcli tweet <tweet_id> --thread
```

### User info

```bash
~/.roxabi/clix/bin/xcli user <handle>
~/.roxabi/clix/bin/xcli user tweets <handle>
```

### Interactions

```bash
~/.roxabi/clix/bin/xcli like <tweet_id>
~/.roxabi/clix/bin/xcli unlike <tweet_id>
~/.roxabi/clix/bin/xcli retweet <tweet_id>
~/.roxabi/clix/bin/xcli unretweet <tweet_id>
~/.roxabi/clix/bin/xcli bookmark <tweet_id>
~/.roxabi/clix/bin/xcli unbookmark <tweet_id>
```

### Bookmarks

```bash
~/.roxabi/clix/bin/xcli bookmarks --count 20
```

### Auth check

```bash
~/.roxabi/clix/bin/xcli auth status
```

## Workflow

1. Check config exists → if not, create default `localhost` config
2. Check auth before any write operation
3. Run command through wrapper script
4. Parse JSON → present result

## Safety

- Auth fail → instruct user to set credentials
- Respect rate limits — add 2s delay between bulk ops
- All commands use JSON by default for parseable output

## Error Handling

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Success | Parse JSON |
| 1 | Usage error | Show help |
| 2 | Auth error | Ask user to set credentials |
| 3 | Rate limit | Wait 60s, retry once |

$ARGUMENTS
