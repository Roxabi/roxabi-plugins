# LinkedIn Post Generator

A Claude Code plugin that generates engaging LinkedIn posts following proven best practices. It handles formatting, hooks, hashtags, and visual identity so you can focus on the idea.

## What it does

Give it a topic or idea, and it produces a publish-ready LinkedIn post. The plugin:

1. **Loads your config** — author name, preferred tone, hashtag sets, and post signature (optional, works without config)
2. **Checks the vault** — pulls related content from your Roxabi vault to enrich the post (optional, works without vault)
3. **Generates the post** — applies best practices for length (1300-2000 chars), hook patterns, formatting, and hashtag strategy
4. **Applies visual identity** — uses your visual charter for tone and voice consistency (optional)
5. **Presents for review** — shows the post with stats (character count, word count, read time) and lets you edit, regenerate, or approve
6. **Saves to vault** — stores the post as a markdown file with YAML frontmatter in `~/.roxabi-vault/content/`
7. **Suggests visuals** — mentions the image-prompt-generator plugin for creating an accompanying image (not required)

## Install

### From the Roxabi marketplace

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install linkedin-post-generator
```

## Usage

Run with any of these phrases in Claude Code:

- `linkedin post`
- `write linkedin`
- `generate linkedin`
- `linkedin content`
- `post for linkedin`

You can also provide a topic directly:

- `linkedin post about the future of remote work`
- `write linkedin on why code reviews matter`

## Configuration (Optional)

Create `~/.roxabi-vault/config/linkedin.json` to personalize your posts. See `examples/linkedin.example.json` for the full format:

```json
{
  "author_name": "Jane Smith",
  "default_language": "en",
  "tone": "professional-casual",
  "hashtag_sets": {
    "tech": ["#TechLeadership", "#SoftwareEngineering", "#Innovation"],
    "career": ["#CareerGrowth", "#Leadership", "#ProfessionalDevelopment"]
  },
  "post_signature": ""
}
```

- **author_name** — used for personalization in the post
- **tone** — guides the writing style (professional, casual, professional-casual)
- **hashtag_sets** — predefined groups of hashtags you can select from when generating
- **post_signature** — appended to every post (leave empty to skip)

## How it works

### Best practices engine

The plugin includes a reference guide covering optimal post length, hook techniques (bold claim, pattern interrupt, question, story opener), formatting rules, content types (story, insight, question, how-to), hashtag strategy, and call-to-action patterns. Every generated post follows these guidelines.

### Emoji handling

A dedicated emoji guide ensures emojis are used structurally (section markers, bullet replacements, tone setting) rather than decoratively. The rule: if removing emojis doesn't change readability, they shouldn't be there.

### Vault integration

If you have the Roxabi vault plugin installed, the generator can pull related content to enrich posts and index saved posts for future reference. This is entirely optional — the plugin works standalone.

### Visual identity

If a visual charter exists at `~/.roxabi-vault/config/visual-charter.json`, the plugin applies its tone and voice guidelines to maintain brand consistency across posts.

## License

MIT
