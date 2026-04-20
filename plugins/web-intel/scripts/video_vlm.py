#!/usr/bin/env python3
"""
Video frame VLM analysis — v2 with two-pass classification, VRAM monitoring,
server health check, and detailed telemetry.

Reuses download_video + extract_frames from web-intel/video_analyzer.py.
Talks to a local llama-server via OpenAI /v1/chat/completions.

Pipeline per frame:
  [pass 1: classify]   short prompt → {schema, text, ui, b_roll, mixed}
  [pass 2: describe]   if kind ∈ deep_kinds, run full OCR prompt

Telemetry:
  <work_dir>/telemetry.jsonl      per-frame: kind, pass_1_ms, pass_2_ms, vram_free_mb, prompt_tokens, completion_tokens
  <work_dir>/vram.jsonl           periodic nvidia-smi samples
  <work_dir>/run_report.md        summary with pass split, timing, VRAM peaks
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

WEB_INTEL_SCRIPTS = Path.home() / "projects/roxabi-plugins/plugins/web-intel/scripts"
for p in (WEB_INTEL_SCRIPTS, WEB_INTEL_SCRIPTS / "_shared", WEB_INTEL_SCRIPTS / "fetchers"):
    sys.path.insert(0, str(p))

from video_analyzer import (  # type: ignore  # noqa: E402
    download_video,
    extract_frames,
    _strip_thinking_preamble,
)

# ── Prompts ────────────────────────────────────────────────────────────

CLASSIFY_PROMPT = (
    "Classify this video frame. Output ONE word from this set: "
    "schema, text, ui, b_roll, mixed. Definitions: "
    "schema = architecture/flow/diagram with boxes+arrows; "
    "text = title card, slide with mostly text; "
    "ui = app/software screenshot; "
    "b_roll = generic footage (people, places, objects); "
    "mixed = combination. Answer with just the single word."
)

DEEP_PROMPT = (
    "Analyze this video frame in detail. This is from a product presentation.\n\n"
    "If DIAGRAM/SCHEMA: list every box with its exact on-screen text (OCR verbatim), "
    "every arrow as 'source → target [label]', overall layout "
    "(radial/linear/layered/hub-and-spoke/grid), and color coding.\n"
    "If TEXT-HEAVY: reproduce all text verbatim.\n"
    "If UI: describe layout, visible copy, interactive elements.\n"
    "If MIXED: cover each section.\n"
    "Be exhaustive on information-dense frames. Use short bullet lists."
)

SHORT_PROMPT = (
    "Describe what you see in this video frame in 1 short sentence. "
    "Mention any prominent on-screen text."
)


# ── VRAM monitor ───────────────────────────────────────────────────────

def nvidia_smi_mem() -> dict[str, int]:
    """Return {used_mb, free_mb, total_mb}. Requires nvidia-smi in PATH."""
    try:
        r = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=memory.used,memory.free,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        )
        parts = r.stdout.strip().split(",")
        return {
            "used_mb": int(parts[0].strip()),
            "free_mb": int(parts[1].strip()),
            "total_mb": int(parts[2].strip()),
        }
    except Exception:
        return {"used_mb": -1, "free_mb": -1, "total_mb": -1}


# ── Server health + restart ────────────────────────────────────────────

def server_healthy(base_url: str, timeout: int = 2) -> bool:
    """Ping llama-server /health."""
    try:
        root = base_url.rstrip("/").rsplit("/", 1)[0]  # drop /v1
        req = urllib.request.Request(f"{root}/health", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def restart_server(launcher_path: str) -> bool:
    """Run the bash launcher script. Returns True if server is healthy post-restart."""
    print(f"  ⚠ restarting server via {launcher_path} ...", file=sys.stderr)
    try:
        subprocess.run(["bash", launcher_path], check=True, timeout=60)
    except Exception as e:
        print(f"  ✗ restart failed: {e}", file=sys.stderr)
        return False
    # Wait for health
    for _ in range(20):
        time.sleep(1)
        if server_healthy("http://127.0.0.1:8093/v1"):
            return True
    return False


# ── Frame encoding ─────────────────────────────────────────────────────

def encode_image(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


# ── VLM call ───────────────────────────────────────────────────────────

def call_vlm(
    base_url: str,
    model: str,
    prompt: str,
    image_b64: Optional[str] = None,
    image_b64s: Optional[list[str]] = None,
    max_tokens: int = 600,
    temperature: float = 0.1,
    timeout: int = 180,
) -> dict[str, Any]:
    """Call OpenAI /v1/chat/completions with 1+ images. Returns dict with
    {success, description, prompt_tokens, completion_tokens, elapsed_ms}."""
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    imgs = image_b64s if image_b64s is not None else ([image_b64] if image_b64 else [])
    for b64 in imgs:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })

    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": "Bearer dummy"},
        method="POST",
    )

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
        elapsed_ms = int((time.time() - t0) * 1000)
        choices = data.get("choices", [])
        if not choices:
            return {"success": False, "error": "empty choices", "elapsed_ms": elapsed_ms}
        msg = choices[0].get("message", {})
        raw = msg.get("content") or ""
        raw = raw.strip() if isinstance(raw, str) else ""
        description = _strip_thinking_preamble(raw)
        usage = data.get("usage", {})
        return {
            "success": bool(description),
            "description": description,
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "elapsed_ms": elapsed_ms,
        }
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        return {"success": False, "error": f"HTTP {e.code}: {body}", "elapsed_ms": int((time.time() - t0) * 1000)}
    except urllib.error.URLError as e:
        return {"success": False, "error": f"server unreachable: {e}", "elapsed_ms": -1}
    except Exception as e:
        return {"success": False, "error": str(e), "elapsed_ms": int((time.time() - t0) * 1000)}


# ── Two-pass classifier + deep describer ───────────────────────────────

VALID_KINDS = {"schema", "text", "ui", "b_roll", "mixed"}


def parse_kind(raw: str) -> str:
    """Extract single-word kind from classifier output."""
    if not raw:
        return "unknown"
    t = raw.strip().lower().rstrip(".").rstrip(",").split()
    for tok in t:
        tok = tok.strip(":,.").replace("-", "_")
        if tok in VALID_KINDS:
            return tok
    return "unknown"


# ── Main pipeline ──────────────────────────────────────────────────────

def analyze(
    url: str,
    base_url: str,
    model: str,
    work_dir: str,
    deep_kinds: set[str],
    two_pass: bool,
    scene_threshold: float,
    scale_height: int,
    vram_check_every: int,
    vram_warn_free_mb: int,
    server_restart_script: Optional[str],
) -> dict[str, Any]:
    os.makedirs(work_dir, exist_ok=True)
    result: dict[str, Any] = {
        "url": url,
        "pipeline": "qaya-tools/video_vlm_v2",
        "model": model,
        "config": {
            "two_pass": two_pass,
            "deep_kinds": sorted(deep_kinds),
            "scene_threshold": scene_threshold,
            "scale_height": scale_height,
            "base_url": base_url,
        },
    }

    # --- Step 1: scrape metadata + transcript ---
    print(f"[1/4] Scraping metadata: {url}", file=sys.stderr)
    try:
        from scraper import scrape_content  # type: ignore
        sc = scrape_content(url)
        result["metadata"] = sc.get("data") if sc.get("success") else {"error": sc.get("error")}
    except Exception as e:
        result["metadata"] = {"error": str(e)}

    # --- Step 2: download + extract frames ---
    print(f"[2/4] Downloading + extracting frames @ {scale_height}p", file=sys.stderr)
    dl = download_video(url, work_dir)
    if not dl.get("success"):
        result["success"] = False
        result["error"] = f"download: {dl.get('error')}"
        return result
    result["download"] = {"size_mb": dl["size_mb"]}
    print(f"  download: {dl['size_mb']} MB", file=sys.stderr)

    ext = extract_frames(
        dl["path"], work_dir,
        scene_detection=True,
        scene_threshold=scene_threshold,
        scale_height=scale_height,
    )
    if not ext.get("success"):
        result["success"] = False
        result["error"] = f"extraction: {ext.get('error')}"
        return result
    frames = ext["frame_paths"]
    frames_meta = ext.get("frames", [])
    result["extraction"] = {
        "frame_count": ext["frame_count"],
        "scene_frames": ext.get("scene_frames"),
        "interval_frames": ext.get("interval_frames"),
    }
    print(f"  extracted {len(frames)} frames", file=sys.stderr)

    # --- Step 3: two-pass or single-pass VLM ---
    tele_path = Path(work_dir) / "telemetry.jsonl"
    vram_log_path = Path(work_dir) / "vram.jsonl"
    descriptions: list[dict[str, Any]] = []
    vram_peaks: list[int] = []
    t_all = time.time()

    print(f"[3/4] VLM ({'two-pass' if two_pass else 'single-pass'}, deep={sorted(deep_kinds)})", file=sys.stderr)

    for i, path in enumerate(frames):
        meta = frames_meta[i] if i < len(frames_meta) else {}
        second = meta.get("second", i)
        frame_type = meta.get("type", "unknown")
        ts = f"{int(second) // 60}:{int(second) % 60:02d}"

        # VRAM sample
        if vram_check_every > 0 and i % vram_check_every == 0:
            vram = nvidia_smi_mem()
            vram_peaks.append(vram["used_mb"])
            with open(vram_log_path, "a") as f:
                f.write(json.dumps({"frame": i, "ts": ts, **vram}) + "\n")
            if vram["free_mb"] >= 0 and vram["free_mb"] < vram_warn_free_mb:
                print(f"\n  ⚠ VRAM free={vram['free_mb']}MB < {vram_warn_free_mb}MB", file=sys.stderr)

        # Server health gate
        if not server_healthy(base_url):
            print(f"\n  ✗ server down at frame {i}", file=sys.stderr)
            if server_restart_script and restart_server(server_restart_script):
                print("  ✓ server back up", file=sys.stderr)
            else:
                entry = {"frame": i + 1, "second": second, "timestamp": ts, "path": path,
                         "error": "server dead, no restart"}
                descriptions.append(entry)
                continue

        img_b64 = encode_image(path)

        # Pass 1: classify (or skip if single-pass)
        entry: dict[str, Any] = {
            "frame": i + 1, "second": second, "timestamp": ts,
            "scene_type": frame_type, "path": path,
        }

        if two_pass:
            r1 = call_vlm(base_url, model, CLASSIFY_PROMPT, image_b64=img_b64,
                          max_tokens=30, temperature=0.0)
            kind = parse_kind(r1.get("description", "")) if r1.get("success") else "unknown"
            entry["kind"] = kind
            entry["pass_1_ms"] = r1.get("elapsed_ms", -1)
            entry["pass_1_prompt_tokens"] = r1.get("prompt_tokens")
            entry["pass_1_raw"] = r1.get("description", "")[:80]
        else:
            kind = "force_deep"
            entry["kind"] = kind

        # Pass 2: deep describe (gated)
        if kind in deep_kinds or not two_pass:
            prompt_2 = DEEP_PROMPT
        elif kind in {"b_roll", "ui", "unknown"}:
            prompt_2 = SHORT_PROMPT
        else:
            prompt_2 = DEEP_PROMPT

        r2 = call_vlm(base_url, model, prompt_2, image_b64=img_b64,
                      max_tokens=700 if prompt_2 is DEEP_PROMPT else 120,
                      temperature=0.1)
        entry["prompt_2_type"] = "deep" if prompt_2 is DEEP_PROMPT else "short"
        entry["pass_2_ms"] = r2.get("elapsed_ms", -1)
        entry["pass_2_prompt_tokens"] = r2.get("prompt_tokens")
        entry["pass_2_completion_tokens"] = r2.get("completion_tokens")
        entry["description"] = r2.get("description") if r2.get("success") else None
        if not r2.get("success"):
            entry["error"] = r2.get("error")

        descriptions.append(entry)

        with open(tele_path, "a") as f:
            f.write(json.dumps({k: v for k, v in entry.items() if k != "description"}) + "\n")

        # Progress
        p1 = entry.get("pass_1_ms", 0) or 0
        p2 = entry.get("pass_2_ms", 0) or 0
        total_s = time.time() - t_all
        rate = (i + 1) / total_s if total_s > 0 else 0
        eta = (len(frames) - i - 1) / rate if rate > 0 else 0
        print(
            f"\r  [{i+1}/{len(frames)}] {ts} {kind:8s} p1={p1/1000:.1f}s p2={p2/1000:.1f}s "
            f"({rate:.2f} fr/s, ETA {int(eta)}s)       ",
            end="", file=sys.stderr,
        )

    total_elapsed = time.time() - t_all
    print(f"\n  done in {total_elapsed:.1f}s", file=sys.stderr)

    result["frame_descriptions"] = descriptions

    # --- Step 4: stats + report ---
    by_kind: dict[str, int] = {}
    deep_count = 0
    total_p1_ms = 0
    total_p2_ms = 0
    failed = 0
    for d in descriptions:
        k = d.get("kind", "unknown")
        by_kind[k] = by_kind.get(k, 0) + 1
        if d.get("prompt_2_type") == "deep":
            deep_count += 1
        total_p1_ms += d.get("pass_1_ms", 0) or 0
        total_p2_ms += d.get("pass_2_ms", 0) or 0
        if d.get("error"):
            failed += 1

    result["stats"] = {
        "total_frames": len(descriptions),
        "by_kind": by_kind,
        "deep_analyzed": deep_count,
        "failed": failed,
        "total_pass_1_sec": round(total_p1_ms / 1000, 1),
        "total_pass_2_sec": round(total_p2_ms / 1000, 1),
        "total_elapsed_sec": round(total_elapsed, 1),
        "vram_peak_mb": max(vram_peaks) if vram_peaks else -1,
    }
    result["success"] = True

    # Save final JSON
    out = Path(work_dir) / "analysis.json"
    with open(out, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"  saved: {out}", file=sys.stderr)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--base-url", default="http://127.0.0.1:8093/v1")
    ap.add_argument("--model", default="qwen3-vl")
    ap.add_argument("--work-dir", default=None)
    ap.add_argument("--no-two-pass", action="store_true", help="disable classification pass")
    ap.add_argument("--deep-kinds", default="schema,text,mixed",
                    help="comma-separated kinds to deep-analyze in pass 2")
    ap.add_argument("--scene-threshold", type=float, default=0.2)
    ap.add_argument("--scale-height", type=int, default=720)
    ap.add_argument("--vram-check-every", type=int, default=5)
    ap.add_argument("--vram-warn-free-mb", type=int, default=400)
    ap.add_argument("--server-restart-script", default=None,
                    help="path to bash launcher script (auto-restart on health fail)")
    args = ap.parse_args()

    work_dir = args.work_dir or tempfile.mkdtemp(prefix="video_vlm_")
    deep_kinds = set(k.strip() for k in args.deep_kinds.split(",") if k.strip())

    r = analyze(
        url=args.url,
        base_url=args.base_url,
        model=args.model,
        work_dir=work_dir,
        deep_kinds=deep_kinds,
        two_pass=not args.no_two_pass,
        scene_threshold=args.scene_threshold,
        scale_height=args.scale_height,
        vram_check_every=args.vram_check_every,
        vram_warn_free_mb=args.vram_warn_free_mb,
        server_restart_script=args.server_restart_script,
    )
    sys.exit(0 if r.get("success") else 1)


if __name__ == "__main__":
    main()
