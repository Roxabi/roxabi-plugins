---
version: 1
---

# Bun Test Checklist (malformed — missing validation field)

## Concerns

```yaml
- id: bun-only
  applies_when: ["runtime=bun"]
  setup_snippet: |
    bun install
  teardown_snippet: |
    :
```
