## SC → Test Matrix

| SC | Test(s) | Status |
|----|---------|--------|
| SC-claim-parse: | `grep -q 'pf_claim_yaml_ok' plugins/dev-core/skills/pr/parse-falsify.sh` | ✓ proven |
| SC-claim-roster: | `grep -q 'spawn_security_auditor' plugins/dev-core/skills/code-review/claim-roster.ts` | ✓ proven |
| SC-skip-parity: | `grep -q 'spawn_security_auditor' plugins/dev-core/skills/code-review/SKILL.md` | ✓ proven |
| SC-glob-retention: | `grep -q '\*\*/auth/\*\*' plugins/dev-core/skills/code-review/SKILL.md` | ✓ proven |

## Falsification Evidence

broke plugins/dev-core/skills/pr/parse-falsify.sh → FAIL exit=2: grep: plugins/dev-core/skills/pr/parse-falsify.sh: No such file or directory 
broke plugins/dev-core/skills/code-review/claim-roster.ts → FAIL exit=2: grep: plugins/dev-core/skills/code-review/claim-roster.ts: No such file or directory 
broke plugins/dev-core/skills/code-review/SKILL.md → FAIL exit=2: grep: plugins/dev-core/skills/code-review/SKILL.md: No such file or directory 
broke plugins/dev-core/skills/code-review/SKILL.md → FAIL exit=2: grep: plugins/dev-core/skills/code-review/SKILL.md: No such file or directory 
