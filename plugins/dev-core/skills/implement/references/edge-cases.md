# Implement Edge Cases

| Scenario | Behavior |
|----------|----------|
| No plan found (Tier F) | Suggest `/plan`. Stop. |
| No plan found (Tier S) | Locate spec or issue body. Proceed to Tier S direct implementation. |
| Size XS confirmed by lead | Skip worktree, direct branch |
| Typecheck fails during impl | Agents fix in-loop. 3✗ → escalate to lead |
| Issue already exists | Use existing, inform user |
| Branch already exists | Warn, ask: reuse ∨ recreate |
| Worktree dir exists | Warn, ask: reuse ∨ cleanup |
| Spec has no file list | Infer from feature description |
| Tests fail during impl | Agents fix + re-test loop |
| Pre-commit hook failure | Fix, re-stage, NEW commit (¬amend) |
| Agent blocked | Report to user for guidance |
| Verify cmd references missing file | Mark deferred. Post-RED fail → escalate. |
