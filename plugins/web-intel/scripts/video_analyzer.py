#!/usr/bin/env python3
"""
Video frame analysis pipeline.

Downloads a video, extracts frames at 1fps, and batch-describes each frame
using a local VLM via Ollama.

Usage:
    uv run python scripts/video_analyzer.py <youtube_url>
    uv run python scripts/video_analyzer.py <youtube_url> --fps 0.5
    uv run python scripts/video_analyzer.py <youtube_url> --model qwen3-vl:8b
    uv run python scripts/video_analyzer.py <youtube_url> --output /tmp/analysis.json

Pipeline:
    1. Scrape metadata + transcript (via existing web-intel scraper)
    2. Download video (yt-dlp, 1080p max)
    3. Extract frames (ffmpeg, 1fps default)
    4. Auto-detect best local VLM (GPU VRAM → model selection)
    5. Batch-describe frames via Ollama API
    6. Output combined JSON: metadata + transcript + frame descriptions

Dependencies:
    - yt-dlp (video download)
    - ffmpeg (frame extraction)
    - ollama (local VLM inference)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

# Ensure local imports work
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from gpu_detector import detect_gpu, detect_ollama, select_best_model, list_pulled_vision_models

# SSL cert path for yt-dlp on Linux
SSL_CERT = "/etc/ssl/certs/ca-certificates.crt"

# Frame description prompt — extracts component-relevant visual properties.
# NOTE: qwen3-vl routes vision output to the `thinking` field instead of
# `content` (Ollama bug #14716). We use /api/chat + read from `thinking`
# when `content` is empty. The `think: false` param has no effect on vision.
FRAME_PROMPT = (
    "Describe this video frame for recreating it as a React component. "
    "Include: scene type (3d_scene, 2d_graphics, text_card, illustration, mixed), "
    "main objects with positions, background type and colors, "
    "color palette (3-5 colors), on-screen text verbatim, "
    "visual effects (chromatic_aberration, glow, blur, fog, none), "
    "what appears animated, and suggest a React component name."
)


def check_dependencies() -> dict[str, Any]:
    """Check that yt-dlp, ffmpeg, and ollama are available."""
    deps = {}
    for cmd in ("yt-dlp", "ffmpeg", "ollama"):
        path = shutil.which(cmd)
        deps[cmd] = {"available": bool(path), "path": path}
    return deps


def download_video(url: str, output_dir: str, max_height: int = 1080) -> dict[str, Any]:
    """Download video via yt-dlp. Returns path to downloaded file."""
    output_path = os.path.join(output_dir, "video.mp4")

    env = os.environ.copy()
    if os.path.exists(SSL_CERT):
        env["SSL_CERT_FILE"] = SSL_CERT

    cmd = [
        "yt-dlp",
        "-f", f"bestvideo[height<={max_height}][ext=mp4]+bestaudio[ext=m4a]/best[height<={max_height}][ext=mp4]/best",
        "-o", output_path,
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        url,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=env)
        if result.returncode != 0:
            return {"success": False, "error": f"yt-dlp failed: {result.stderr.strip()}"}
        if not os.path.exists(output_path):
            return {"success": False, "error": "Video file not created"}
        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        return {"success": True, "path": output_path, "size_mb": round(size_mb, 1)}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Download timed out (5 min limit)"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _get_video_duration(video_path: str) -> Optional[float]:
    """Get video duration in seconds via ffprobe."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, timeout=10,
        )
        return float(result.stdout.strip())
    except Exception:
        return None


def _extract_scene_frames(
    video_path: str,
    frames_dir: str,
    scene_threshold: float = 0.2,
    scale_height: int = 480,
    max_frames: int = 150,
) -> dict[str, Any]:
    """Extract frames at scene changes + downscale for faster VLM inference.

    Auto-tunes the scene threshold to keep frames within budget, then fills
    gaps between scene changes with interval frames at an adaptive rate.
    """
    import re

    try:
        # Step 1: Auto-tune scene threshold to stay within max_frames
        threshold = scene_threshold
        timestamps: list[float] = []

        for _ in range(5):
            detect_cmd = [
                "ffmpeg", "-i", video_path,
                "-vf", f"select='gt(scene,{threshold})',showinfo",
                "-vsync", "0", "-loglevel", "info", "-f", "null", "-",
            ]
            detect_result = subprocess.run(
                detect_cmd, capture_output=True, text=True, timeout=300,
            )
            timestamps = [
                float(m.group(1))
                for line in detect_result.stderr.splitlines()
                if (m := re.search(r"pts_time:\s*([\d.]+)", line))
            ]
            if len(timestamps) <= max_frames:
                break
            threshold = min(threshold + 0.1, 0.8)

        scene_threshold = threshold

        # Step 2: Extract scene-change frames at final threshold
        scene_cmd = [
            "ffmpeg", "-i", video_path,
            "-vf", f"select='gt(scene,{scene_threshold})',scale=-2:{scale_height}",
            "-vsync", "0", "-q:v", "3", "-loglevel", "error",
            os.path.join(frames_dir, "scene_%04d.jpg"),
        ]
        subprocess.run(scene_cmd, capture_output=True, text=True, timeout=300)
        scene_frames = sorted(Path(frames_dir).glob("scene_*.jpg"))

        # Step 3: Compute adaptive gap-fill interval
        duration = _get_video_duration(video_path)
        remaining_budget = max(max_frames - len(scene_frames), 0)

        if remaining_budget > 0 and duration and duration > 0:
            scene_times = sorted(timestamps)
            boundaries = [0.0] + scene_times + [duration]
            total_gap = sum(
                max(b - a - 3, 0)
                for a, b in zip(boundaries[:-1], boundaries[1:])
            )
            gap_interval = max(total_gap / remaining_budget, 3) if remaining_budget > 0 else 999
        else:
            gap_interval = 10

        gap_fps = 1.0 / gap_interval

        # Step 4: Extract gap-fill frames
        fps_cmd = [
            "ffmpeg", "-i", video_path,
            "-vf", f"fps={gap_fps},scale=-2:{scale_height}",
            "-q:v", "3", "-loglevel", "error",
            os.path.join(frames_dir, "fps_%04d.jpg"),
        ]
        subprocess.run(fps_cmd, capture_output=True, text=True, timeout=300)
        fps_frames = sorted(Path(frames_dir).glob("fps_*.jpg"))

        # Step 5: Merge scene + gap-fill frames
        merged: list[dict[str, Any]] = []

        for frame, ts in zip(scene_frames, timestamps):
            merged.append({"path": str(frame), "second": ts, "type": "scene_change"})

        for i, frame in enumerate(fps_frames):
            second = float(i) * gap_interval
            if not any(abs(second - st) < 2 for st in timestamps):
                merged.append({"path": str(frame), "second": second, "type": "interval"})

        merged.sort(key=lambda x: x["second"])

        # Fix #1: Enforce total frame cap — evenly sample if over budget
        if len(merged) > max_frames:
            step = len(merged) / max_frames
            merged = [merged[int(i * step)] for i in range(max_frames)]

        if not merged:
            return {"success": False, "error": "No frames extracted"}

        return {
            "success": True,
            "frames_dir": frames_dir,
            "frame_count": len(merged),
            "scene_frames": len(scene_frames),
            "interval_frames": len(merged) - len(scene_frames),
            "mode": "scene_detection",
            "scene_threshold": scene_threshold,
            "scale_height": scale_height,
            "frames": merged,
            "frame_paths": [f["path"] for f in merged],
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Frame extraction timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def extract_frames(
    video_path: str,
    output_dir: str,
    fps: float = 1.0,
    scene_detection: bool = True,
    scene_threshold: float = 0.2,
    scale_height: int = 480,
) -> dict[str, Any]:
    """Extract frames from video.

    Two modes:
    - scene_detection=True (default): Smart extraction — scene changes +
      1fps floor, downscaled to 480p. Typically 5-10x fewer frames.
    - scene_detection=False: Uniform extraction at given FPS, full resolution.
    """
    frames_dir = os.path.join(output_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    if scene_detection:
        return _extract_scene_frames(
            video_path, frames_dir, scene_threshold, scale_height,
        )

    # Legacy: uniform FPS extraction
    cmd = [
        "ffmpeg",
        "-i", video_path,
        "-vf", f"fps={fps},scale=-2:{scale_height}",
        "-q:v", "3",
        "-loglevel", "error",
        os.path.join(frames_dir, "frame_%04d.jpg"),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            return {"success": False, "error": f"ffmpeg failed: {result.stderr.strip()}"}

        frames = sorted(Path(frames_dir).glob("frame_*.jpg"))
        if not frames:
            return {"success": False, "error": "No frames extracted"}

        return {
            "success": True,
            "frames_dir": frames_dir,
            "frame_count": len(frames),
            "fps": fps,
            "mode": "uniform",
            "scale_height": scale_height,
            "frame_paths": [str(f) for f in frames],
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Frame extraction timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def ensure_model_pulled(model: str) -> dict[str, Any]:
    """Pull an Ollama model if not already available."""
    ollama = detect_ollama()
    if not ollama["available"]:
        return {"success": False, "error": "Ollama not available"}

    if model in ollama.get("models", []):
        return {"success": True, "already_pulled": True}

    # Check if base name matches (e.g. "qwen3-vl:4b" matches "qwen3-vl:4b-fp16")
    base = model.split(":")[0]
    for m in ollama.get("models", []):
        if m.startswith(base + ":"):
            return {"success": True, "already_pulled": True, "matched": m}

    print(f"Pulling {model}...", file=sys.stderr)
    try:
        result = subprocess.run(
            ["ollama", "pull", model],
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.returncode != 0:
            return {"success": False, "error": f"Pull failed: {result.stderr.strip()}"}
        return {"success": True, "already_pulled": False}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Model pull timed out (10 min)"}


def _strip_thinking_preamble(text: str) -> str:
    """Remove LLM thinking preamble from descriptions.

    qwen3-vl often starts with 'Got it, let's break down...' or
    'Okay, let me analyze...' before the actual description.
    """
    import re
    # Strip common thinking prefixes up to the first actual content line
    text = re.sub(
        r"^(?:Got it|Okay|Alright|Let me|Sure|I'll)[^.\n]*\.\s*",
        "", text, count=1,
    )
    # Strip "Wait, ..." false starts
    text = re.sub(r"Wait,\s+[^.]*\.\s*", "", text)
    return text.strip()


def describe_frame_ollama(image_path: str, model: str, prompt: str = FRAME_PROMPT) -> dict[str, Any]:
    """Describe a single frame using Ollama's vision API.

    Uses /api/chat endpoint. Due to Ollama bug #14716, qwen3-vl routes
    vision output to the `thinking` field instead of `content`. We read
    from both and use whichever has content.
    """
    with open(image_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("utf-8")

    payload = json.dumps({
        "model": model,
        "messages": [{
            "role": "user",
            "content": prompt,
            "images": [image_b64],
        }],
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_predict": 400,
        },
    }).encode("utf-8")

    req = urllib.request.Request(
        "http://localhost:11434/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            msg = data.get("message", {})
            # Workaround for Ollama #14716: vision output may land in
            # the `thinking` field instead of `content`
            content = msg.get("content", "").strip()
            thinking = msg.get("thinking", "").strip()
            description = _strip_thinking_preamble(content or thinking)
            return {
                "success": bool(description),
                "description": description,
                "source_field": "content" if content else "thinking",
                "eval_duration_ms": data.get("eval_duration", 0) // 1_000_000,
            }
    except urllib.error.URLError as e:
        return {"success": False, "error": f"Ollama API error: {e}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def batch_describe_frames(
    frame_paths: list[str],
    model: str,
    prompt: str = FRAME_PROMPT,
    progress: bool = True,
    frame_metadata: Optional[list[dict[str, Any]]] = None,
    checkpoint_path: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Batch-describe all frames. Returns list of {frame, second, description}.

    Args:
        frame_paths: List of frame image paths.
        model: Ollama model name.
        prompt: VLM prompt.
        progress: Show progress bar on stderr.
        frame_metadata: Optional list of dicts with 'second' and 'type' keys
            from scene detection. If None, assumes uniform 1fps.
        checkpoint_path: If set, save progress after each frame and resume
            from last checkpoint on restart.
    """
    # Resume from checkpoint if available
    results: list[dict[str, Any]] = []
    start_from = 0
    if checkpoint_path and os.path.exists(checkpoint_path):
        try:
            with open(checkpoint_path) as f:
                results = json.load(f)
            start_from = len(results)
            print(f"  Resuming from frame {start_from}/{len(frame_paths)}", file=sys.stderr)
        except (json.JSONDecodeError, KeyError):
            results = []

    total = len(frame_paths)
    start_time = time.time()

    for i in range(start_from, total):
        path = frame_paths[i]
        # Get timestamp from metadata or infer from filename
        if frame_metadata and i < len(frame_metadata):
            second = frame_metadata[i].get("second", i)
            frame_type = frame_metadata[i].get("type", "unknown")
        else:
            frame_num = int(Path(path).stem.split("_")[1])
            second = frame_num - 1
            frame_type = "uniform"

        second_int = int(second)
        result = describe_frame_ollama(path, model, prompt)

        entry = {
            "frame": i + 1,
            "second": second,
            "timestamp": f"{second_int // 60}:{second_int % 60:02d}",
            "type": frame_type,
            "path": path,
        }

        if result["success"]:
            entry["description"] = result["description"]
            entry["inference_ms"] = result.get("eval_duration_ms", 0)
        else:
            entry["description"] = None
            entry["error"] = result["error"]

        results.append(entry)

        # Save checkpoint after each frame
        if checkpoint_path:
            with open(checkpoint_path, "w") as f:
                json.dump(results, f, ensure_ascii=False)

        if progress:
            elapsed = time.time() - start_time
            done_this_run = i - start_from + 1
            rate = done_this_run / elapsed if elapsed > 0 else 0
            eta = (total - i - 1) / rate if rate > 0 else 0
            print(
                f"\r  [{i+1}/{total}] {entry['timestamp']} "
                f"({rate:.1f} frames/s, ETA {int(eta)}s)",
                end="",
                file=sys.stderr,
            )

    if progress:
        elapsed = time.time() - start_time
        print(f"\n  Done: {total} frames in {elapsed:.0f}s", file=sys.stderr)

    # Clean up checkpoint on success
    if checkpoint_path and os.path.exists(checkpoint_path):
        os.remove(checkpoint_path)

    return results


def analyze_video(
    url: str,
    fps: float = 1.0,
    model: Optional[str] = None,
    output_path: Optional[str] = None,
    keep_frames: bool = False,
    scene_detection: bool = True,
    scene_threshold: float = 0.2,
) -> dict[str, Any]:
    """Full video analysis pipeline.

    Args:
        url: YouTube URL
        fps: Frames per second to extract (when scene_detection=False)
        model: Ollama model override (auto-detects if None)
        output_path: Where to save JSON output (prints to stdout if None)
        keep_frames: Keep extracted frames after analysis
        scene_detection: Use smart scene-change detection (default: True)
        scene_threshold: Scene change sensitivity 0-1 (default: 0.3)

    Returns:
        Combined analysis dict with metadata, transcript, and frame descriptions.
    """
    result: dict[str, Any] = {
        "url": url,
        "pipeline": "web-intel/video-analyzer",
    }

    # --- Step 1: Check dependencies ---
    print("Step 1/6: Checking dependencies...", file=sys.stderr)
    deps = check_dependencies()
    missing = [k for k, v in deps.items() if not v["available"]]
    if missing:
        result["success"] = False
        result["error"] = f"Missing dependencies: {', '.join(missing)}"
        return result

    # --- Step 2: Scrape metadata + transcript ---
    print("Step 2/6: Scraping metadata + transcript...", file=sys.stderr)
    try:
        from scraper import scrape_content
        scrape_result = scrape_content(url)
        if scrape_result.get("success"):
            result["metadata"] = scrape_result.get("data", {})
            result["content_type"] = scrape_result.get("content_type", "unknown")
        else:
            result["metadata"] = {"error": scrape_result.get("error", "Scrape failed")}
    except Exception as e:
        result["metadata"] = {"error": str(e)}

    # --- Step 3: Auto-select model ---
    print("Step 3/6: Detecting GPU + selecting model...", file=sys.stderr)
    if model:
        selected_model = model
    else:
        gpu = detect_gpu()
        if not gpu["available"]:
            result["success"] = False
            result["error"] = f"No GPU detected: {gpu.get('error')}"
            return result

        ollama = detect_ollama()
        pulled = list_pulled_vision_models(ollama.get("models", []))
        loaded = ollama.get("loaded_models", [])
        selection = select_best_model(gpu["free_mb"], pulled, loaded)

        if not selection.get("model"):
            result["success"] = False
            result["error"] = selection.get("error", "No suitable model")
            return result

        selected_model = selection["model"]
        result["model_selection"] = selection

    print(f"  Using: {selected_model}", file=sys.stderr)

    # --- Step 4: Ensure model is pulled ---
    print("Step 4/6: Ensuring model is available...", file=sys.stderr)
    pull_result = ensure_model_pulled(selected_model)
    if not pull_result["success"]:
        result["success"] = False
        result["error"] = f"Model pull failed: {pull_result['error']}"
        return result

    # --- Step 5: Download + extract frames ---
    work_dir = tempfile.mkdtemp(prefix="video_analysis_")
    result["work_dir"] = work_dir

    print("Step 5/6: Downloading video + extracting frames...", file=sys.stderr)
    dl = download_video(url, work_dir)
    if not dl["success"]:
        result["success"] = False
        result["error"] = f"Download failed: {dl['error']}"
        return result
    result["download"] = {"size_mb": dl["size_mb"]}

    extraction = extract_frames(
        dl["path"], work_dir,
        fps=fps,
        scene_detection=scene_detection,
        scene_threshold=scene_threshold,
    )
    if not extraction["success"]:
        result["success"] = False
        result["error"] = f"Frame extraction failed: {extraction['error']}"
        return result
    result["extraction"] = {
        "frame_count": extraction["frame_count"],
        "mode": extraction.get("mode", "unknown"),
        "scene_frames": extraction.get("scene_frames"),
        "interval_frames": extraction.get("interval_frames"),
    }
    print(f"  Extracted {extraction['frame_count']} frames ({extraction.get('mode')})", file=sys.stderr)

    # --- Step 6: Batch describe frames ---
    print(f"Step 6/6: Describing {extraction['frame_count']} frames with {selected_model}...", file=sys.stderr)
    checkpoint = os.path.join(work_dir, "checkpoint.json") if work_dir else None
    descriptions = batch_describe_frames(
        extraction["frame_paths"],
        selected_model,
        frame_metadata=extraction.get("frames"),
        checkpoint_path=checkpoint,
    )

    result["success"] = True
    result["model"] = selected_model
    result["frame_descriptions"] = descriptions

    # Summary stats
    successful = [d for d in descriptions if d.get("description")]
    failed = [d for d in descriptions if not d.get("description")]
    avg_ms = (
        sum(d.get("inference_ms", 0) for d in successful) / len(successful)
        if successful
        else 0
    )
    result["stats"] = {
        "total_frames": len(descriptions),
        "described": len(successful),
        "failed": len(failed),
        "avg_inference_ms": round(avg_ms),
    }

    # Cleanup
    if not keep_frames:
        # Remove video file (large), keep frames dir for reference
        video_file = os.path.join(work_dir, "video.mp4")
        if os.path.exists(video_file):
            os.remove(video_file)

    # Save output
    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"\nOutput saved to: {output_path}", file=sys.stderr)

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Analyze a YouTube video: metadata + transcript + frame-by-frame visual descriptions",
    )
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--fps", type=float, default=1.0, help="Frames per second (when --no-scene-detection, default: 1)")
    parser.add_argument("--model", help="Ollama model override (auto-detects if omitted)")
    parser.add_argument("--output", "-o", help="Output JSON path (prints to stdout if omitted)")
    parser.add_argument("--keep-frames", action="store_true", help="Keep extracted frame files")
    parser.add_argument("--no-scene-detection", action="store_true", help="Disable scene detection, use uniform FPS instead")
    parser.add_argument("--scene-threshold", type=float, default=0.2, help="Scene change sensitivity 0-1 (default: 0.2, lower=more frames)")

    args = parser.parse_args()

    result = analyze_video(
        url=args.url,
        fps=args.fps,
        model=args.model,
        output_path=args.output,
        keep_frames=args.keep_frames,
        scene_detection=not args.no_scene_detection,
        scene_threshold=args.scene_threshold,
    )

    if not args.output:
        print(json.dumps(result, indent=2, ensure_ascii=False))

    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
