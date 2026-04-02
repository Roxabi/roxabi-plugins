---
name: linkedin-post-generator
description: 'Generate engaging LinkedIn posts with best practices, visual identity, and vault integration. Triggers: "linkedin post" | "write linkedin" | "generate linkedin" | "linkedin content" | "post for linkedin".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob, Grep
---

# LinkedIn Post Generator

**Goal:** Generate a publish-ready LinkedIn post from a topic or idea, following best practices and the author's visual identity.

Let:
  LC := ~/.roxabi-vault/config/linkedin.json    — author config (optional)
  CH := ~/.roxabi-vault/config/visual-charter.json — visual charter (optional)
  VC := ~/.roxabi-vault/content/               — post output dir

## Phase 1 — Configuration

Load LC if ∃: author name, default language, tone, hashtag sets, post signature. ¬LC → defaults (professional-casual tone, English). Load CH if ∃.

## Phase 2 — Topic Input

∃ topic in $ARGUMENTS → use it. Otherwise ask directly (Pattern B — no protocol read needed): topic/idea. Present via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern C) for preferences: tone override, target audience, content type (story/insight/question/how-to), hashtag set.

## Phase 3 — Research (Optional)

```bash
python3 -c "
import sys; sys.path.insert(0, '$CLAUDE_PLUGIN_ROOT/../..')
from roxabi_sdk.paths import vault_healthy
print('VAULT_OK' if vault_healthy() else 'VAULT_UNAVAILABLE')
"
```

VAULT_OK → search related content:
```bash
python3 -c "
import sqlite3, json
from pathlib import Path
home = Path.home() / '.roxabi-vault'
conn = sqlite3.connect(str(home / 'vault.db'))
rows = conn.execute(
    'SELECT title, substr(content, 1, 200) FROM entries WHERE category = \"content\" ORDER BY created_at DESC LIMIT 5'
).fetchall()
conn.close()
for r in rows: print(json.dumps({'title': r[0], 'preview': r[1]}))
"
```

VAULT_UNAVAILABLE → skip; generate from topic alone.

## Phase 4 — Generate Post

```bash
cat "$CLAUDE_PLUGIN_ROOT/../../references/linkedin_best_practices.md"
cat "$CLAUDE_PLUGIN_ROOT/../../references/emoji_guide.md"
```

Apply rules: 1300-2000 chars; strong hook (pattern interrupt/bold claim/question/story opener); 1-3 sentence paragraphs; line breaks between paragraphs; bullet/numbered lists where appropriate; 3-5 hashtags at end; clear CTA in closing; emojis sparingly per guide. ∃CH → apply tone/voice. ∃LC signature → append.

## Phase 5 — Review

Present post in code block. Show stats: character count, word count, estimated read time, hashtag count. Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A):
- **Publish as-is** → Phase 6
- **Edit** → describe changes → regenerate
- **Regenerate** → different angle → Phase 4
- **Cancel** → discard

## Phase 6 — Save

```bash
mkdir -p -m 700 ~/.roxabi-vault/content
timestamp=$(date +%Y%m%d_%H%M%S)
# Write as: linkedin_${timestamp}.md
```

Write with YAML frontmatter:
```yaml
---
type: linkedin-post
title: "<topic summary>"
created: "<ISO 8601 timestamp>"
status: draft
hashtags: [<hashtags used>]
---
```
Followed by post body.

## Phase 7 — Index (Optional)

VAULT_OK → index:
```bash
python3 -c "
import sqlite3, json
from pathlib import Path
from datetime import datetime
home = Path.home() / '.roxabi-vault'
conn = sqlite3.connect(str(home / 'vault.db'))
conn.execute('''INSERT INTO entries (category, type, title, content, metadata, created_at)
    VALUES ('content', 'linkedin-post', ?, ?, '{}', ?)''',
    ('<title>', '<full post content>', datetime.now().isoformat()))
conn.commit()
conn.close()
"
```
VAULT_UNAVAILABLE → skip; file saved locally.

## Phase 8 — Visual Companion

To generate a matching visual, run the **image-prompt** skill next.

$ARGUMENTS
