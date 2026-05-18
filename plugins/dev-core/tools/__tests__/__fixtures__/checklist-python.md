---
version: 1
---

# Python Test Checklist

## Concerns

```yaml
- id: python-only
  applies_when: ["runtime=python"]
  setup_snippet: |
    echo "python setup"
  teardown_snippet: |
    echo "python teardown"
  validation: "runs only when runtime is python"

- id: universal
  applies_when: ["env_files=present"]
  setup_snippet: |
    echo "env files present"
  teardown_snippet: |
    :
  validation: "runs when env_files is non-empty"
```
