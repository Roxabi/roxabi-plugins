# roxabi-postiz

Postiz social media scheduler — Claude Code skill for planning, scheduling, and publishing posts across multiple platforms via the Postiz public API.

## Skills

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/postiz` | "schedule post", "planifier", "postiz", "publish to x", "social media" | Interact with Postiz API — create, list, delete scheduled posts; check integrations; view analytics |

## Prerequisites

- Postiz instance running (Quadlet on M1: `postiz-app` container @ `192.168.1.16:4007`)
- API token from Postiz settings

## Usage

```
/postiz create-post "Hello world" --platforms x,linkedin --schedule 2026-05-28T09:00:00Z
/postiz list-posts
/postiz list-integrations
/postiz analytics x
```

## Architecture

Skill → `curl` to Postiz `/public/v1` API → JSON response → formatted output.
