# Prompt Best Practices

How to write effective image generation prompts.

## Prompt Structure

Build prompts in this order for best results:

```
[Subject] + [Style] + [Composition] + [Lighting] + [Mood] + [Technical Details]
```

| Component | What to Include | Example |
|-----------|----------------|---------|
| Subject | Main focus, attributes, action, position | "a woman in a red coat walking through rain" |
| Style | Artistic style, medium, technique | "cinematic photography, shot on 35mm film" |
| Composition | Camera angle, framing, perspective | "wide shot, rule of thirds, leading lines" |
| Lighting | Light source, quality, direction | "golden hour backlighting, lens flare" |
| Mood | Atmosphere, emotion, tone | "melancholic, nostalgic, muted tones" |
| Technical | Resolution, aspect ratio, rendering | "8K, 16:9, ray-traced, octane render" |

## Specificity vs Ambiguity

**Be specific about what matters, vague about what doesn't.**

| Too Vague | Too Specific | Right Balance |
|-----------|-------------|---------------|
| "a nice photo" | "a 27-year-old woman at 43.2 degrees" | "a young woman, portrait photography" |
| "something colorful" | "exactly #FF5733 and #33FF57" | "warm orange and cool green palette" |
| "good lighting" | "3-point Rembrandt with 2:1 ratio" | "dramatic side lighting, deep shadows" |

**Rules of thumb:**
- Describe the result, not the process
- Use adjectives that carry visual weight ("weathered", "glossy", "towering")
- Mention 2-3 colors rather than exact hex codes
- Name specific artists or art movements for style guidance ("in the style of Edward Hopper")

## Negative Prompts

Tell the model what to avoid. Useful for refining output.

**Common negative prompts:**
- Quality: "blurry, low quality, pixelated, distorted, watermark, text, logo"
- Anatomy: "extra fingers, extra limbs, deformed hands, cross-eyed"
- Style: "cartoonish, anime, childish" (when targeting realism)
- Composition: "cluttered, busy background, cropped, out of frame"

**Format by platform:**
- Midjourney: `--no blurry, watermark, text`
- Stable Diffusion: separate negative prompt field
- DALL-E: include avoidances in main prompt ("without text or watermarks")

## Platform-Specific Tips

### DALL-E (OpenAI)

- Excels at following natural language descriptions
- No negative prompt parameter — include avoidances in the prompt
- Strong at photorealism and illustration
- Limit: describe what you want, not technical camera settings
- Good format: "A [adjective] [subject] in [setting], [style], [mood]"

### Midjourney

- Responds well to artistic references and style keywords
- Parameters: `--ar` (aspect ratio), `--s` (stylize), `--c` (chaos), `--no` (negative)
- Short prompts often work better than long ones
- Strong at: aesthetic compositions, artistic styles, fantasy
- Tip: put most important words first

### Stable Diffusion

- Highly responsive to technical parameters and model-specific tokens
- Separate negative prompt field — use it
- Supports LoRA, ControlNet, and other fine-tuning
- Weight syntax: `(important word:1.3)` for emphasis
- Good with: specific art styles, detailed scenes, reproducible outputs

### Flux

- Handles long, descriptive prompts well
- Strong text rendering capabilities
- Natural language friendly — describe scenes conversationally
- Good at: photorealism, typography in images, complex scenes

## Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| Prompt too long | Model loses focus on key elements | Keep under 75 words for most platforms |
| Contradictory terms | "minimalist" + "highly detailed ornate" | Pick one direction |
| No style anchor | Generic, inconsistent output | Always include a style reference |
| Ignoring composition | Random framing, poor balance | Specify camera angle and framing |
| Only describing objects | Flat, catalog-like results | Add mood, lighting, atmosphere |
| Stacking every keyword | Muddled, incoherent images | 3-5 style keywords maximum |
| No color guidance | Unpredictable palette | Mention 2-3 dominant colors or a mood |

## Prompt Length Guidelines

| Platform | Sweet Spot | Max Effective |
|----------|-----------|---------------|
| DALL-E | 20-50 words | ~100 words |
| Midjourney | 10-40 words | ~60 words |
| Stable Diffusion | 30-75 tokens | ~150 tokens |
| Flux | 30-80 words | ~200 words |

**General rule:** Start short, add detail only where the output needs improvement. Every word should earn its place.

## Iterative Refinement

1. **Start broad** — subject + style + mood
2. **Evaluate** — what's missing or wrong?
3. **Add specifics** — fix only what needs fixing
4. **Subtract noise** — remove words that aren't helping
5. **Lock and vary** — keep what works, experiment with one element at a time
