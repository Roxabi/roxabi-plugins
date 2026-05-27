# roxabi-xcli

Twitter/X CLI tool (Clix fork) — Claude Code skill for direct posting, reading timelines, searching, and interacting on X without API keys.

## Skills

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/xcli` | "tweet", "post on x", "xcli", "twitter cli", "x post", "timeline", "search x" | Run Clix commands inside the containerized CLI on M1 |

## Prerequisites

- Clix container running on M1 (`clix` Quadlet unit)
- Cookies configured (`auth_token` + `ct0` from browser login)

## Usage

```
/xcli post "Hello world"
/xcli timeline --count 20
/xcli search "query"
/xcli like <tweet_id>
```

## Architecture

Skill → `ssh roxabituwer "podman exec clix clix <command>"` → JSON output → formatted result.
