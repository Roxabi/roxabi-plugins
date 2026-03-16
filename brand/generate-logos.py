"""Batch logo generation using Flux2-klein with fp8 quantization."""
import gc
import time
from pathlib import Path

import torch
from diffusers import Flux2KleinPipeline

PROMPTS_DIR = Path(__file__).parent / "prompts"
OUTPUT_DIR = Path(__file__).parent / "generated"
OUTPUT_DIR.mkdir(exist_ok=True)

MODEL_ID = "black-forest-labs/FLUX.2-klein-4B"


def parse_prompt_file(path: Path) -> dict:
    """Parse a .md prompt file with YAML frontmatter."""
    text = path.read_text()
    meta = {}
    body = text

    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().splitlines():
                if ":" in line:
                    key, val = line.split(":", 1)
                    key, val = key.strip(), val.strip().strip('"').strip("'")
                    try:
                        val = int(val)
                    except ValueError:
                        try:
                            val = float(val)
                        except ValueError:
                            pass
                    meta[key] = val
            body = parts[2].strip()

    return {
        "prompt": body,
        "width": meta.get("width", 1024),
        "height": meta.get("height", 1024),
        "steps": meta.get("steps", 28),
        "guidance": meta.get("guidance", 4.5),
        "negative_prompt": meta.get("negative_prompt", ""),
    }


def main():
    print(f"CUDA: {torch.cuda.is_available()}")
    print(f"Device: {torch.cuda.get_device_name(0)}")
    free_vram = torch.cuda.mem_get_info(0)[0] / 1024**3
    print(f"Free VRAM: {free_vram:.1f} GB")

    # Collect prompt files
    files = sorted(PROMPTS_DIR.glob("*.md"))
    print(f"\nFound {len(files)} prompts in {PROMPTS_DIR}")

    # Load pipeline
    print(f"\nLoading {MODEL_ID}...")
    pipe = Flux2KleinPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.bfloat16,
    )

    # Quantize transformer to int8 (fp8 segfaults on this torch/quanto build)
    print("Quantizing transformer to int8...")
    from optimum.quanto import freeze, quantize, qint8
    quantize(pipe.transformer, weights=qint8)
    freeze(pipe.transformer)
    print("Quantization done.")

    # Move to GPU
    pipe.to("cuda")

    # Optimizations
    torch.set_float32_matmul_precision("high")
    pipe.vae.enable_tiling()
    pipe.vae.enable_slicing()

    free_after = torch.cuda.mem_get_info(0)[0] / 1024**3
    used = (torch.cuda.mem_get_info(0)[1] - torch.cuda.mem_get_info(0)[0]) / 1024**3
    print(f"VRAM after load: {used:.1f} GB used, {free_after:.1f} GB free")
    print("Pipeline ready.\n")

    succeeded = 0
    failed = 0

    for i, f in enumerate(files):
        name = f.stem
        out_path = OUTPUT_DIR / f"{name}.png"

        if out_path.exists():
            print(f"[{i+1}/{len(files)}] {name} — SKIP (exists)")
            succeeded += 1
            continue

        print(f"[{i+1}/{len(files)}] {name} — generating...", end=" ", flush=True)

        try:
            t0 = time.time()
            spec = parse_prompt_file(f)
            image = pipe(
                prompt=spec["prompt"],
                width=spec["width"],
                height=spec["height"],
                num_inference_steps=spec["steps"],
                guidance_scale=spec["guidance"],
            ).images[0]

            image.save(out_path)
            elapsed = time.time() - t0
            print(f"OK ({elapsed:.0f}s) → {out_path.name}")
            succeeded += 1
        except Exception as e:
            print(f"FAILED: {e}")
            failed += 1

    # Cleanup
    del pipe
    torch.cuda.empty_cache()
    gc.collect()

    print(f"\nDone: {succeeded} succeeded, {failed} failed")
    print(f"Output: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
