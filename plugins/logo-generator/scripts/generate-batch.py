"""Batch image generation using Flux2-klein + optimum-quanto. No imageCLI required."""
import argparse
import gc
import re
import subprocess
import sys
import time
from pathlib import Path

MODEL_ID = "black-forest-labs/FLUX.2-klein-4B"


def parse_frontmatter(text: str) -> tuple[dict, str]:
    meta, body = {}, text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().splitlines():
                m = re.match(r'^(\w+)\s*:\s*(.+)$', line)
                if m:
                    key, val = m.group(1).strip(), m.group(2).strip().strip('"').strip("'")
                    try:
                        val = int(val)
                    except ValueError:
                        try:
                            val = float(val)
                        except ValueError:
                            pass
                    meta[key] = val
            body = parts[2].strip()
    return meta, body


def parse_prompt_file(path: Path, cli_args: argparse.Namespace) -> dict:
    meta, body = parse_frontmatter(path.read_text())
    return {
        "prompt": body,
        "width": cli_args.width or meta.get("width", 1024),
        "height": cli_args.height or meta.get("height", 1024),
        "steps": cli_args.steps or meta.get("steps", 28),
        "guidance": meta.get("guidance", 4.5),
        "negative_prompt": meta.get("negative_prompt", ""),
    }


def gpu_preflight() -> None:
    import torch
    if not torch.cuda.is_available():
        sys.exit("ERROR: CUDA not available. This script requires an NVIDIA GPU with CUDA support.")
    print(f"Device : {torch.cuda.get_device_name(0)}")
    free_gb = torch.cuda.mem_get_info(0)[0] / 1024**3
    total_gb = torch.cuda.mem_get_info(0)[1] / 1024**3
    print(f"VRAM   : {free_gb:.1f} GB free / {total_gb:.1f} GB total")
    if free_gb < 10:
        print(f"WARNING: Only {free_gb:.1f} GB free VRAM — recommend ≥10 GB for Flux2-klein int8.")
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,process_name", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        procs = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if procs:
            print(f"WARNING: {len(procs)} GPU process(es) already running — VRAM may be constrained:")
            for p in procs:
                print(f"  {p}")
    except Exception:
        pass


def load_pipeline():
    import torch
    from diffusers import Flux2KleinPipeline
    from optimum.quanto import freeze, quantize, qint8
    print(f"\nLoading {MODEL_ID}...")
    pipe = Flux2KleinPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
    print("Quantizing transformer to int8...")
    quantize(pipe.transformer, weights=qint8)
    freeze(pipe.transformer)
    pipe.to("cuda")
    torch.set_float32_matmul_precision("high")
    pipe.vae.enable_tiling()
    pipe.vae.enable_slicing()
    free_gb = torch.cuda.mem_get_info(0)[0] / 1024**3
    used_gb = (torch.cuda.mem_get_info(0)[1] - torch.cuda.mem_get_info(0)[0]) / 1024**3
    print(f"VRAM after load: {used_gb:.1f} GB used, {free_gb:.1f} GB free")
    print("Pipeline ready.\n")
    return pipe


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch image generation from .md prompt files using Flux2-klein."
    )
    parser.add_argument("prompts_dir", type=Path, help="Directory containing .md prompt files")
    parser.add_argument("--output-dir", type=Path, required=True, help="Directory for output PNGs")
    parser.add_argument("--steps", type=int, default=None, help="Inference steps (overrides frontmatter)")
    parser.add_argument("--width", type=int, default=None, help="Output width px (overrides frontmatter)")
    parser.add_argument("--height", type=int, default=None, help="Output height px (overrides frontmatter)")
    args = parser.parse_args()

    if not args.prompts_dir.is_dir():
        sys.exit(f"ERROR: prompts_dir not found: {args.prompts_dir}")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    gpu_preflight()

    files = sorted(args.prompts_dir.glob("*.md"))
    if not files:
        sys.exit(f"No .md files found in {args.prompts_dir}")
    print(f"Found {len(files)} prompt(s) in {args.prompts_dir}\n")

    pipe = None
    succeeded, failed, failed_names = 0, 0, []
    try:
        pipe = load_pipeline()
        for i, f in enumerate(files):
            name = f.stem
            out_path = args.output_dir / f"{name}.png"
            prefix = f"[{i+1}/{len(files)}] {name}"
            if out_path.exists():
                print(f"{prefix} — SKIP (exists)")
                succeeded += 1
                continue
            print(f"{prefix} — generating...", end=" ", flush=True)
            try:
                t0 = time.time()
                spec = parse_prompt_file(f, args)
                image = pipe(
                    prompt=spec["prompt"],
                    width=spec["width"],
                    height=spec["height"],
                    num_inference_steps=spec["steps"],
                    guidance_scale=spec["guidance"],
                ).images[0]
                image.save(out_path)
                print(f"OK ({time.time() - t0:.0f}s) → {out_path.name}")
                succeeded += 1
            except Exception as exc:
                print(f"FAILED: {exc}")
                failed += 1
                failed_names.append(name)
    finally:
        if pipe is not None:
            del pipe
        import torch
        torch.cuda.empty_cache()
        gc.collect()

    print(f"\nDone: {succeeded} succeeded, {failed} failed")
    if failed_names:
        print("Failed:", ", ".join(failed_names))
    print(f"Output: {args.output_dir}")


if __name__ == "__main__":
    main()
