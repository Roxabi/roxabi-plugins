---
name: postiz
description: 'Postiz social media scheduler — plan, create, list, delete posts and check analytics across X, LinkedIn, Reddit, and more. Triggers: "schedule post" | "planifier" | "postiz" | "publish to x" | "social media" | "post" | "analytics" | "integrations".'
version: 0.1.0
argument-hint: '[command] [args]'
allowed-tools: Bash, Read, Write, Edit
---

# Postiz Skill

Wrapper around a self-hosted Postiz instance. Uses the local CLI script `~/.roxabi/postiz/bin/postiz` which reads config from `~/.roxabi/postiz/config.json`.

## Config

File: `~/.roxabi/postiz/config.json`

```json
{
  "base_url": "http://192.168.1.16:4007/api",
  "token": "<your-api-token>"
}
```

Get the API token from Postiz Settings → API Tokens.

## Commands

All commands return JSON. Pipe through `jq` for pretty display.

### Check connection / auth

```bash
~/.roxabi/postiz/bin/postiz status
```

### List connected platforms

```bash
~/.roxabi/postiz/bin/postiz list-integrations
```

### List scheduled posts

```bash
~/.roxabi/postiz/bin/postiz list-posts
```

### Create a post

```bash
~/.roxabi/postiz/bin/postiz create-post "Hello world" <integration_id>
```

For multiple platforms, comma-separate IDs:
```bash
~/.roxabi/postiz/bin/postiz create-post "Hello world" id1,id2,id3
```

### Delete a post

```bash
~/.roxabi/postiz/bin/postiz delete-post <post_id>
```

### Analytics

```bash
~/.roxabi/postiz/bin/postiz analytics <integration_id> [YYYY-MM-DD]
```

Default date = today.

### Upload media

```bash
~/.roxabi/postiz/bin/postiz upload /path/to/image.png
```

### Find next free slot

```bash
~/.roxabi/postiz/bin/postiz find-slot [integration_id]
```

## Workflow

1. Check config exists → if not, ask user for `base_url` and `token`
2. Run the requested command through the wrapper script
3. Parse JSON output → present result

## Safety

- Never expose token in output
- If `status` returns auth error → ask user to set token in config
- Validate integration IDs exist before `create-post` if possible

## Error Handling

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Success | Parse JSON |
| 1 | Usage error | Show help |
| 2 | Config/auth error | Ask user to fix `config.json` |

$ARGUMENTS
