# Avatar Lessons Learned

Hard-won lessons from avatar generation failures and investigations. Each lesson states what was tried, what failed, and what to do instead.

> **See also:**
> - [AVATAR-PLAYBOOK.md](AVATAR-PLAYBOOK.md) — step-by-step avatar creation workflow
> - [AVATAR-PIPELINES.md](AVATAR-PIPELINES.md) — pipeline reference and LoRA training
> - [AVATAR-LOG.md](AVATAR-LOG.md) — per-version experiment history

---

## Banding Root Causes (V9-V14)

Extensive testing across V9-V14 ruled out quantization as the primary banding cause. Three real root causes identified:

### 1. FLUX VAE grid artifact (all FLUX models)

The FLUX.2 VAE (`AutoencoderKLFlux2`) has a known, unfixed grid artifact visible in smooth regions. Documented in GitHub issues [#45](https://github.com/black-forest-labs/flux/issues/45), [#50](https://github.com/black-forest-labs/flux/issues/50), [#406](https://github.com/black-forest-labs/flux/issues/406). Worse at higher resolutions and in low-contrast areas. BFL has not acknowledged or fixed this.

### 2. 8-bit posterization in dark backgrounds

Obsidian backgrounds (#0a0a0f) have luminance values 0–5 out of 255 — only 5–6 distinct brightness levels. Smooth float gradients from the VAE get crushed into visible staircase bands when saved as 8-bit PNG. Analysis showed 270+ rows where the float value changes but the integer value stays the same.

### 3. PuLID cross-attention perturbation

PuLID injects identity corrections into every transformer block (5 double + 7 single CA modules, effective scale 1.8–8.0x). With only 4 denoising steps, these perturbations create spatial-frequency patterns the VAE amplifies into a visible grid — especially at 1024x1024.

### What was tried and didn't help

| Approach | Result |
|---|---|
| BF16 (no quantization) | Same banding — not a quantization issue |
| 512x512 (divisible by 64) | Slightly better, grid less visible at smaller size |
| 4 steps (native for 9B) | Correct but insufficient alone |
| Reflect padding on VAE decoder (33 conv layers) | No measurable improvement |
| Latent-space dithering (0.003-0.03 noise before VAE decode) | Negligible effect |
| Post-decode triangular PDF dithering | +/-1.5 levels too subtle for 30-80 row bands |
| Floyd-Steinberg error diffusion | No improvement — float values are genuinely flat |

### What actually works

| Approach | Effect |
|---|---|
| **Brighter backgrounds** | Light gray (~114 luminance) gives 100+ 8-bit levels — posterization invisible |
| **Klein 4B + 28 steps** (no PuLID) | Clean latents, no grid. The original 006 pipeline. |
| **512x512 for PuLID training data** | Grid blends at this size; invisible at profile-picture display size |

**Key finding:** Klein 4B at 28 steps without PuLID produces clean 1024x1024 images. Klein 9B at 4 steps with PuLID produces visible banding. The combination of step-distilled 4-step generation + PuLID perturbation is the primary cause at high resolution.

---

## Training Data Quality (V16 -> V17)

**Critical finding:** LoRA quality is bounded by training data quality. Training on PuLID-generated images (FLUX.1-dev or Klein 9B) produces a LoRA that outputs smooth, artificial-looking faces — regardless of prompt, steps, or resolution. The PuLID smoothness is baked into the LoRA weights.

**What was tested (V17):**
- 29 training images from FLUX.1-dev + PuLID v0.9.1 (mean similarity 0.647 to 006)
- Trained on Klein base 4B, rank 16, lr 1e-4, ai-toolkit
- 5 checkpoints tested: 1750, 2250, 2500, 2750, 3000 steps
- Best checkpoint: **step 1750** (mean 0.507 vs 006, peak before overfitting)
- Result: face identity preserved but **texture was plastic/airbrushed** — no pores, no imperfections, no natural skin detail

**Why:** FLUX.1-dev + PuLID outputs are inherently smoother than Klein 4B native outputs. The LoRA learned "smooth skin = this person's face." It cannot produce texture it never saw in training.

**Compare:**
- `006-just-solved-1024.png` (Klein 4B, no PuLID) -> natural skin, moles, pores, asymmetry
- V17 LoRA outputs -> airbrushed, uniform, render-quality

**Correct approach for natural LoRA:**
1. Generate 200+ images with **Klein 4B, no PuLID, no LoRA** (the 006 pipeline)
2. Score all against reference with InsightFace (cosine similarity)
3. Cherry-pick the 25-30 with highest face similarity (>0.45)
4. Train LoRA on these — the texture will be natural because the training data is natural
5. The face lock will be weaker than PuLID but the output quality will match the reference

This is the "garbage in, garbage out" principle applied to LoRA training. The training data must have the same quality characteristics you want in the output.

> **Full V16/V17 experiment details:** see [AVATAR-LOG.md](AVATAR-LOG.md)

---

## Identity Block Over-Specification (V18/V19)

V18 and V19 attempted to generate LoRA training data with Klein 4B native (no PuLID), using only an identity prompt to guide the face.

**V18 (400 images):** Identity block included "scattered freckles" — but the reference (006) has NO freckles. This was a misread of the reference that contaminated all prompts. Also included vague terms ("natural imperfections", "slightly messy", "slightly hooded") that added randomness.

**V19 (400 images):** Removed freckles, kept "small moles" + other vague terms. Slight improvement (mean 0.318 vs 0.309) but same fundamental problem.

**Both versions:**
- Mean similarity to 006: ~0.31 (vs 0.55+ for FLUX.1-dev PuLID)
- Only 5/400 above 0.50 threshold
- Agglomerative clustering (n=20) produces one mega-cluster of 280+ images — faces are in a continuous distribution, no sharp identity groups
- Full-body shots cluster separately (face too small/different)

### Key learnings

1. **Study the reference carefully** — the freckle mistake wasted an entire V18 batch
2. **Shorter identity prompts are better** — every word adds variance
3. **Klein 4B without PuLID cannot produce consistent faces** — the prompt influences features but each image is a new person. No natural face islands.
4. **Agglomerative clustering reveals the truth** — one big cloud, not distinct groups

### Prescriptive rules (carried to AVATAR-PIPELINES.md)

- Describe only dominant, unambiguous features
- Include: age, hair color + style + length, skin tone, eye color, build
- Omit: moles, freckles, bone structure, eyebrow/eyelid/lip shape, nose bridge width
- Every vague word = more randomness in output

> **Full rules table:** see [AVATAR-PIPELINES.md](AVATAR-PIPELINES.md), "Identity block rules" section

---

## Face Scoring Evolution (V21 -> V22)

V21 used InsightFace AntelopeV2 (512x512 detection) for face similarity. This worked for frontal-to-frontal matching but failed at cross-pose identity: a profile of the same person scored 0.20-0.30 against a frontal, so islands clustered by **pose** instead of **identity**.

### V22 improvements (cumulative)

1. **buffalo_l replaces AntelopeV2** — newer InsightFace model, 640x640 detection, better `det_10g` detector. Profiles score +0.08 higher (normalized). Same API, drop-in swap. Set in `score_faces.py` via `--model buffalo_l`.

2. **CLIP ViT-L/14 as second signal** — CLIP captures semantic "same person concept" independent of pose. Combined: `0.5 x face_norm + 0.5 x clip_norm`. Script: `score_v22_dual.py`.

3. **Island-first selection** — LoRA candidates selected from islands (pairwise-consistent groups), not by reference score. Islands on combined pairwise matrix allow profiles and frontals to coexist. Script: `select_v22_lora.py`.

4. **No reference bias** — `select_v22_lora.py` ranks by island quality (`internal_mean x log2(size)`) and diversity, not by similarity to any reference image. The reference is only used for the gallery's score overlay.

**Result:** Island #0 grew from ~30 members (face-only, pose-clustered) to 143 members (cross-pose). Top 30 LoRA picks span all 5 angles and 6 of 7 expressions.

### Key insight for future versions

Face recognition alone cannot match identity across poses. Always pair with a semantic model (CLIP or similar). The combined pairwise matrix is the correct foundation for island detection.

### Re-validated on fresh data (2026-04-05)

The dual-signal method was re-validated on a 400-image batch (`avatar-lyra-v22-island0-400`, NVFP4 + island0 LoRA, varied short prompts, 1024×1024):

| Method | Strict clique at 0.55 | Internal face mean inside clique |
|---|---|---|
| Face-only (buffalo_l) | 39 members | 0.636 |
| Dual (buffalo_l + CLIP ViT-L/14) | **96 members** (+147%) | **0.574 face / 0.754 CLIP / 0.658 combined** |

The 57 additional members the dual signal rescued were cross-pose pairs that face-only couldn't bridge. Raw buffalo_l mean across the full 400 was 0.440 (looked like weak identity); raw CLIP mean was 0.625 (identity clearly present, just not face-geometry consistent across poses).

**Script:** `detect_island0_400_dual.py` — adapted from `score_v22_dual.py` for internal-only pairwise analysis (no reference image).

---

## Scale Lever Above 1.0 Degrades Output (V22 validation, 2026-04-05)

**Contradicts earlier recommendation in AVATAR-PIPELINES.md to try `adapter_weights=[1.5]` as a quick fix.** That advice was wrong and has been removed.

### What was tested

A 17-configuration matrix at 256×256 + a 48-configuration matrix at 1024×1024, each including fused and unfused LoRA paths at scales 1.0, 1.5, and 2.0 against the `lyra_v22_top30` LoRA. Centroid scoring against the top30 training set.

### Result

**Boosting scale above 1.0 degrades identity monotonically**, regardless of fused or unfused path:

| Scale | Fused (FP8, long prompt) | Unfused (bf16, long prompt) |
|---|---|---|
| 1.0 | 0.288 | 0.265 |
| 1.5 | 0.263 | 0.244 |
| 2.0 | 0.231 | 0.217 |

Same pattern at 1024×1024. The trend holds across engines and prompt styles.

### Why (weight-level verification)

Weight-hash diagnostic (`diagnose_lora_state.py`) proved:
- `set_adapters(weights=[N]) + fuse_lora()` is byte-identical to `fuse_lora(lora_scale=N)`
- Fused scaling is linear: `‖ΔW(2.0)‖ / ‖ΔW(1.0)‖ = 1.966 ≈ 2.0`

So the API works correctly — the problem is physical. LoRA is trained at effective scale 1.0. Boosting ΔW beyond that point pushes transformer activations out of the distribution the base model was trained on. The face drifts *away* from the target as you increase scale, not toward it.

### What to do instead

- **Leave scale at 1.0. Never touch the lever.**
- If identity is too weak at 1.0, the fix is training-side: larger rank (32/64) or better-curated dataset. Not inference-time scaling.
- The `adapter_weights` parameter is not a strength knob. It's a no-op at 1.0 and a quality-degradation knob above it.

---

## 256×256 Is Plumbing-Only, Never Quality (2026-04-05)

### The trap

I ran the V22 LoRA validation matrix at 256×256 for speed (~2-3s per image) and concluded: "the LoRA barely works — best score is 0.288, nothing crosses the 0.5 'same person' threshold." That conclusion was a **pure measurement artifact** that flipped completely at 1024×1024.

### Why 256×256 lies

buffalo_l face recognition needs face regions ≥80px for reliable embeddings. At 256×256:
- Headshot: face ~80–120px (borderline)
- Half-body: face ~40–60px (below threshold)
- Full-body/profile: face <40px (unusable)

Below the threshold, cosine similarities compress by 0.15–0.30 vs 1024×1024 for the same identity. A LoRA that scores 0.60+ at 1024 can easily score 0.25 at 256 — not because it's weaker, but because the scoring model can't see the face.

### Before/after on the same LoRA

| Config | 256×256 mean | 1024×1024 mean |
|---|---|---|
| Best (FP8 fused long) | **0.288** (below "different person" threshold) | **0.66** (solidly "same person") |
| No-LoRA baseline | 0.137 | 0.137 |
| LoRA lift | +0.15 (looks weak) | +0.52 (huge) |

### What to do instead

- **Use 256×256 only for plumbing validation:** code-path execution, silent-failure detection, byte-level equivalence checks, smoke tests.
- **Never draw quality conclusions from 256×256.** Rankings, lifts, thresholds — all suspect.
- **For any "is this LoRA good enough" question, run at 1024×1024** against a centroid. 8 steps is fast enough on NVFP4 (~4s/image) — no excuse to cut corners on resolution.
- **If reporting 256 results, mark them "plumbing only"** and don't let anyone treat them as quality evidence.

---

## Score Against Training Distribution, Never External References (2026-04-05)

### The trap

I initially scored the V22 validation matrix against `006-just-solved-1024.png` — a canonical Klein 4B output that has been the de facto Lyra face for months. Reasonable choice, except **006 was generated by a different pipeline (Klein 4B, no PuLID, 28 steps) and was never in the training set of any V22 LoRA**. It's out-of-distribution.

Against 006, the LoRAs looked weak (+0.05 lift over baseline) and short prompts appeared to beat long prompts. The entire analysis direction was off.

### The correction

Switched the reference to `P1641-headshot-frontal-calm.png` — one image from the `top30` training set the LoRA was trained on. Then switched again to scoring against the **centroid of all 30 top30 embeddings** (mean, L2-normalized) for stability.

**Result:** every conclusion flipped.

| Metric | Scored vs 006 (wrong) | Scored vs top30 centroid (right) |
|---|---|---|
| No-LoRA baseline | 0.231 | 0.137 |
| Best LoRA config | 0.308 (A, short prompt) | 0.288 (B, long prompt) |
| LoRA lift | +0.077 (weak) | +0.151 (strong) |
| Long vs short prompt | Short wins | **Long wins** |
| Production viability | Unclear | Clear (at 1024: every config ≥ 0.5) |

### Why this happens

A LoRA learns to produce the identity distribution of its training set. Scoring against that distribution shows you what the LoRA actually does. Scoring against an external target shows you the distance between two different distributions — the LoRA's output distribution and whatever 006's pipeline produced — which is a mix of identity difference AND pipeline style difference AND lighting/texture difference. The pipeline/style components dominate and swamp the identity signal.

### What to do instead

- **Score against the centroid of the training set**, not a single reference image. Centroid = mean of all training embeddings, L2-normalized. Stable, unbiased, reflects "did the LoRA learn the identity it was trained on".
- **If a centroid isn't available**, pick a random training image — any training image beats an external "canonical" reference.
- **Never score a LoRA against images the LoRA was not trained on**, even if those images look stylistically similar. Style similarity is not identity distribution membership.
- **If an existing "canonical" reference image is from a different pipeline**, treat it as a target to *match via retraining*, not as a scoring oracle for an already-trained LoRA.

> **Related:** see feedback memory `feedback_lora_evaluation.md` for the full set of rules derived from this session.

---

## Klein 4B Converter Fix (2026-04-01)

The `convert_flux2_klein_hf_to_comfy.py` had a bug: `norm_out.linear.weight` was copied directly, but Diffusers stores `[scale|shift]` while ComfyUI expects `[shift|scale]`. This caused garbled mosaic output.

**Fix**: rows are swapped on conversion — `torch.cat([w[3072:], w[:3072]])`.
Verification: velocity std went from 1.52 -> 0.66, x0 std 2.19 -> 0.98.
Fixed weights at: `~/ComfyUI/models/diffusion_models/flux2-klein-4b-comfy.safetensors`

---

## Verify training dataset path BEFORE launch (2026-04-05 — v23f/v23a drift)

### What happened

`train_lyra_v23f_schedule.yaml` and `train_lyra_v23a_rank.yaml` were drafted early in the day when `face` (trained on `lora-training-set`) was still considered the production baseline. Mid-day the plan was revised to use `v22_top30` config — but only comments were edited in the yamls, not the `folder_path`. Both trained against `lora-training-set` (face's pre-V22 data, 29 images) instead of `avatar-lyra-v22-lora/top30` (V22 curated, 30 images). Discovered only after benchmarking when the results were being written up.

### Impact

- v23f and v23a lost their entire purpose as V22 attribution runs
- Reported "wins" (v23f_4000 +0.046 internal, v23a_2500 91.1% of top30 ceiling) were methodologically invalid
- Doc/issue updates had to be walked back
- Two full retrains required (v23f2, v23a2)

### Rule

**Before launching any training run, grep the frozen `folder_path` in the yaml against the plan.** Comment-only edits do not propagate to the data side. Config drift is invisible until you look at the frozen `output/<name>/config.yaml` side-by-side with the plan doc.

```bash
# Pre-launch check:
grep "folder_path" ~/projects/archived/ai-toolkit/config/train_lyra_<run>.yaml
```

When revising a plan mid-day, re-read **every yaml** the plan touches. Never trust that "the comment is updated, the path must be too".

---

## Weak LoRA vs memorization — measure before claiming (2026-04-05 — v23d)

### What happened

User observed that v23d training-time samples at step 1250-3000 "looked like v22 phase2 seed 8391 outputs", hypothesized **memorization**. Buffalo_l check on v23d step 3000 prompt 0 against all 143 training images returned **max similarity 0.5477** (to P1654-headshot-3q-left-calm), mean 0.4137. Both below the "same person" threshold (0.65). **Not memorization.**

### Three distinct failure modes for identity LoRAs

| Mode | Max buffalo_l to training | Behavior |
|---|---|---|
| **Pixel memorization** | ≥ 0.95 | LoRA reproduces specific training images |
| **Strong memorization** | 0.80-0.95 | Same face, new pixels |
| **Weak / not-learned** | < 0.65 | Output is base-model + weak LoRA bias |

v23d hit the **weak** mode. Its null benchmark result wasn't because the step-count knob was exhausted — the underlying LoRA was just poorly trained (143 images at rank 16 + 2500-3000 steps is too few effective updates per image to converge tightly).

### Rule

**When a LoRA "looks like training data" visually, run the buffalo_l similarity check before concluding memorization.** Visual intuition catches real signal (composition, style, base-model character) but can't distinguish memorization from weak identity lock. Script: `score_memorization_check.py`.

---

## Caption format is load-bearing — trigger must bind alone (2026-04-07 — v22 island0-400)

### What happened

The V22 LoRA was trained with verbose sentence-based captions that re-stated all physical
attributes on every image (`Fair skin, hazel eyes, dark blonde hair...`). At inference,
omitting any of those attribute sentences caused identity to drift visibly. Users found they
needed to inject ~30 tokens of identity description to get reliable face lock — negating the
convenience advantage of a LoRA over PuLID.

### The measurement

Ran 4 inference batches on the same V22 LoRA (island0-400, 400 images each), varying only
the prompt format. Buffalo_l vs top30 centroid:

| Format | Buffalo mean | Delta |
|---|---|---|
| Compact traits, no identity attrs (original) | 0.440 | baseline |
| + `dark blonde, fair skin, hazel eyes` injected | 0.578 | +31% |
| + `tousled wavy blonde past shoulders...` (refined) | 0.577 | +31% |
| Full training-sentence format (training-format) | **0.626** | **+42%** |

+42% from prompt format alone — zero weight changes. The LoRA learned `lyraface` as
part of a sentence pattern, not as a standalone identity concept.

### Root cause

The model learned: `lyraface + [identity sentences] + [scene]` → face.
Not: `lyraface` → face.

When inference omits the identity sentences, the trigger fires weakly — it needs the
surrounding context it was trained with. Every physical attribute in the training caption
became load-bearing context rather than information bound to the trigger.

### Rule

**`lyraface` must be the only identity signal. Physical attributes must NOT appear in captions.**

```
# WRONG
lyraface person. Fair skin, hazel eyes, dark blonde hair. [scene]

# RIGHT
lyraface. [scene only]
```

**Caption format must match inference format.** If you plan to use compact prompts at
inference, train with compact prompts. Mixing formats degrades identity 30–40%.

**Caption dropout** (`caption_dropout_rate: 0.05`) strengthens trigger binding by forcing
the model to reconstruct identity from the trigger alone during training.

**Correct caption format:**
```
lyraface. [shot]. [angle]. [expression]. [lighting]. [background].
```

**Pre-launch validation:** before a full training run, generate 20 images with the
intended caption format, train a 10-image smoke-test LoRA, verify trigger-only inference works.

> **Full caption format guide:** see [PROCESS-PIPELINE-V2.md](PROCESS-PIPELINE-V2.md), Phase 5a caption strategy.

---

## Buffalo_l centroid ≠ visual quality (2026-04-05 — v22_face)

### What happened

`v22_face` was declared the production default because it dominated every benchmark axis (internal 0.5478, vs-top30 0.5581 = 85.2% of ceiling). User visually inspected the benchmark gallery and rejected it for **"realism and colors"**. Despite winning every number, the outputs were visually worse than v22_top30.

Root cause: face was trained on `lora-training-set` (29 pre-V22 near-identical hand-curated images, 0.84 internal pairwise). The training data was so tight that face learned a very narrow pose/lighting/color distribution. Buffalo_l scored the outputs high because they matched that narrow distribution well — but the narrow distribution itself was aesthetically worse than the more varied V22 curation.

### Rule

Buffalo_l measures **identity fidelity vs a reference set**. It does NOT measure:
- Realism (skin texture, lighting naturalness)
- Color fidelity (saturation, white balance, tone)
- Aesthetic quality (composition, expression subtlety)
- Generalization to unseen poses/prompts

**Every production default decision must include human visual inspection** of benchmark outputs, not just the numerical table. A LoRA can score highest and still be wrong.

Corollary: **tight training data inflates benchmark scores** without improving real-world quality. Internal pairwise > 0.80 on the training set is a red flag, not a green one.
