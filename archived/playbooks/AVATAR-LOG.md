# Avatar Experiment Log

Per-version history of Lyra avatar generation experiments. For the reusable workflow, see [AVATAR-PLAYBOOK.md](AVATAR-PLAYBOOK.md). For pipeline reference, see [AVATAR-PIPELINES.md](AVATAR-PIPELINES.md). For extracted lessons, see [AVATAR-LESSONS.md](AVATAR-LESSONS.md).

---

## Version Table

| Slot | Directory | Label | Pipeline |
|---|---|---|---|
| V1 | `avatar/` | Exploration | Klein 4B, 28 steps |
| V2 | `avatar-v2/` | Pattern Drill | Klein 4B, 28 steps |
| V3 | `avatar-training/` | Training Set | Klein 9B + PuLID |
| V4 | `avatar-test-pulid/` | PuLID Test | Klein 9B + PuLID |
| V5 | `avatar-pulid-v2/` | Goddess/Marvel | Klein 9B + PuLID |
| V6 | `avatar-pulid-v4-fix/` | PuLID Fixed | Klein 9B + PuLID |
| V8 | `avatar-lyra-final/` | Lyra Final (special effects) | Klein 4B |
| V9 | `avatar-lyra-portraits/` | Lyra Portraits | Klein 9B INT8 (banding) |
| V10 | `avatar-lyra-v10/` | Portraits FP8 | Klein 9B Float8 (residual banding) |
| V11 | `avatar-lyra-v11/` | 8-Step Match | Klein 4B FP8, steps=8 |
| V15-1024 | `avatar-lyra-v15-1024/` | Pipeline comparison | Multi-pipeline, 1024x1024 |
| V16 | `avatar-lyra-v16/` | LoRA Training Set | FLUX.1-dev + PuLID v0.9.1 |
| V17 | `avatar-lyra-v17/` | LoRA Checkpoint Comparison | Klein base 4B + LoRA |
| V18 | `avatar-lyra-v18/` | Klein 4B Exploration | Klein 4B native (identity block v1) |
| V19 | `avatar-lyra-v19/` | Klein 4B Exploration | Klein 4B native (identity block v2) |
| V20 | `avatar-lyra-v20/` | Brute Force | Klein 4B, face scoring vs ref |
| V21 | `avatar-lyra-v21/` | Brute Force | Klein 4B, AntelopeV2, island detection |
| V22-phase1 | `avatar-lyra-v22-phase1/` | Seed Selection | Klein 4B, 10 seeds x 50 prompts |
| V22-phase2 | `avatar-lyra-v22-phase2/` | Full Run | Klein 4B, dual face+CLIP scoring |
| V22-validation | `avatar-lyra-v22-validation/` | 17-config plumbing matrix (256x256) | Multi-engine × fusion × scale test |
| V22-1024 | `avatar-lyra-v22-1024/` | 48-config production matrix (1024x1024) | FP8/NVFP4 × fused/unfused × 3 LoRAs × prompt × steps |
| V22-island0-400 | `avatar-lyra-v22-island0-400/` | 400 diverse short prompts | NVFP4 + island0 LoRA, dual-signal internal scoring |

V7 was skipped (renumbering error — `avatar-lyra-final` was initially mislabeled V7 before correction).

---

## V16 — LoRA Training Set (2026-04-02)

300 images generated with FLUX.1-dev + PuLID v0.9.1, 1024x1024, face-locked to 006 reference.

**Generation:**
```bash
cd ~/projects/imageCLI
uv run imagecli batch ~/.agent/lyra/brand/prompts/avatar-lyra-v16-flux1/ \
  --output-dir ~/.agent/lyra/brand/concepts/avatar-lyra-v16/ --no-compile
```

**10 groups (30 prompts each):**

| Range | Group | Content |
|-------|-------|---------|
| 001-030 | Frontal Expressions | 30 emotions: calm, laugh, serious, curious, tender, fierce... |
| 031-060 | Three-Quarter Angles | Left/right, warm/focused/laughing/pensive, varied lighting |
| 061-090 | Profiles & Angles | Profile, 45 deg, high/low angle, tilted, over-shoulder |
| 091-120 | Close-ups & Crops | Eyes, lips, jaw, freckles, half-face, wide environmental |
| 121-150 | Lighting | Golden hour, neon, candlelight, flash, chiaroscuro, fog... |
| 151-180 | Moods & Contexts | Coffee shop, rain, beach, library, concert, snow... |
| 181-210 | Body Shots | Half/full body: standing, sitting, walking, dancing, yoga |
| 211-240 | Style & Creative | Film noir, vintage, polaroid, double exposure, cyberpunk... |
| 241-270 | Raw Editorial | 006-style variations: warm rim, cool key, dramatic, gritty |
| 271-300 | Identity Stress Test | Near-identical prompts testing PuLID consistency |

**Face similarity results (InsightFace cosine similarity to 006):**
- Mean: **0.597** | Median: 0.601
- >0.5 (same person): **292/300 (97%)**
- >0.6 (strong match): 151/300 (50%)
- Top identity cluster (pairwise >0.65): 50 images, internal mean **0.841**

**29 images selected for LoRA training** (`lora-training-set.json`):
- Selection: top from cluster, max 3 per group for diversity
- Mean similarity: 0.647 | All above 0.629
- Distribution: 3 each from 3Q, profile, closeup, lighting, mood, body, style, raw, stress + 2 frontal

**Galleries:**
- Full 300: `brand/v16-gallery.html` (filtering + starring)
- Parameter grid: `brand/klein-pulid-grid.html` (Klein 4B) and `brand/pulid-grid.html` (FLUX.1-dev)
- Pipeline comparison: `brand/1024-comparison.html`

**Outcome:** Strong face lock (97% above threshold) but images have FLUX.1-dev PuLID smoothness. Not suitable as LoRA training data if natural texture is required.

> **Lesson extracted:** see [AVATAR-LESSONS.md](AVATAR-LESSONS.md), "Training Data Quality"

---

## V17 — LoRA Checkpoint Comparison (2026-04-02)

Tested the LoRA trained on V16 data (29 images from FLUX.1-dev + PuLID).

**Setup:** Klein base 4B + LoRA, ai-toolkit, rank 16, lr 1e-4, FP8 quantized.

**Checkpoint comparison (20 images each, 400x400, 28 steps, editorial prompts):**

| Checkpoint | Mean vs 006 | >0.5 | Internal | Verdict |
|-----------|-------------|------|----------|---------|
| **step1750** | **0.492** | **50%** | **0.621** | **Best — peak before overfitting** |
| step2250 | 0.493 | 36% | 0.628 | Plateau |
| step2500 | 0.462 | 18% | 0.586 | Declining |
| step2750 | 0.494 | 41% | 0.623 | Bounce |
| step3000 | 0.424 | 11% | 0.557 | Overtrained |

**Gallery:** `brand/v17-lora-comparison.html` — side-by-side across checkpoints.

**Outcome:** Face identity is preserved but **texture is plastic/airbrushed** — the LoRA inherited FLUX.1-dev + PuLID's smoothness from the training data. Not acceptable for production avatars.

> **Lesson extracted:** see [AVATAR-LESSONS.md](AVATAR-LESSONS.md), "Training Data Quality"

---

## V18/V19 — Klein 4B Native Candidates (2026-04-02)

Attempted to generate LoRA training data with Klein 4B native (no PuLID), identity prompt only.

**V18 (400 images):** Identity block included "scattered freckles" — but 006 has NO freckles. This was a misread of the reference that contaminated all prompts. Also included vague terms ("natural imperfections", "slightly messy", "slightly hooded") that added randomness.

**V19 (400 images):** Removed freckles, kept "small moles" + other vague terms. Slight improvement (mean 0.318 vs 0.309) but same pattern.

**Both versions:**
- Mean similarity to 006: ~0.31 (vs 0.55+ for FLUX.1-dev PuLID)
- Only 5/400 above 0.50 threshold
- Agglomerative clustering (n=20) produces one mega-cluster of 280+ images — faces in a continuous distribution, no sharp identity groups
- Full-body shots cluster separately (face too small/different)

**Galleries:** `brand/v18-gallery.html`, `brand/v19-gallery.html`

> **Lesson extracted:** see [AVATAR-LESSONS.md](AVATAR-LESSONS.md), "Identity Block Over-Specification"

---

## V20 — Brute Force with Face Scoring (2026-04-03)

400 images with Klein 4B, 512x512. Scored against 006 reference with InsightFace.

---

## V21 — Brute Force with Island Detection (2026-04-03)

2000 images with Klein 4B, 512x512. AntelopeV2 face scoring + pairwise similarity matrix + island detection.

**Problem discovered:** AntelopeV2 face recognition clusters by **pose** instead of **identity** at cross-pose comparisons. A profile of the same person scored 0.20-0.30 against a frontal. Islands were pose-clustered, not identity-clustered.

> **Lesson extracted:** see [AVATAR-LESSONS.md](AVATAR-LESSONS.md), "Face Scoring Evolution"

---

## V22 — Dual Scoring + LoRA Training (2026-04-04)

Two-phase approach: seed selection -> volume -> dual scoring -> island-based LoRA selection -> training.

### Phase 1: Seed Selection

- 500 images (10 seeds x 50 prompts), Klein 4B FP8, 8 steps
- **Winning seed: 8391** (#1 in internal consistency and cross-seed agreement)
- Gallery: `v22-seed-selection.html`

### Phase 2: Full Generation

- 2000 images at 8 steps (~37 min), seed 8391
- Dual scoring: buffalo_l (InsightFace, 640x640) + CLIP ViT-L/14
- Combined: `0.5 x face_norm + 0.5 x clip_norm`
- Scripts: `score_v22_dual.py` (scoring), `select_v22_lora.py` (selection)
- Gallery: `v22-gallery.html`

### Island Detection

- 77 tight islands (combined pairwise >0.55, min 10 members)
- **Island #0:** 143 members, cross-pose (profiles + frontals together)
- 50 LoRA candidates selected, top 30 all from Island #0
- All 5 angles and 6/7 expressions covered

### LoRA Training

Three dataset sizes tested:

| Dataset | Images | Result |
|---|---|---|
| **top30** | 30 (frontals + close-ups from Island #0) | **Best identity lock** — recognizable with short prompts |
| top50 | 33 (top30 + more diverse angles) | Slightly softer identity |
| island0 | 143 (full cross-pose island) | Identity averaged out — too diverse for rank 16 |

Training config: Klein base 4B, ai-toolkit, rank 16, lr 1e-4, 2500 steps, FP8.

**Key finding:** 30 tightly-curated images > 143 diverse images for identity LoRA at rank 16.

### Files

- Scoring: `score_v22_dual.py` (dual), `score_faces.py` (single, supports `--model buffalo_l`)
- Selection: `select_v22_lora.py`
- Results: `concepts/avatar-lyra-v22-phase2/face-scores.json`, `lora-selection.json`
- Galleries: `v22-seed-selection.html` (Phase 1), `v22-gallery.html` (Phase 2)

### Next steps

**(Superseded by V22-validation / V22-1024 / V22-island0-400 below. Original plan contained errors corrected in April 2026.)**

---

## V22-validation — 17-config Plumbing Matrix (2026-04-04)

51 images at **256×256** (A–Q). Tested LoRA behavior across engines, fusion paths, scales. **Results were measurement artifacts from sub-threshold face detection** — see AVATAR-LESSONS.md "256×256 Is Plumbing-Only".

### What was validated (binary findings, resolution-independent)

- **LoRA loaded AFTER FP8 quantize is a silent no-op** (E and F outputs byte-identical; md5sum match). Must load LoRA before quantize.
- **Weight-level verification via `diagnose_lora_state.py`:** `load_lora_weights` leaves base untouched, `fuse_lora()` modifies base weights, `set_adapters(weights=[N]) + fuse_lora()` ≡ `fuse_lora(lora_scale=N)` byte-identical, scale is linear (‖ΔW₂.₀‖ / ‖ΔW₁.₀‖ = 1.966).
- **Fused ≈ unfused at scale 1.0** (mathematically equivalent by matmul distributivity).
- **Unfused LoRA works on `QuantizedTensor` base weights** (NVFP4 + unfused LoRA via runtime adapter — first time tested).
- **Scale above 1.0 degrades output** (fused AND unfused, monotonic trend).

### New imageCLI capability

`flux2-klein-fp4` engine gained `--lora` support via a new code path: load bf16 base → fuse LoRA at scale 1.0 → `QuantizedTensor.from_float(w, "TensorCoreNVFP4Layout")` runtime quantization per linear layer. Bypasses BFL pre-quantized disk weights. Committed to `Roxabi/imageCLI` staging (commit `192837b`).

### What turned out wrong at 256×256

All quality rankings. Best score was 0.288, nothing crossed 0.5, conclusion was "LoRA barely works". This was a face-size-vs-buffalo_l-threshold artifact that flipped completely at 1024×1024.

---

## V22-1024 — 48-config Production Matrix (2026-04-05)

144 images at **1024×1024**. The actual LoRA validation — 256 numbers were unreliable, so we re-ran at production resolution with centroid scoring against the top30 training set.

### Configuration

- 2 engines × 2 fusion × 3 LoRAs × 2 prompt styles × 2 step counts = 48 configs × 3 poses = 144 images
- Engines: quanto FP8, NVFP4 (via runtime quantization, the new `flux2-klein-fp4 --lora` path)
- LoRAs: `lyra_v22_top30`, `lyra_v22_island0`, `lyra_face_klein4b_v1`
- Scoring: centroid of 30 top30 training embeddings, buffalo_l cosine

### Results

**47 of 48 configs crossed the 0.5 "same person" threshold.** One outlier at 0.468. Best configs in the 0.63–0.66 range.

| Finding | Evidence |
|---|---|
| **LoRA genuinely locks identity at 1024×1024** | Every config except one > 0.5. No-LoRA baseline = 0.137. LoRA lift: +0.10 to +0.15. |
| **Long prompts > short prompts** by +0.05–0.07 | Consistent across engines, fusion modes, LoRAs. Reverses the 256-test conclusion. |
| **`face` (lyra_face_klein4b_v1) > island0 ≈ top30** by ~0.03–0.05 | Best single-LoRA choice for production. |
| **NVFP4 ≈ FP8 at 1024×1024** | Gap collapses to 0.01–0.02, noise level. At 256 the gap was 0.032 — resolution-dependent. |
| **Fused ≈ unfused at scale 1.0** | Gap 0.009–0.023 across matching configs. Mathematical equivalence confirmed. |
| **8 steps ≥ 20 steps** | Klein 4B is step-distilled; 20 often scored lower. Use 8. |

### Production recommendation

```
engine:  flux2-klein-fp4  (NVFP4, via --lora flag)
lora:    lyra_face_klein4b_v1  (final checkpoint)
fusion:  fused  (automatic via --lora)
scale:   1.0  (never boost — degrades monotonically)
prompt:  long, descriptive, natural language
steps:   8
size:    1024×1024
```

Expected: ~0.64 centroid score, ~4 seconds per image, ~3 GB VRAM.

### Gallery

`v22-1024-gallery.html` — 7-dimension pivot (steps / engine / fusion / lora / prompt / pose / score).

---

## V22-island0-400 — 400 Diverse Short Prompts (2026-04-05)

400 images at **1024×1024** with NVFP4 + fused `lyra_v22_island0` LoRA, 8 steps, seeds 8391–8790. Short prompts constructed by sampling 2–4 traits from 7 axes (shot, angle, expression, lighting, outfit, background, mood). Runtime: ~30 minutes.

**Purpose:** stress-test the LoRA across genuinely varied prompts (not curated) and measure internal consistency without any external reference.

### Dual-signal internal scoring

Face-only scoring showed a pairwise mean of 0.440 (looked like weak consistency), but this was biased by cross-pose pairs where buffalo_l can't bridge profile/frontal. Re-ran with V22's dual method (buffalo_l + CLIP ViT-L/14, normalized pairwise averaged 0.5/0.5):

| Metric | Face-only | Dual (face + CLIP) |
|---|---|---|
| Raw pairwise mean | 0.440 | 0.519 normalized |
| Strict clique @ 0.55 | 39 members | **96 members** |
| Clique internal (face) | 0.636 | **0.574** (above threshold) |
| Clique internal (CLIP) | — | 0.754 |
| Tight clique @ 0.65 | 9 members | **20 members** (face 0.643) |

### Clique tiers (saved to metadata.json, filterable in gallery)

- **tight-20** (20 images) — strict clique at combined ≥ 0.65
- **clique-96** (77 images, nested priority) — strict clique at ≥ 0.55
- **cc-393** (296 images) — connected component at ≥ 0.55
- **outside** (7 images) — unconnected outliers

### Scripts produced

| Script | Purpose |
|---|---|
| `generate_island0_400_prompts.py` | 400 compact 7-axis short prompts (seed 42 for reproducibility) |
| `extract_island0_400_metadata.py` | Parse .md files → metadata.json with per-image trait dict |
| `score_island0_400.py` | Face-only internal + centroid scoring |
| `detect_island0_400_islands.py` | Face-only island detection (superseded) |
| `detect_island0_400_dual.py` | Dual-signal island detection (current) |

### Gallery

`v22-island0-400-gallery.html` — 8-dimension pivot with clique tiers as the primary filter. Default pivot shows Clique × Angle.

### Key insight re-confirmed

The V22 "face-only scoring clusters by pose, not identity" finding holds on fresh data. Dual buffalo_l + CLIP pairwise is the correct foundation for cross-pose batches. Face-only should only be used on single-pose batches (all-frontal headshots, etc.).

---

## V23 — LoRA Attribution Exploration (2026-04-05)

Follow-up to V22. Isolated one-variable training runs to find which Klein 4B LoRA knobs actually move centroid similarity on the Lyra face. Full context: [`V23-EXPLORATION.md`](V23-EXPLORATION.md). Epic: [Roxabi/lyra#542](https://github.com/Roxabi/lyra/issues/542).

### Scoring framework — dual-metric, not single-centroid

Corrected mid-day after user pushback on the initial n=3 verdict. Final framework scores every run on three axes against a 20-prompt benchmark (10 short + 10 long, matched slots, per-slot seeds 8391-8400):

| Metric | Measures | Why |
|---|---|---|
| Internal coherence | Pairwise cosine mean among the LoRA's own outputs | "Same face every time" — cross-pose identity consistency |
| vs own training centroid | Mean cosine vs the training set centroid | In-distribution fit |
| vs top30 reference | Mean cosine vs top30 centroid (common reference) | Cross-LoRA comparable, OOD for non-top30 runs |

Reference ceilings (LOO): `top30` 0.6551, `island0` 0.6725, `lora-training-set` 0.9159 (misleadingly high — tight near-identical data, not a realistic target).

Noise threshold: **0.02** to claim a real win on any axis.

### Production default: `lyra_v22_top30`

Confirmed 2026-04-05 after `face` was visually rejected by the user for realism/colors. Replaces `lyra_face_klein4b_v1` which had multiple problems (pre-V22 methodology, tight pre-V22 curation, +500 step advantage, overfitting risk, and finally bad realism/colors on visual inspection).

### Baseline

Every v23 run is compared against **`v22_top30`** on a 20-prompt benchmark:

| LoRA | Dataset | Steps | Rank | Internal (n=19) | vs top30 | % top30 ceiling |
|---|---|---|---|---|---|---|
| **`lyra_v22_top30`** ⭐ | `concepts/avatar-lyra-v22-lora/top30` (30) | 2500 | 16 | **0.4253** | **0.4763** | 72.7% |
| `lyra_v22_island0` | `concepts/avatar-lyra-v22-lora/island0` (143) | 2500 | 16 | 0.4128 | 0.4848 | 74.0% |
| ~~`lyra_v22_face`~~ DEPRECATED | `lora-training-set` (29, pre-V22) | 3000 | 16 | ~~0.5478~~ | ~~0.5581~~ | — |

Real win threshold: ≥ baseline + 0.02 on BOTH internal coherence AND vs-top30 reference.

### Why v22_top30 over v22_island0

- AVATAR-LOG original V22 assessment: "best identity lock, recognizable with short prompts"
- Benchmark wins 4 of 5 axes vs v22_island0 (int_all, int_short, int_long, vs-own-training % ceil)
- island0 only wins vs-top30-ref by +0.008 — within noise
- Simpler dataset (30 vs 143 imgs) → easier iteration, lower overfitting risk
- Matches v23f2/v23a2/v23c/v23g retraining target (cohesive data for clean attribution)

### Why v22_face DEPRECATED

- **User visual rejection (2026-04-05):** "face is not OK because of realism and colors"
- Pre-V22 methodology (trained 2026-04-02, before V22 dual-signal island detection existed)
- Trained on `lora-training-set` — 29 pre-V22 near-identical hand-curated images from V6-V8 era (0.84 internal pairwise, extreme cohesion → memorization/overfitting risk)
- +500 step advantage over v22_top30/v22_island0 inflates metric scores unfairly
- Its apparent wins on the n=19 benchmark (0.5478 internal, 0.5581 vs-top30) are partly artifacts of the tight training data + extra steps, not methodology quality

Kept in benchmark for provenance only. Not a baseline, not a stretch target, not production.

### Runs

| Run | Status | Dataset | Delta | Verdict |
|---|---|---|---|---|
| v23d-island0 | ⚪ NULL | island0 (144) | steps 2500→3000, +noise_offset | No measurable change on any axis at n=19. All 5 checkpoints within ±0.02 of v22_island0. v23d is a **weak LoRA** — memorization check (max buffalo_l similarity 0.5477 to any training image, mean 0.4137) ruled out memorization. Weakly biased toward training distribution average. |
| ~~v23f-schedule~~ | ⚠️ Reclassified (face-lineage) | **lora-training-set** (drift — see below) | steps 3000→4000, +noise_offset | Config drift — trained on wrong dataset. Reclassified as **face-lineage overfit study**. Artifacts kept in `output/lyra_v23f_schedule/`. Benchmark dirs renamed `v23f_prev22_*`. Config renamed `train_lyra_v23f_face_overfit.yaml`. |
| ~~v23a-rank~~ | ⚠️ Reclassified (face-lineage) | **lora-training-set** (same drift as v23f) | rank 16→32 | Same drift as v23f. Artifacts kept in `output/lyra_v23a_rank/`. Benchmark dirs renamed `v23a_prev22_*`. Config renamed `train_lyra_v23a_face_overfit.yaml`. |
| v23f2-top30-schedule | 🆕 Configured | top30 (30) | steps 2500→4000, +noise_offset | Clean rerun of what v23f was supposed to be. [#554](https://github.com/Roxabi/lyra/issues/554) |
| v23a2-top30-rank | 🆕 Configured | top30 (30) | rank 16→32 | Clean rerun of what v23a was supposed to be. 2500 steps. Paired with v23f2 for orthogonal knob tests on V22 data. |
| v23c-dop | 🟡 Deprioritized | top30 (30) (path fixed) | +diff_output_preservation | Only run if v23a2/f2/g all null. |
| v23g-prodigy | ⏳ Configured | top30 (30) (path fixed) | optimizer adamw8bit→prodigy8bit | — |
| v23h-pivotal | 🚫 Blocked | — | +embedding block (4 tokens) | Blocked on [Roxabi/imageCLI#31](https://github.com/Roxabi/imageCLI/issues/31) |
| v23e-combiner | 🟡 Conditional | depends | stack winning knobs | Only runs if individual winners exist |

### Incidents

**v23d crash at step 0** — `AttributeError: 'CustomFlowMatchEulerDiscreteScheduler' object has no attribute 'alphas_cumprod'`. Root cause: `min_snr_gamma: 5.0` in the "free wins" bundle is DDPM-only, incompatible with Klein 4B's flow matching. Removed from all v23 configs. `noise_offset` stays (scheduler-agnostic, verified at `toolkit/train_tools.py:132`). **Lesson:** verify scheduler compatibility before adding "standard" loss-side knobs to flow-matching configs.

**v23f config drift** (discovered post-training) — `train_lyra_v23f_schedule.yaml` was drafted earlier in the day when `face` was still considered the production baseline (0.614 centroid). The v23 plan was revised mid-day after the v23d benchmark disqualified `face` — the revised plan called for v23f to run on `v22_top30` config + 2500→4000 steps to get clean V22-methodology data. **The yaml was edited at 11:59 (save cadence only) but the `folder_path` and comments were never rewritten.** Training launched at 13:55 against `lora-training-set` (pre-V22 face dataset, 30 imgs) + 4000 steps + noise_offset.

**Reclassification (option a, 2026-04-05):** keep the trained artifacts as a characterization of the face dataset at the ~133 views/img overfit regime — NOT a valid v23 attribution run. Visual character: tight internal identity (face-dataset lock) + degraded color/realism (overfit + noise_offset shift). Config file renamed:

- `train_lyra_v23f_schedule.yaml` → `train_lyra_v23f_face_overfit.yaml`
- Header rewritten with full drift note
- Internal `name:` left as `lyra_v23f_schedule` to preserve the output dir path and LoRA filename
- Roxabi/lyra#547 commented + kept closed
- New sub-issue [Roxabi/lyra#554](https://github.com/Roxabi/lyra/issues/554) filed for the clean rerun with `train_lyra_v23f2_top30_schedule.yaml`

**Lesson:** when revising a plan mid-day, also re-read every yaml the plan touches. Comment-only edits can leave the data-side silently stale. Config drift is invisible until you look at the frozen `output/<name>/config.yaml` side-by-side with the plan.

### v22_face — final arc from "production default" → "stretch target" → "DEPRECATED"

1. **Started as production default** (the first Lyra LoRA, trained 2026-04-02 before V22 methodology existed) because it scored highest on the V22-1024 grand mean.
2. **Disqualified as baseline** mid-day 2026-04-05 when the chronology was discovered — pre-V22 methodology shouldn't compare to V22 runs.
3. **Reframed as stretch target** after the n=19 benchmark showed it winning every axis (0.5478 internal, 0.5581 vs-top30).
4. **Finally DEPRECATED** later the same day when the user visually inspected the benchmark outputs and rejected face for **"realism and colors"**.

Its apparent benchmark wins (+0.1225 internal, +0.0818 vs-top30 over v22_top30) are now attributed to the tight pre-V22 training data (29 near-identical images, 0.84 internal pairwise) + 500 extra steps — artifacts of bad provenance, not methodology quality. The benchmark metric couldn't distinguish "tight identity lock" from "memorized narrow pose distribution with poor realism".

**Lesson:** buffalo_l centroid similarity ≠ visual quality. Always complement numerical scoring with human visual inspection before declaring production defaults.

### v22_top30 ≈ v22_island0 — dataset size collapse

On the nvfp4-fused-long subset, `top30` (31 imgs) and `island0` (143 imgs) are within 0.0015 of each other on mean centroid (0.6074 vs 0.6059). The V22-GENERATION lesson "30 curated > 143 diverse at rank 16" is wrong on this subset — they're effectively identical. Dataset size didn't matter at rank 16 + 2500 steps. Cleanup item tracked: rewrite `V22-GENERATION.md:189`.

### Artifacts

- Exploration doc: `V23-EXPLORATION.md`
- Configs: `~/projects/archived/ai-toolkit/config/train_lyra_v23*.yaml`
- Output dirs: `~/projects/archived/ai-toolkit/output/lyra_v23*/`
- Benchmark prompts: `prompts/v23-benchmark/` (20 prompts, reusable)
- Benchmark scores: `scores_benchmark.json`
- Galleries: [`v23-gallery.html`](v23-gallery.html) (training samples), [`v23-benchmark-gallery.html`](v23-benchmark-gallery.html) (benchmark outputs, 160 images)
- Scripts: `run_benchmark.py`, `score_benchmark.py`, `score_reference_ceiling.py`, `score_v23d_samples.py`, `score_v23d_production.py`
