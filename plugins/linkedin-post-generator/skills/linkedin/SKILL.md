---
name: linkedin-post-generator
description: 'Generate engaging LinkedIn posts with best practices, visual identity, and vault integration. Triggers: "linkedin post" | "write linkedin" | "generate linkedin" | "linkedin content" | "post for linkedin".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob, Grep
---

# LinkedIn Post Generator

**Goal:** Generate a publish-ready LinkedIn post from a topic or idea, following best practices and the author's visual identity.

## Instructions

### Phase 1 — Configuration

1. Check for author config at `~/.roxabi-vault/config/linkedin.json` (optional).
2. Check for visual charter at `~/.roxabi-vault/config/visual-charter.json` (optional).
3. If config exists, load author name, default language, tone, hashtag sets, and post signature.
4. If no config exists, proceed with sensible defaults (professional-casual tone, English).

### Phase 2 — Topic Input

1. If the user provided a topic or idea via arguments, use it.
2. Otherwise, AskUserQuestion: "What topic or idea should the LinkedIn post be about?"
3. AskUserQuestion for any preferences: tone override, target audience, content type (story, insight, question, how-to), hashtag set.

### Phase 3 — Research (Optional)

1. Check if vault is available by running:
```bash
python3 -c "
import sys; sys.path.insert(0, '$(dirname \"$0\")/scripts')
from _lib.paths import vault_healthy
print('VAULT_OK' if vault_healthy() else 'VAULT_UNAVAILABLE')
"
```
2. If vault is healthy, search for related content that could enrich the post:
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
3. If vault is unavailable, skip this phase — the post will be generated from the topic alone.

### Phase 4 — Generate Post

1. Read the best practices reference:
```bash
cat "$(dirname "$0")/references/linkedin_best_practices.md"
```
2. Read the emoji guide reference:
```bash
cat "$(dirname "$0")/references/emoji_guide.md"
```
3. Generate the post applying these rules:
   - Length: 1300-2000 characters (the LinkedIn sweet spot)
   - Strong hook in the first line (pattern interrupt, bold claim, question, or story opener)
   - Short paragraphs (1-3 sentences max)
   - Line breaks between paragraphs for readability
   - Use bullet points or numbered lists where appropriate
   - 3-5 relevant hashtags at the end
   - Clear call-to-action in the closing
   - Emojis used sparingly per the emoji guide
4. If visual charter exists, apply tone and voice guidelines from it.
5. If author config has a post signature, append it.

### Phase 5 — Review

1. Present the generated post to the user in a code block.
2. Show post statistics: character count, word count, estimated read time, hashtag count.
3. AskUserQuestion with options:
   - **Publish as-is** — save the post
   - **Edit** — describe changes to make
   - **Regenerate** — start over with different angle
   - **Cancel** — discard

### Phase 6 — Save

1. Save the post to `~/.roxabi-vault/content/` with timestamp filename:
```bash
mkdir -p -m 700 ~/.roxabi-vault/content
timestamp=$(date +%Y%m%d_%H%M%S)
# File will be written as: linkedin_${timestamp}.md
```
2. Write the file with YAML frontmatter:
```yaml
---
type: linkedin-post
title: "<topic summary>"
created: "<ISO 8601 timestamp>"
status: draft
hashtags: [<hashtags used>]
---
```
3. Followed by the post body.

### Phase 7 — Index (Optional)

1. If vault is healthy, index the new post:
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
2. If vault is unavailable, skip — the file is saved locally regardless.

### Phase 8 — Visual Companion

1. If the post would benefit from an accompanying image, mention that the user can use the **image-prompt-generator** plugin to create a matching visual.
2. This is a suggestion, not a hard dependency — the post is complete without it.

$ARGUMENTS
