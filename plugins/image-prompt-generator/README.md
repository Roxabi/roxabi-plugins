# Image Prompt Generator

A Claude Code plugin that generates AI image prompts with visual identity and style consistency. It turns a simple concept into multiple prompt variants across different artistic styles, optionally aligned to your brand.

## What it does

Describe what you want to see, and the plugin generates multiple ready-to-use prompts for image generation tools like DALL-E, Midjourney, Stable Diffusion, and Flux.

When you run the generator, the plugin:

1. **Loads your visual charter** (optional) — brand colors, style preferences, and avoidances from `~/.roxabi-vault/config/visual-charter.json`
2. **Runs a structured intake** — asks about platform, content type, mood/tone, style preference, and aspect ratio to build a creative brief
3. **Handles face references** (optional) — asks if you want your likeness in the image; saves and reuses your appearance description across sessions
4. **Generates prompt variants** — 4-6 prompts across different styles (photography, illustration, digital art, 3D rendering)
5. **Applies brand identity** — if a charter exists, aligns colors, mood, and style to your brand; tags each variant as on-brand, near-brand, or off-brand
6. **Auto-saves to vault** — writes all variants to `~/.roxabi-vault/image-prompts/` before presenting
7. **Presents variants** — structured output with style, composition, lighting, and mood details
8. **Lets you refine** — pick a variant, request changes, or regenerate with different styles
9. **Batch generation** — optionally run the Python script for bulk prompt creation

## Install

### From the Roxabi marketplace

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install image-prompt-generator
```

## Usage

Run the generator with any of these phrases in Claude Code:

- `image-prompt`
- `generate image prompt`
- `image prompt`
- `prompt for image`
- `visual prompt`

### Examples

```
image-prompt a cozy coffee shop on a rainy afternoon
```

```
generate image prompt product shot of wireless headphones for social media
```

```
visual prompt team collaboration scene for company website
```

### Visual charter (optional)

Create a visual charter to keep prompts aligned with your brand identity. Copy the example and customize it:

```bash
mkdir -p ~/.roxabi-vault/config
cp examples/visual-charter.example.json ~/.roxabi-vault/config/visual-charter.json
```

Edit the file with your brand colors, style preferences, and avoidances.

### Batch generation

For generating many variants at once, use the Python script directly:

```bash
python3 scripts/generate_prompt_variants.py --concept "a mountain landscape at sunset" --count 8
```

With a visual charter:

```bash
python3 scripts/generate_prompt_variants.py --concept "a mountain landscape at sunset" --charter ~/.roxabi-vault/config/visual-charter.json
```

## When to use

- Creating consistent visual content for a brand
- Exploring different artistic styles for a concept
- Generating prompts for AI image tools (DALL-E, Midjourney, Stable Diffusion, Flux)
- Building a library of prompt templates for recurring visual needs
- Quick iteration on visual concepts before committing to a style

## How it works

### Structured intake

Before generating prompts, the plugin builds a creative brief from your answers:

| Question | Purpose |
|----------|---------|
| Platform | Instagram, LinkedIn, website, presentation, thumbnail |
| Content type | Personal brand, product, educational, promotional, lifestyle |
| Mood/tone | Professional, warm, dramatic, energetic, minimal, mysterious |
| Style preference | Photographic, illustrated, 3D, or no preference |
| Aspect ratio | Square 1:1, portrait 4:5/9:16, landscape 16:9 |

Composition, lighting, and framing in every variant are driven by these answers.

### Face reference

When you want your likeness in the image, the plugin asks for an appearance description (hair, eye color, age range, skin tone, distinctive features) and saves it to `~/.roxabi-vault/config/face-reference.json`. On future sessions it loads the saved description and asks if it's still accurate — no re-entering needed.

### Style coverage

The plugin generates variants across multiple categories to give you a range of options:

| Category | Examples |
|----------|---------|
| Photography | Cinematic lifestyle, editorial, street, macro |
| Illustration | Flat design, isometric, hand-drawn, vector |
| Art | Watercolor, oil painting, minimalist, abstract |
| Rendering | 3D render, cel-shaded, low poly, photorealistic |

### Brand alignment

When a visual charter is loaded, each variant is tagged:

- **On-brand** — fully aligned with charter colors, style, and mood
- **Near-brand** — creative interpretation within brand guidelines
- **Off-brand** — deliberately divergent for exploration

### Auto-save

All variants are automatically saved to `~/.roxabi-vault/image-prompts/YYYYMMDD_<concept-slug>.md` before being presented. Nothing is lost if you close the session.

### Reference files

The plugin includes two reference files that guide prompt generation:

- `references/artistic_styles.md` — prompt-ready phrases for dozens of styles
- `references/prompt_best_practices.md` — structure, platform tips, and common mistakes

## License

MIT
