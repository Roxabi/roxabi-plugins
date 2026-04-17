#!/usr/bin/env python3
"""Forge round generator — 2-step batch (encode all → generate all).

Usage:
    python generate_round.py <round_dir> [--steps 28]

Reads all .md files in <round_dir>/prompts/, encodes them (text encoder only,
~7.5 GB VRAM), then generates all images (transformer + VAE only, ~4 GB VRAM).
Embeddings are cached in <round_dir>/embeds/ so encoding is skipped on re-run.
"""

from __future__ import annotations

import argparse
import gc
import json
import sys
import time
from pathlib import Path

import torch
from PIL.PngImagePlugin import PngInfo


def vram() -> str:
    used = torch.cuda.memory_allocated() / 1e9
    total = torch.cuda.get_device_properties(0).total_memory / 1e9
    return f"{used:.1f}/{total:.1f} GB"


def free() -> None:
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()


MODEL = "black-forest-labs/FLUX.2-klein-4B"


def phase1_encode(jobs: list[dict], embeds_dir: Path) -> None:
    """Load text encoder only, encode all prompts, save to disk."""
    pending = [j for j in jobs if not (embeds_dir / f"{j['id']}.pt").exists()]
    print(f"Phase 1 — Encode {len(pending)} prompt(s) ({len(jobs) - len(pending)} cached)")
    if not pending:
        return

    from diffusers import Flux2KleinPipeline

    pipe = Flux2KleinPipeline.from_pretrained(
        MODEL, transformer=None, vae=None, torch_dtype=torch.bfloat16
    )
    pipe.text_encoder.to("cuda")
    print(f"  Text encoder on GPU  VRAM: {vram()}")

    t0 = time.time()
    for i, job in enumerate(pending):
        with torch.no_grad():
            prompt_embeds, text_ids = pipe.encode_prompt(prompt=job["prompt"])
        torch.save(
            {
                "prompt_embeds": prompt_embeds.cpu(),
                "text_ids": text_ids.cpu() if text_ids is not None else None,
            },
            embeds_dir / f"{job['id']}.pt",
        )
        print(f"  [{i+1}/{len(pending)}] {job['id']} — {time.time()-t0:.0f}s elapsed")

    del pipe
    free()
    print(f"  Done in {time.time()-t0:.0f}s  VRAM: {vram()}")


def phase2_generate(jobs: list[dict], embeds_dir: Path, out_dir: Path, steps: int) -> None:
    """Load transformer + VAE only, generate all images from cached embeddings."""
    pending = [j for j in jobs if not (out_dir / f"{j['id']}.png").exists()]
    print(f"\nPhase 2 — Generate {len(pending)} image(s) ({len(jobs) - len(pending)} done)")
    if not pending:
        return

    from diffusers import Flux2KleinPipeline
    from optimum.quanto import freeze, qfloat8, quantize
    from optimum.quanto.nn import QLinear

    pipe = Flux2KleinPipeline.from_pretrained(
        MODEL, text_encoder=None, tokenizer=None, torch_dtype=torch.bfloat16
    )
    quantize(pipe.transformer, weights=qfloat8)
    freeze(pipe.transformer)

    _orig = QLinear.forward
    def _cont(self, inp):  # noqa: ANN001, ANN202
        return _orig(self, inp.contiguous())
    QLinear.forward = _cont

    pipe.transformer.to("cuda")
    pipe.vae.to("cuda")
    print(f"  Transformer (FP8) + VAE on GPU  VRAM: {vram()}")

    t0 = time.time()
    for i, job in enumerate(pending):
        data = torch.load(embeds_dir / f"{job['id']}.pt", weights_only=True)
        prompt_embeds = data["prompt_embeds"].to("cuda")
        seed = job.get("seed", i)

        with torch.no_grad():
            result = pipe(
                prompt_embeds=prompt_embeds,
                width=job.get("width", 768),
                height=job.get("height", 1024),
                num_inference_steps=steps,
                generator=torch.Generator("cuda").manual_seed(seed),
            )

        out_path = out_dir / f"{job['id']}.png"
        meta = PngInfo()
        meta.add_text("seed", str(seed))
        meta.add_text("steps", str(steps))
        meta.add_text("id", job["id"])
        result.images[0].save(out_path, pnginfo=meta)

        elapsed = time.time() - t0
        rate = (i + 1) / elapsed
        print(f"  [{i+1}/{len(pending)}] {job['id']} saved  {rate:.2f} img/s")

    print(f"\n  Done: {len(pending)} images in {int((time.time()-t0)/60)}m {int((time.time()-t0)%60)}s")


def main() -> None:
    parser = argparse.ArgumentParser(description="Forge round generator")
    parser.add_argument("round_dir", help="Path to round directory (e.g. round_1)")
    parser.add_argument("--steps", type=int, default=28)
    args = parser.parse_args()

    round_dir = Path(args.round_dir)
    prompts_dir = round_dir / "prompts"
    embeds_dir = round_dir / "embeds"
    out_dir = round_dir

    embeds_dir.mkdir(parents=True, exist_ok=True)

    # Load jobs from prompts/<id>.json files
    job_files = sorted(prompts_dir.glob("*.json"))
    if not job_files:
        print(f"No .json job files found in {prompts_dir}", file=sys.stderr)
        sys.exit(1)

    jobs = []
    for jf in job_files:
        jobs.append(json.loads(jf.read_text()))

    print(f"Forge round: {len(jobs)} jobs from {round_dir}")
    phase1_encode(jobs, embeds_dir)
    phase2_generate(jobs, embeds_dir, out_dir, args.steps)
    print("\nAll done.")


if __name__ == "__main__":
    main()
