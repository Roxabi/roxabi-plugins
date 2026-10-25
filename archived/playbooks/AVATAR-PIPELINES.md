# Avatar Pipelines & LoRA Training Reference

Technical reference for face-lock generation pipelines and LoRA training.

> **See also:**
> - [AVATAR-PLAYBOOK.md](AVATAR-PLAYBOOK.md) — step-by-step avatar creation workflow
> - [AVATAR-LESSONS.md](AVATAR-LESSONS.md) — failure investigations and corrective principles
> - [AVATAR-LOG.md](AVATAR-LOG.md) — per-version experiment history

---

## Face-Lock Strategy Comparison

Four viable strategies for face-consistent avatar generation on RTX 5070 Ti (16 GB). **Strategy D is the current production recommendation.**

| # | Strategy | Model | Face lock method | Quality | Complexity | Status |
|---|----------|-------|-----------------|---------|------------|--------|
| **A** | `pulid-flux1-dev` | FLUX.1-dev GGUF Q5_K_S | PuLID v0.9.1 at inference | Clean 1024x1024 | Low — engine exists | Live (face lock, no LoRA) |
| **B** | Klein 4B + projection fix | Klein 4B | PuLID Klein v2 + Linear(4096→3072) | Unknown | Medium | Untested (hypothetical) |
| **C** | Klein 4B Base + LoRA (FP8) | Klein 4B Base (undistilled) | Trained LoRA weights (fused then FP8 quantized) | 0.63–0.66 centroid @ 1024×1024 | High (training) | Live (V22 LoRA, quality variant) |
| **D** | **Klein 4B Base + LoRA (NVFP4)** | **Klein 4B Base + runtime NVFP4** | **LoRA fused into bf16, then runtime-quantized to NVFP4** | **0.61–0.64 centroid (~0.02 below FP8)** | High (training) | **Live (V22 LoRA, production default)** |

### Decision matrix (updated 2026-04-05 from V22-1024 run)

| Need | Best strategy | Why |
|------|--------------|-----|
| **Best quality single image** | C (FP8 fused) | 0.01–0.02 higher centroid than NVFP4, still uses the LoRA |
| **Production batch (speed + VRAM matters)** | **D (NVFP4 fused)** | 8× faster than FP8 (~4s/image at 1024), ~60% less VRAM (~3 GB), quality cost is noise-level |
| **Face-locked batch without a trained LoRA** | A (`pulid-flux1-dev`) | Strong face lock (0.55+), smoother output, no LoRA training needed |
| **Low VRAM host** | D (NVFP4) | Only path that fits in ~3 GB transformer + overhead |
| **Texture-critical hero image** | Klein 4B, no LoRA, 28 steps | Best natural texture, no identity lock |

---

## Strategy A: FLUX.1-dev + PuLID v0.9.1 (One-Off Face Lock, No LoRA)

> **Scope:** use this when you need a handful of face-locked images for a specific reference face and don't want to train a LoRA. For the daily-use avatar pipeline (Lyra), use Strategy D. **FLUX.1-dev is NOT used anywhere in V22/V23 training data generation** — V22 bootstraps its training set from Klein 4B itself via dual face+CLIP scoring.

PuLID v0.9.1 natively targets FLUX.1-dev (dim=3072, same hidden size) — no projection needed. FLUX.1-dev is NOT step-distilled — 24 steps lets PuLID corrections smooth out. Clean output confirmed in 1024 comparison gallery.

**Architecture:**
- Transformer: FLUX.1-dev GGUF Q5_K_S (~6 GB on GPU)
- PuLID: v0.9.1 weights (`pulid_flux_v0.9.1.safetensors`), 20 CA modules (10 double every 2nd block, 10 single every 4th block), dim=3072, kv_dim=2048
- Face extraction: InsightFace AntelopeV2 + EVA-CLIP (same as Klein pipeline)
- Peak VRAM: ~10 GB with CPU offload
- Time: ~42s per 1024x1024 image (24 steps)

**Usage:**
```bash
cd ~/projects/imageCLI
uv run imagecli generate prompt.md -e pulid-flux1-dev --no-compile
uv run imagecli batch prompts_dir/ -e pulid-flux1-dev --no-compile
```

**Prompt frontmatter:**
```yaml
---
engine: pulid-flux1-dev
face_image: /path/to/reference-face.png
width: 1024
height: 1024
steps: 24
guidance: 4.0
pulid_strength: 0.8
---
```

**PuLID tuning:**
| Strength | Scale | Banding | Face lock | Notes |
|----------|-------|---------|-----------|-------|
| 1.5 | 1.0x | Visible (Klein 9B) | Strong | Too aggressive for step-distilled models |
| 0.8 | 1.0x | None (FLUX.1-dev) | Good | Recommended default |
| 0.8 | 0.5x | None | Moderate | Best quality/lock balance on Klein 9B |
| 0.6 | 0.3x | None | Light | Conservative — may lose identity |

**Comparison gallery:** `brand/1024-comparison.html` — side-by-side comparison of all pipelines.

**Limitation:** FLUX.1-dev quality ceiling is slightly below Klein 4B for non-face-locked images (Klein has better text rendering, finer detail at high res). For hero images without face lock, use Klein 4B directly.

**Prerequisites:**
- PuLID FLUX.1 weights: `~/ComfyUI/models/pulid/pulid_flux_v0.9.1.safetensors` (download from `guozinan/PuLID` on HuggingFace)
- InsightFace AntelopeV2: `~/ComfyUI/models/insightface/models/antelopev2/`
- FLUX.1-dev HuggingFace access (gated model, requires token)
- Install PuLID deps: `uv sync --extra pulid`

---

## Strategy B: Klein 4B + PuLID Projection Fix (Untested)

The current `pulid-flux2-klein` engine in imageCLI targets Klein 4B but **cannot produce correct face locks** because:

1. PuLID Klein v2 weights (`pulid_flux2_klein_v2.safetensors`) have dim=4096
2. Klein 4B has hidden_size=3072
3. The engine feeds 3072-dim `out_hs` into 4096-dim CA LayerNorm — dimension mismatch
4. `from_safetensors()` uses `strict=False` and silently skips CA layers (`pulid_ca_double.N` vs `double_ca.N` key names)

**Fix required:** The iFayens ComfyUI PuLID node handles this with a runtime `nn.Linear(4096, 3072, bias=False)` projection. Adding this to `_patch_flux()` plus fixing the CA key names would let PuLID run on Klein 4B.

**Why it might be worth it:** Klein 4B at 28 steps produces the cleanest images in the pipeline. If the projected identity holds, this gives face lock + best-quality base model.

**Why it might not work well:** The projection is a lossy linear transformation of the identity signal. The PuLID weights were trained for 4096-dim space (Klein 9B) — projecting down to 3072 discards information.

---

## Klein 9B + PuLID (Two-Phase, Deprecated for Avatars)

> **Deprecated:** Klein 9B + PuLID produces visible banding at 1024x1024. Use Strategy A (`pulid-flux1-dev`) instead. Kept here for reference.
>
> **Banding root causes:** see [AVATAR-LESSONS.md](AVATAR-LESSONS.md)

### Why Klein 9B, not 4B (for PuLID)

PuLID models (`pulid_flux2_klein_v2.safetensors`) have **dim=4096**, which matches Klein 9B's `hidden_size=4096`. Klein 4B uses `hidden_size=3072` — the mismatch triggers a random projection and identity is lost.

| Model | hidden_size | PuLID match | Face lock works? |
|-------|-------------|-------------|-----------------|
| Klein 4B | 3072 | No (dim mismatch) | No (random projection) |
| Klein 9B | 4096 | Yes (exact match) | Yes |

### Two-phase approach

Klein 9B in BF16 = 18 GB transformer + 16 GB text encoder — never fits together in 16 GB VRAM.
With FP8 and phase splitting, each phase fits comfortably:

| Phase | Model | VRAM | Machine |
|-------|-------|------|---------|
| 1 — encode | Qwen3 8B FP8 | ~8 GB | Machine 2 (5070 Ti) |
| 2 — generate | Klein 9B float8 + PuLID + VAE | ~9.3 GB / 16.6 GB | Machine 2 (5070 Ti) |

**RTX 3080 (Machine 1, sm_86 Ampere) cannot be used for encoding** — it has no native FP8 matmul hardware (requires sm_89+).
**RTX 5070 Ti (Machine 2, sm_120 Blackwell) has native FP8** — both phases run fast and safely.

### Quantization: INT8 vs Float8

Klein 9B requires quantization to fit in 16.6 GB VRAM. **Use `qfloat8`, not `qint8`.**

| Quantization | VRAM | Banding | Notes |
|---|---|---|---|
| `qint8` (INT8) | ~9.3 GB | **Yes** — visible horizontal bands | 256 levels; rounding errors align with transformer spatial structure |
| `qfloat8` (Float8) | ~9.3 GB | Residual | Dynamic-range-preserving; requires contiguity patch |
| BF16 (no quant) | ~18 GB (needs CPU offload) | Residual | Eliminates quantization but banding persists — root cause is elsewhere |

### 1024x1024 pipeline comparison

| Pipeline | Model | Steps | PuLID | Banding? |
|---|---|---|---|---|
| `imagecli generate` | Klein 4B BF16 | 28 | No | **Clean** |
| `generate_training_9b.py` | Klein 9B FP8 | 4 | No | Check gallery |
| `generate_training_9b.py` | Klein 9B FP8 | 4 | Yes (1.5) | **Visible banding** |
| `imagecli generate` (pulid-flux1-dev) | FLUX.1-dev GGUF Q5_K_S | 24 | Yes (v0.9.1, 0.8) | **Clean — best pipeline** |

**Comparison gallery:** `brand/1024-comparison.html`

### Contiguity patch (required for float8)

`torch.ops.quanto.gemm_f16f8_marlin` (Marlin fp8 GEMM kernel) requires a contiguous input tensor. `QLinear.forward` does not guarantee this. The patch:

```python
from optimum.quanto.nn import QLinear
_orig_ql_fwd = QLinear.forward
def _ql_fwd_cont(self, input):
    return _orig_ql_fwd(self, input.contiguous())
QLinear.forward = _ql_fwd_cont
```

If writing a new generation script that uses `qfloat8`, copy this patch.

### Prerequisites

```bash
# 1. HF token — Klein 9B is a gated model
cd ~/projects/imageCLI
uv run huggingface-cli login
# Accept licence at: huggingface.co/black-forest-labs/FLUX.2-klein-9B
# First run downloads ~25 GB: text encoder (~16 GB) + transformer (~9 GB)

# 2. Models already in place
# ~/ComfyUI/models/pulid/pulid_flux2_klein_v2.safetensors  (1.3 GB, dim=4096)
# ~/ComfyUI/models/insightface/models/antelopev2/
# ~/ComfyUI/models/diffusion_models/flux2-klein-4b-comfy.safetensors  (4B, fixed)
```

### Run the batch

The script supports two embedding directories: `embeddings-klein9b/` (training data) and `embeddings-portraits/` (portraits).

```bash
cd ~/projects/imageCLI

# Phase 1 only — encode prompts, save to embeddings dir
uv run python3 ~/.agent/lyra/brand/generate_training_9b.py --phase encode

# Verify embeddings exist:
ls ~/.agent/lyra/brand/embeddings-klein9b/ | head -5

# Phase 2 only — generate from saved embeddings (float8, contiguity patch auto-applied)
uv run python3 ~/.agent/lyra/brand/generate_training_9b.py --phase generate --pulid-strength 0.9

# Or run both phases in sequence:
uv run python3 ~/.agent/lyra/brand/generate_training_9b.py
```

Output: `~/.agent/lyra/brand/concepts/avatar-training/` (400x400 PNGs)

### Tuning reference

| Parameter | Default | Effect |
|-----------|---------|--------|
| `--pulid-strength` | 0.9 | Higher = stronger face lock, less prompt freedom |
| `steps` (frontmatter) | 4 | Klein 9B is step-distilled, 4 is standard |
| `guidance` (frontmatter) | 3.5 | Increase to 5–7 for stronger prompt adherence |
| `width/height` | 400 | Training images; can go up to 512 safely |

---

## Klein 4B Details

### VRAM and CPU offload

Klein 4B components: text encoder (Qwen3) = 8.04 GB + transformer = 7.75 GB + VAE = 0.17 GB = **15.96 GB total**. RTX 5070 Ti has 15.45 GB usable. `pipe.to("cuda")` OOMs.

`enable_model_cpu_offload()` is required — moves one component to GPU at a time. Peak VRAM = 8.45 GB. The imageCLI `flux2-klein` engine uses this by default.

Klein 4B now uses FP8 quanto quantization (transformer 7.75 GB -> ~3.9 GB) + CPU offload. Peak VRAM: 7.84 GB. The `flux2-klein` imageCLI engine applies this automatically.

### Klein 4B architecture (for engine development)

| Property | Value |
|----------|-------|
| Double blocks | 5 (`Flux2TransformerBlock`) |
| Single blocks | 20 (`Flux2SingleTransformerBlock`) |
| Hidden dim | **3072** (not 4096) |
| Double block forward sig | `(hidden_states, encoder_hidden_states, temb_mod_img, temb_mod_txt, ...)` |
| Single block forward sig | `(hidden_states, encoder_hidden_states, temb_mod, ...)` — also returns `(hs, enc_hs)` tuple |

Note: Flux2Klein block signatures differ significantly from standard Flux1. The ComfyUI PuLID node uses positional args `(img, txt, vec, ...)` which breaks under diffusers (keyword-only calls).

### PuLID model structure

The `pulid_flux2_klein_v2.safetensors` state dict uses key names `pulid_ca_double.N.*` and `pulid_ca_single.N.*` (not `double_ca` / `single_ca` as named in the ComfyUI node code). All CA module dimensions are **4096** — matching Klein 9B, not 4B.

The `id_former` is fully trained (all weights present, dim=4096). The CA layers have 5 double and 7 single modules at dim=4096.

### imageCLI engine attempt (2026-04-01)

A `pulid-flux2-klein` engine was built in `~/projects/imageCLI/src/imagecli/engines/pulid_flux2_klein.py`. It injects PuLID directly into the diffusers pipeline via forward-method monkey-patching, without ComfyUI. The engine is wired up and importable but **cannot produce correct face locks against Klein 4B** due to the dim mismatch. Not yet tested against Klein 9B.

**Dependency gotchas (imageCLI venv):**

| Package | Constraint | Reason |
|---------|-----------|--------|
| `numpy` | `<2.0` | InsightFace compiled against NumPy 1.x ABI |
| `ml_dtypes` | `>=0.4.0` | `onnx>=1.19.0` imports `ml_dtypes.float4_e2m1fn` added in 0.4.0 |

These are already fixed in `pyproject.toml` `[pulid]` dependency group.

### Open questions

1. **Port engine to Klein 9B**: currently hardcodes `model_id = "black-forest-labs/FLUX.2-klein-4B"`. Updating to 9B and fixing two-phase split would enable `imagecli batch` for face-locked generation. Worth building vs standalone script?
2. **`generate_training_9b.py` forward signatures**: may hit `temb_mod_img`/`temb_mod_txt` signature issue. Needs verification.
3. **`pulid_ca_double` key mismatch**: `_PuLIDFlux2.from_safetensors()` uses `strict=False` and silently skips CA layers. If pointed at Klein 9B, CA layer loading must use actual key names.
4. **`face-lock-gallery.html`**: lives at `~/.agent/lyra/brand/face-lock-gallery.html`, auto-refreshes watching `concepts/avatar-final/face-locked/`. Output from `generate_training_9b.py` goes to a different path — gallery path needs updating.

---

## Strategy D: NVFP4 + LoRA via Runtime Quantization (Production Recommended)

**Shipped in `flux2-klein-fp4` engine, 2026-04-05** (Roxabi/imageCLI commit `192837b`).

### Why this path exists

The default NVFP4 engine loads BFL's pre-quantized weights from disk. Those encode the un-fused base model, so any LoRA fusion gets overwritten by the disk patch — LoRA was impossible on that path.

The fix is runtime quantization: load bf16 base → fuse LoRA → quantize the fused weights layer-by-layer via `QuantizedTensor.from_float(w, "TensorCoreNVFP4Layout")` from comfy-kitchen. Bypasses the disk weights entirely.

### Engine code path (when `--lora` is set)

```python
pipe = Flux2KleinPipeline.from_pretrained(BASE_REPO, torch_dtype=torch.bfloat16)
pipe.load_lora_weights(lora_path)
if lora_scale != 1.0:
    pipe.set_adapters(["default_0"], adapter_weights=[lora_scale])
pipe.fuse_lora()
pipe.unload_lora_weights()
pipe.transformer.to("cuda")
# Walk nn.Linear modules, replace each weight with runtime-quantized QuantizedTensor
_runtime_quantize_transformer_to_nvfp4(pipe.transformer)
```

When `--lora` is NOT set, engine falls back to the original path (download + patch BFL disk weights).

### Usage

```bash
cd ~/projects/imageCLI
# Single image — production default is lyra_v22_top30 (replaces face 2026-04-05)
uv run imagecli generate prompt.md \
  --lora ~/projects/archived/ai-toolkit/output/lyra_v22_top30/lyra_v22_top30.safetensors

# Batch
uv run imagecli batch prompts_dir/ \
  -e flux2-klein-fp4 \
  --lora ~/projects/archived/ai-toolkit/output/lyra_v22_top30/lyra_v22_top30.safetensors \
  --no-compile
```

Frontmatter:
```yaml
---
engine: flux2-klein-fp4
width: 1024
height: 1024
steps: 8
seed: 8391
---
```

### Performance (V22-1024 measured, RTX 5070 Ti)

| Metric | NVFP4 + LoRA | FP8 + LoRA (for comparison) |
|---|---|---|
| Per-image time @ 1024×1024, 8 steps | **~4s** | ~20s |
| Peak VRAM (transformer) | **~2 GB** | ~4 GB |
| Peak VRAM (total with text encoder + VAE) | **~3 GB** | ~8 GB |
| Centroid score vs top30 (V22-1024 mean) | **0.61–0.64** | 0.63–0.66 |

**Quality cost:** ~0.01–0.02 centroid score vs FP8 (noise level at 1024×1024). At 256×256 the gap was ~0.03 — cost lives entirely in the LoRA correction ΔW which is ~0.4% of base weight magnitude, so quantization noise in the small delta matters proportionally more. At production resolution the cost disappears into measurement noise.

**Speed win:** 8× faster than FP8 at 256×256 (~2.5s vs ~20s), roughly 5× at 1024×1024 (~4s vs ~20s). The ratio shrinks with resolution because FP8's Marlin kernel overhead amortizes better on larger matmuls.

### Requirements

- Blackwell GPU (sm_120+) — RTX 5070 Ti on ROXABITOWER has it, RTX 3080 on roxabituwer does NOT
- CUDA 13.0+ (cu130)
- `comfy-kitchen[cublas]` installed via `uv sync --group fp4`

### No-LoRA runtime vs disk quantization: equivalent

V22-validation tests N/O/P/Q compared runtime-quantizing the vanilla bf16 base (comfy-kitchen, 109 layers) against loading BFL's pre-quantized disk weights (100 layers). The 9-layer difference doesn't materially affect output — means differed by 0.004 at 256×256. **We don't need BFL's HF-hosted disk weights** — runtime quantization works for both no-LoRA and with-LoRA cases.

### Limitations

- `comfy-kitchen` requires sm_120+. Cannot run on Ampere or earlier.
- Runtime quantization on initial load adds ~2 seconds vs the disk-patch path, but only once per pipeline load.
- The CLI surface has no way to specify a different scale (hardcoded to `self.lora_scale`, default 1.0). This is fine because scale > 1.0 degrades output anyway — see AVATAR-LESSONS.md "Scale Lever Above 1.0 Degrades Output".

---

## Strategy C: LoRA Training on Klein 4B Base

Train face identity into a LoRA adapter so the model generates the face natively — no PuLID needed at inference.

### Critical: Base vs Distilled

| | Base (`FLUX.2-klein-base-4B`) | Distilled (`FLUX.2-klein-4B`) |
|--|--|--|
| **For training** | **Use this** | Never train on distilled |
| **Inference steps** | ~50, guidance 4.0 | 4-8 steps, guidance 3.5 |
| **LoRA quality** | Native, full training signal | Degraded — distilled models resist fine-tuning |

Training on the distilled model is the #1 cause of "my LoRA doesn't work" in the FLUX community.

### Training tools with Klein 4B support

| Tool | Klein 4B? | Script/Config |
|--|--|--|
| **diffusers** | Yes | `train_dreambooth_lora_flux2_klein.py` (uses `Flux2KleinPipeline` + `Qwen3ForCausalLM`) |
| **ostris/ai-toolkit** | Yes | Day-0 FLUX.2 support, 20-30% faster than SimpleTuner |
| **SimpleTuner** | Yes | FLUX.2 quickstart at `docs.simpletuner.io/quickstart/FLUX2/` |
| **DiffSynth-Studio** | Yes | Explicit Klein 4B training shell script |
| kohya_ss/sd-scripts | Unclear | FLUX.2 Klein support not confirmed |

### Training config (ai-toolkit, V22)

```yaml
network:
  type: "lora"
  linear: 16        # rank — increase to 32/64 for stronger identity
  linear_alpha: 16   # alpha — keep equal to rank for 1.0 effective weight

train:
  batch_size: 1
  steps: 2500
  gradient_accumulation_steps: 4  # effective batch = 4. Try 2 for faster training
  optimizer: "adamw8bit"
  lr: 1e-4

model:
  name_or_path: "black-forest-labs/FLUX.2-klein-base-4B"
  arch: "flux2_klein_4b"
  quantize: true
```

### Recommended config (RTX 5070 Ti, 16 GB)

```yaml
model:        black-forest-labs/FLUX.2-klein-base-4B
rank:         16                    # start here, 32 if underfitting
lr:           1e-4                  # AdamW8bit; or 1.0 with Prodigy
optimizer:    adamw8bit
steps:        2000-2500
batch_size:   1                     # mandatory at 16 GB
resolution:   768                   # start, multi-bucket [512, 768, 1024]
trigger_word: "sks"                 # or "ohwx" — in every caption

# Required for 16 GB:
gradient_checkpointing: true        # trades compute for memory
cache_latents: true                 # pre-encode images, frees VAE during training
quantize: true                      # FP8 model quantization (native on sm_120)
use_8bit_adam: true                 # halves optimizer state memory
```

### diffusers example command

```bash
export MODEL_NAME="black-forest-labs/FLUX.2-klein-base-4B"

accelerate launch train_dreambooth_lora_flux2_klein.py \
  --pretrained_model_name_or_path=$MODEL_NAME \
  --instance_data_dir=./face_photos \
  --output_dir=./trained-flux2-klein-4b \
  --do_fp8_training \
  --gradient_checkpointing \
  --cache_latents \
  --instance_prompt="a photo of sks person" \
  --resolution=768 \
  --train_batch_size=1 \
  --guidance_scale=1 \
  --use_8bit_adam \
  --gradient_accumulation_steps=4 \
  --learning_rate=1e-4 \
  --lr_scheduler="constant" \
  --lr_warmup_steps=100 \
  --max_train_steps=2500 \
  --rank=16 \
  --seed="0"
```

### Training data requirements

| Aspect | Recommendation | Notes |
|--------|---------------|-------|
| **Source** | **Klein 4B native** (no PuLID, no LoRA) cherry-picked for face similarity | PuLID data produces smooth LoRA — see [AVATAR-LESSONS.md](AVATAR-LESSONS.md) |
| **Count** | 25-30 curated + 20-30 regularization | 200 is overkill — overfitting risk + style dilution |
| **Resolution** | Multi-bucket: 512, 768, 1024 | Training at 512 only -> soft/blurry output at 1024 inference |
| **Diversity** | Varied angles (40% front, 30% 3/4, 20% profile, 10% other), varied lighting, expressions, backgrounds | Without diversity the LoRA overfits to headshots |
| **Regularization** | 20-30 generic images without trigger word | Prevents catastrophic forgetting (face "leaking" into all generations) |
| **Captions** | Natural language, not tags. "a photo of sks person standing in a park" | Include trigger word in every caption; describe everything EXCEPT the face |
| **Quality** | Must match inference model's native texture | PuLID/FLUX.1-dev data produces smooth LoRA output |

### Dataset composition targets (for final 28 images)

| Dimension | Distribution | Target count |
|-----------|-------------|-------------|
| **Shot type** | 30% headshot, 35% half-body, 25% full-body, 10% detail | 9 / 11 / 6 / 2 |
| **Angle** | 35% frontal, 40% three-quarter, 15% profile, 10% tilted | 11 / 10 / 4 / 3 |
| **Outfits** | 6+ different, no single outfit >4 images | varies |
| **Backgrounds** | 5+ different, mix plain + environmental | varies |
| **Expressions** | 5-7 types, neutral as plurality not majority | varies |
| **Lighting** | 4+ conditions, avoid harsh face shadows | varies |

### 512x512 for scoring — why not smaller

InsightFace ArcFace needs faces >80px for reliable embeddings. At 512x512:
- Headshot: face ~300px — excellent
- Half-body: face ~150px — good
- Full-body: face ~80px — borderline but works

At 384x384, full-body faces drop to ~60px — too small for reliable scoring.

### Known pitfalls

| Pitfall | Impact | Mitigation |
|---------|--------|------------|
| Training on distilled model | LoRA doesn't learn | Always use `FLUX.2-klein-base-4B` |
| LR too high (>2e-4) | Instant divergence | Start at 1e-4, or use Prodigy (auto-tunes) |
| No regularization images | Face leaks into all prompts | Include 20-30 generic images without trigger word |
| 512-only training | Soft/blurry at 1024 inference | Multi-resolution bucket training [512, 768, 1024] |
| Too many steps (>3000) with 200 images | Overfitting — outputs look identical to training data | Monitor checkpoints every 250 steps; weight decay 0.01-0.1 |
| Auto-captions without review | Wrong/missing details | Manually edit every caption |
| **PuLID/FLUX.1-dev training data** | **LoRA produces smooth, plastic output** | **Use Klein 4B native images — see [AVATAR-LESSONS.md](AVATAR-LESSONS.md)** |

### Quality expectations

- ~70-85% identity fidelity compared to PuLID direct injection
- LoRA captures general likeness but may lose subtle features (exact eye shape, skin texture)
- More **consistent** across generations than PuLID (less variance)
- Less **faithful** to exact reference than PuLID (baked average vs per-generation embedding)
- Works at any resolution without quality degradation (if trained multi-resolution)

### Lyra identity block (core prompt)

Every prompt must include this fixed description:

```
Young woman, mid-twenties. Dark honey blonde wavy hair,
past shoulders, center-parted. Fair skin. Grey-green eyes.
Straight nose. Natural lips. No makeup. Slim build,
visible collarbones.
```

This anchors the model toward 006's face without PuLID.

### Identity block rules

**Study the reference image carefully** before writing the identity block. Describe only what you actually see — don't invent features.

**Keep it short and concrete.** Every vague or ambiguous word becomes randomness in the output:

| Bad (random results) | Why | Good (consistent) |
|---------------------|-----|-------------------|
| "scattered freckles" | 006 has NO freckles — misread that corrupted V18 | remove entirely |
| "natural imperfections, small moles" | Model adds random spots in random places | remove — let the model decide |
| "slightly messy" | "slightly" is subjective — generates neat to wild | just "wavy hair" |
| "slightly hooded" | Specific eye shape the model may not follow | remove — too detailed |
| "Angular jawline, high cheekbones" | Bone structure details conflict and confuse | remove — implicit in the face |
| "Soft eyebrow arch" | Adds noise without anchoring | remove |

**The principle:** describe only dominant, unambiguous features. Let the model fill in the rest. Shorter prompts = more consistent faces.

**What to include:** age, hair color + style + length, skin tone, eye color, build. That's it.

**What to omit:** moles, freckles (unless truly dominant), bone structure, eyebrow shape, eyelid shape, lip shape, nose bridge width. Too subtle for text-to-image consistency.

> **Full V18/V19 failure analysis:** see [AVATAR-LESSONS.md](AVATAR-LESSONS.md)

### Recommended execution order

**Phase 1 — Generate candidates (fast, low-res)**
1. Generate **400 images at 512x512** with Klein 4B distilled, FP8, 28 steps, no PuLID
2. All prompts share a fixed identity block describing the agent's specific features
3. Diverse shot types, angles, clothing, backgrounds, expressions, lighting
4. Estimated time: ~400 x 10s = ~67 min

**Phase 2 — Score and cluster**
5. Score all 400 against reference with InsightFace cosine similarity
6. Compute full 400x400 pairwise similarity matrix
7. Find islands (pairwise-consistent groups):
   - **Cluster A (ref-anchored):** top 28-30 with highest similarity to reference AND high mutual pairwise (>0.50)
   - **Cluster B (self-emergent):** largest group of 28-30 with highest mutual pairwise, ignoring reference
8. Compare clusters: internal consistency vs diversity
9. Pick the best cluster (or merge)

**Phase 3 — Upscale winners**
10. Re-generate 28-30 winners at **1024x1024** with same seed + prompt (deterministic)

**Phase 4 — Train LoRA**
11. Caption each image (trigger word, describe pose/clothing/setting, omit face geometry)
12. Train on Klein **base** 4B with ai-toolkit
13. Save checkpoints every 250 steps, pick best by face similarity scoring

### Shape C trigger

When 200+ face-locked images exist in training data, proceed to LoRA training.

---

## LoRA at Inference: How It Works

**Training** teaches the model "when you see the trigger word, make this specific face":
1. Pick training image + caption -> add noise -> ask model to denoise -> compare -> update LoRA weights only
2. LoRA = small matrices (rank x hidden_dim) injected into transformer attention layers
3. Higher rank = more capacity to encode identity (more "knobs")

**Inference** generates images using the learned identity:
1. Text encoder reads prompt -> embeddings
2. Transformer denoises from random noise over N steps, guided by embeddings
3. LoRA adds small corrections at each step, nudging output toward the learned face
4. VAE decodes latent -> pixels

### Prompt length vs LoRA strength (corrected 2026-04-05 from V22-1024 run)

**Earlier advice to "keep prompts short" was wrong** — it came from 256×256 measurements where face detection was below buffalo_l's reliable threshold. At 1024×1024 scored against the training centroid:

| Prompt style | Centroid score (1024×1024) | Notes |
|---|---|---|
| **Long, descriptive, natural language** | **~0.63–0.66** (best) | Matches the training set caption distribution |
| Short, trigger-word heavy | ~0.55–0.60 | Slightly weaker at production resolution |

**Rule (updated):** Use long, descriptive prompts at inference. The training data had rich captions, so long inference prompts match the training distribution better. Short prompts work but score ~0.05–0.07 lower on centroid similarity.

The only caveat: don't over-describe the face itself. Describe the scene, mood, outfit, lighting, setting — the LoRA handles the identity.

### Tuning levers (corrected 2026-04-05)

| Parameter | Set at | Default | Effect |
|---|---|---|---|
| **rank** | Training | 16 | Rank 16 is sufficient at 1024×1024 production resolution (V22 validated). Earlier "retrain at 32/64" advice was wrong — it came from 256 artifacts. |
| **alpha** | Training | 16 | Keep equal to rank for effective weight 1.0 |
| **training steps** | Training | 2500 | Stronger lock, but overfitting risk past 3000 |
| **gradient_accumulation** | Training | 4 | Effective batch = 4. Try 2 for faster training |
| **dataset size** | Training | 30 | 30 curated > 143 diverse at rank 16 (V22 finding) |
| **LoRA scale** | Inference | **1.0 — NEVER CHANGE** | **Boosting degrades output monotonically.** See AVATAR-LESSONS.md "Scale Lever Above 1.0". Fused and unfused both affected. The `adapter_weights` / `lora_scale` parameter is not a strength knob. |
| **inference steps** | Inference | **8** | Klein 4B is step-distilled; 8 is native. 20 often scores LOWER than 8. Use 8 for production. |
| **fusion mode** | Inference | fused | Mathematically equivalent to unfused at scale 1.0. Use fused for the FP8 engine (required), either for bf16, and fused-via-runtime-quantize for NVFP4. |

### V22 training results

| Dataset | Images | Observations |
|---|---|---|
| **top30** | 30 (frontals + close-ups from best island) | Best identity lock. Recognizable with short prompts. |
| **top50** | 33 (top30 + more diverse angles) | Slightly softer identity |
| **island0** | 143 (full cross-pose island) | Identity averaged out — too much diversity for rank 16 |

**Key finding:** 30 tightly-curated images > 143 diverse images for identity LoRA at rank 16. More images help generalization but dilute identity signal when rank is low.

> **Full V22 experiment details:** see [AVATAR-LOG.md](AVATAR-LOG.md)

### LoRA + quantization constraints

| Operation order | Works? | Engine |
|---|---|---|
| Load LoRA → fuse → quantize (FP8) → GPU | **Yes** — LoRA baked into weights before quantization | `flux2-klein --lora` |
| Load LoRA → fuse → runtime-quantize (NVFP4) → GPU | **Yes** — NVFP4 via `QuantizedTensor.from_float` | `flux2-klein-fp4 --lora` |
| No quantize, bf16 + CPU offload, unfused adapter | Yes — slower (~10–25s/img at 1024) but flexible | Raw diffusers (no imageCLI path) |
| Quantize FP8 → load LoRA → fuse | **No — silent no-op.** LoRA appears to load but has no effect on quantized weights. Outputs are byte-identical to no-LoRA. V22 confirmed via md5sum. | Never do this |
| BFL disk NVFP4 weights → try to fuse LoRA | **No — LoRA is overwritten by disk patch.** Disk encodes un-fused base. | Use runtime quantization instead |

### Inference (imageCLI — shipped 2026-04-05)

Both Klein engines support `--lora PATH` and `--lora-scale N`:

```bash
# FP8 path — highest quality, slower, more VRAM
uv run imagecli generate prompt.md -e flux2-klein \
  --lora ~/projects/archived/ai-toolkit/output/lyra_v22_top30/lyra_v22_top30.safetensors

# NVFP4 path — production recommended, fast, low VRAM
uv run imagecli generate prompt.md -e flux2-klein-fp4 \
  --lora ~/projects/archived/ai-toolkit/output/lyra_v22_top30/lyra_v22_top30.safetensors
```

Both engines handle load-order correctly (load → fuse → quantize). Setting `--lora-scale` above 1.0 is allowed but degrades output — leave it at the default 1.0.

### Current production config (2026-04-05)

```yaml
engine:  flux2-klein-fp4    # NVFP4 via --lora, ~4s/image, ~3 GB VRAM
lora:    lyra_v22_top30 (final checkpoint)
scale:   1.0                # never touch the lever
prompt:  long, descriptive, natural language
steps:   8                  # Klein native, don't increase
size:    1024×1024
```

Expected: ~0.48 vs top30 centroid on 20-prompt dual-metric benchmark (72.7% of the 0.6551 LOO ceiling), 0.43 internal coherence across diverse prompts. See AVATAR-LOG.md "V23" section for the full benchmark framework.

**Previous production default: `lyra_face_klein4b_v1` — DEPRECATED 2026-04-05.** User visually rejected for realism/colors. Also pre-V22 methodology (trained 2026-04-02 before V22 dual-signal curation existed), tight pre-V22 training data (`lora-training-set`, 29 near-identical images), +500 step advantage. Its apparent benchmark wins were artifacts of tight training data + extra steps, not methodology quality. Kept for provenance only.

> **Do NOT:** boost `adapter_weights`, test `lora_scale=1.5`, use `lora_face_klein4b_v1` as production, use `lora-training-set` as a training dataset for new runs. See AVATAR-LESSONS.md for details.

---

## Sources

- [diffusers Klein training script](https://github.com/huggingface/diffusers/blob/main/examples/dreambooth/train_dreambooth_lora_flux2_klein.py)
- [BFL Klein Training Docs](https://docs.bfl.ai/flux_2/flux2_klein_training)
- [BFL Klein Style Training Example](https://docs.bfl.ai/flux_2/flux2_klein_training_example)
- [FLUX.2-klein-base-4B on HuggingFace](https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4B)
- [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit/) — Klein 4B/9B LoRA training
- [Klein 16GB VRAM Training Guide](https://www.runcomfy.com/trainer/ai-toolkit/flux-2-klein-16gb-vram-training)
- [Advanced Flux DreamBooth LoRA (HF Blog)](https://huggingface.co/blog/linoyts/new-advanced-flux-dreambooth-lora)
- [SimpleTuner FLUX.2 Quickstart](http://docs.simpletuner.io/quickstart/FLUX2/)
- [DiffSynth-Studio Klein 4B script](https://github.com/modelscope/DiffSynth-Studio/blob/main/examples/flux2/model_training/lora/FLUX.2-klein-4B.sh)
- [50+ Klein LoRA Training Runs](https://medium.com/@calvinherbst/50-flux-2-klein-lora-training-runs-dev-and-klein-to-see-what-config-parameters-actually-matter-3196e4f64fd5)
- [Flux Training Tips & Tricks 2025](https://apatero.com/blog/flux-training-tips-tricks-complete-guide-2025)
- [iFayens/ComfyUI-PuLID-Flux2](https://github.com/iFayens/ComfyUI-PuLID-Flux2) — Klein 4B projection reference
