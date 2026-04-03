#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""IDNA bulk encoder — encode all pending node prompts in one GPU pass.

Usage:
    uv run --project ~/projects/imageCLI python idna_encode_all.py <session_dir>

Loads the Qwen3 text encoder ONCE, encodes every node that has a job file
but no .pt embed file, writes embeds, then updates node status to 'encoded'.

This is an optional acceleration step before starting idna_server.py.
The server's generation worker handles encoding per-round if skipped,
but running this first avoids reloading the text encoder for each round.

Reads:  round_N/prompts/<id>.json   (job files written by idna_build_tree.py)
Writes: round_N/embeds/<id>.pt      (text embeddings)
        session.json                (node status: pending -> encoded)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def encode_all(session_dir: Path) -> None:
    session_file = session_dir / "session.json"
    if not session_file.exists():
        print(f"ERROR: session.json not found at {session_file}", file=sys.stderr)
        sys.exit(1)

    session = json.loads(session_file.read_text())
    if "nodes" not in session:
        print("ERROR: session uses legacy format — run idna_build_tree.py first", file=sys.stderr)
        sys.exit(1)

    nodes: dict = session["nodes"]

    # Collect all nodes that have a job file but no embed yet
    pending: list[dict] = []
    for node in nodes.values():
        round_num = node["round"]
        job_file = session_dir / f"round_{round_num}" / "prompts" / f"{node['id']}.json"
        embed_file = session_dir / f"round_{round_num}" / "embeds" / f"{node['id']}.pt"
        if job_file.exists() and not embed_file.exists():
            job = json.loads(job_file.read_text())
            pending.append({
                "id": node["id"],
                "round": round_num,
                "prompt": job.get("prompt", node.get("prompt", "")),
                "embed_path": embed_file,
            })

    if not pending:
        print("All nodes already encoded — nothing to do.")
        return

    print(f"Encoding {len(pending)} nodes (text encoder only, Qwen3)...")

    # Lazy import — only available when run via uv run --project imageCLI
    try:
        import gc
        import torch
        from diffusers import Flux2KleinPipeline
    except ImportError as e:
        print(f"ERROR: missing dependency ({e})", file=sys.stderr)
        print("Run with: uv run --project ~/projects/imageCLI python idna_encode_all.py <session_dir>", file=sys.stderr)
        sys.exit(1)

    MODEL = "black-forest-labs/FLUX.2-klein-4B"

    def vram() -> str:
        used = torch.cuda.memory_allocated() / 1e9
        total = torch.cuda.get_device_properties(0).total_memory / 1e9
        return f"{used:.1f}/{total:.1f} GB"

    # Update gen_status to encoding
    session["gen_status"] = "encoding"
    session_file.write_text(json.dumps(session, indent=2))

    pipe = Flux2KleinPipeline.from_pretrained(
        MODEL, transformer=None, vae=None, torch_dtype=torch.bfloat16
    )
    pipe.text_encoder.to("cuda")
    print(f"Text encoder on GPU  VRAM: {vram()}")

    t0 = time.time()
    encoded_ids: list[str] = []

    for i, item in enumerate(pending):
        embed_path: Path = item["embed_path"]
        embed_path.parent.mkdir(parents=True, exist_ok=True)

        with torch.no_grad():
            prompt_embeds, text_ids = pipe.encode_prompt(prompt=item["prompt"])

        torch.save(
            {
                "prompt_embeds": prompt_embeds.cpu(),
                "text_ids": text_ids.cpu() if text_ids is not None else None,
            },
            embed_path,
        )
        encoded_ids.append(item["id"])
        elapsed = time.time() - t0
        print(f"  [{i+1}/{len(pending)}] {item['id']}  {elapsed:.0f}s elapsed  VRAM: {vram()}")

    del pipe
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()

    total_time = time.time() - t0
    print(f"\nEncoded {len(encoded_ids)} nodes in {total_time:.0f}s")

    # Update node statuses
    session = json.loads(session_file.read_text())  # re-read in case server modified it
    for nid in encoded_ids:
        if nid in session["nodes"]:
            session["nodes"][nid]["status"] = "encoded"

    # Only update gen_status if still encoding (server may have moved it to 'generating')
    if session.get("gen_status") == "encoding":
        session["gen_status"] = "generating"

    session_file.write_text(json.dumps(session, indent=2))
    print(f"Updated session.json — {len(encoded_ids)} nodes marked 'encoded'")
    print(f"gen_status: {session['gen_status']}")
    print(f"\nStart server to begin image generation:")
    print(f"  uv run idna_server.py")


def main() -> None:
    parser = argparse.ArgumentParser(description="IDNA bulk text encoder")
    parser.add_argument("session_dir", help="Path to session directory (contains session.json)")
    args = parser.parse_args()

    session_dir = Path(args.session_dir).resolve()
    encode_all(session_dir)


if __name__ == "__main__":
    main()
