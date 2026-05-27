---
name: postiz
description: 'Postiz social media scheduler — plan, create, list, delete posts and check analytics across X, LinkedIn, Reddit, and more. Triggers: "schedule post" | "planifier" | "postiz" | "publish to x" | "social media" | "post" | "analytics" | "integrations".'
version: 0.1.0
argument-hint: '[action] [args]'
allowed-tools: Read, Bash, WebFetch
---

# Postiz Skill

Interact with a self-hosted Postiz instance via its public API (`/public/v1`).

Let:
  P := Postiz base URL = `http://192.168.1.16:4007/api` (M1 Quadlet)
  T := API token (from Postiz settings → API tokens)

## Workflow

1. **Identify intent** from argument / conversation context
2. **Build curl command** to `P/public/v1/<endpoint>`
3. **Parse JSON** → present terse result

## Actions

### Create post

```bash
curl -s -X POST "$P/public/v1/posts" \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "schedule",
    "posts": [
      {
        "value": [
          {
            "content": ["Hello world"],
            "image": [],
            "integration": "<integration_id>"
          }
        ]
      }
    ]
  }'
```

### List posts

```bash
curl -s "$P/public/v1/posts" -H "Authorization: Bearer $T" | jq '.posts[] | {id, status, date}'
```

### List integrations

```bash
curl -s "$P/public/v1/integrations" -H "Authorization: Bearer $T" | jq '.[] | {id, name, identifier}'
```

### Check analytics

```bash
curl -s "$P/public/v1/analytics/<integration>?date=<YYYY-MM-DD>" -H "Authorization: Bearer $T"
```

### Upload media

```bash
curl -s -X POST "$P/public/v1/upload" \
  -H "Authorization: Bearer $T" \
  -F "file=@/path/to/image.png"
```

## Safety

- Never expose `$T` in output
- Validate `date` format before API call
- Check auth first: `curl -s "$P/public/v1/is-connected"`

## Error Handling

| HTTP | Meaning | Action |
|------|---------|--------|
| 401 | Bad token | Ask user to regenerate API token |
| 429 | Rate limit | Backoff 5s, retry once |
| 400 | Validation fail | Show `msg` field from response |
| 500 | Server error | Surface error, abort |

$ARGUMENTS
