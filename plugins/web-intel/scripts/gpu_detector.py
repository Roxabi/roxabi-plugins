#!/usr/bin/env python3
"""
GPU and Ollama detection for local VLM inference.

Detects free VRAM, checks Ollama availability, and selects the best
qwen3-vl variant for the current setup.

Usage:
    uv run python scripts/gpu_detector.py          # JSON report
    uv run python scripts/gpu_detector.py --check   # Exit 0 if ready, 1 if not
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from typing import Any, Optional


# Model variants ordered by quality (best first)
VISION_MODELS = [
    {"name": "qwen3-vl:32b", "vram_mb": 20000, "quality": "best"},
    {"name": "qwen3-vl:8b", "vram_mb": 6000, "quality": "high"},
    {"name": "qwen3-vl:4b", "vram_mb": 3500, "quality": "good"},
    {"name": "qwen3-vl:2b", "vram_mb": 2000, "quality": "basic"},
]


def detect_gpu() -> dict[str, Any]:
    """Detect NVIDIA GPU and VRAM status via nvidia-smi."""
    if not shutil.which("nvidia-smi"):
        return {"available": False, "error": "nvidia-smi not found"}

    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.free,memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return {"available": False, "error": f"nvidia-smi failed: {result.stderr.strip()}"}

        line = result.stdout.strip().split("\n")[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            return {"available": False, "error": f"Unexpected nvidia-smi output: {line}"}

        return {
            "available": True,
            "gpu_name": parts[0],
            "total_mb": int(parts[1]),
            "free_mb": int(parts[2]),
            "used_mb": int(parts[3]),
        }
    except Exception as e:
        return {"available": False, "error": str(e)}


def detect_ollama() -> dict[str, Any]:
    """Check if Ollama is installed and running."""
    if not shutil.which("ollama"):
        return {"available": False, "error": "ollama not found. Install: https://ollama.com/"}

    import urllib.request

    result: dict[str, Any] = {"available": True, "models": [], "loaded_models": []}

    # Check if server is reachable and get pulled models
    try:
        req = urllib.request.Request("http://localhost:11434/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            result["models"] = [m["name"] for m in data.get("models", [])]
    except Exception:
        result["warning"] = "Ollama installed but server not responding. Run: ollama serve"
        return result

    # Check which models are currently loaded in VRAM
    try:
        req = urllib.request.Request("http://localhost:11434/api/ps", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            result["loaded_models"] = [m["name"] for m in data.get("models", [])]
    except Exception:
        pass  # /api/ps may not be available in older Ollama versions

    return result


def list_pulled_vision_models(ollama_models: list[str]) -> list[str]:
    """Return which vision models are already pulled.

    Matches exact name (e.g. 'qwen3-vl:4b') or base name when Ollama
    uses a more specific tag (e.g. 'qwen3-vl:4b-fp16' matches 'qwen3-vl:4b').
    """
    pulled = []
    for vm in VISION_MODELS:
        vm_name = vm["name"]
        vm_base = vm_name.split(":")[0]
        vm_tag = vm_name.split(":")[1] if ":" in vm_name else ""

        for om in ollama_models:
            om_base = om.split(":")[0]
            om_tag = om.split(":")[1] if ":" in om else ""

            if vm_name == om:
                pulled.append(vm_name)
                break
            # Match if base name + tag prefix match (e.g. "4b" in "4b-fp16")
            if vm_base == om_base and om_tag.startswith(vm_tag):
                pulled.append(vm_name)
                break

    return pulled


def select_best_model(
    free_vram_mb: int,
    pulled_models: Optional[list[str]] = None,
    loaded_models: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Select the best qwen3-vl variant that fits in available VRAM.

    If a model is already loaded in Ollama VRAM, it's usable immediately
    regardless of free VRAM (its memory is already allocated).
    Prefers already-pulled models when multiple fit.
    """
    pulled = set(pulled_models or [])
    loaded = set(loaded_models or [])

    # Priority 1: model already loaded in VRAM — no extra memory needed
    for model in VISION_MODELS:
        if model["name"] in loaded:
            return {
                "model": model["name"],
                "quality": model["quality"],
                "vram_required_mb": 0,
                "free_vram_mb": free_vram_mb,
                "already_pulled": True,
                "already_loaded": True,
            }

    # Priority 2: best already-pulled model that fits in free VRAM
    for model in VISION_MODELS:
        if model["name"] in pulled and model["vram_mb"] <= free_vram_mb:
            return {
                "model": model["name"],
                "quality": model["quality"],
                "vram_required_mb": model["vram_mb"],
                "free_vram_mb": free_vram_mb,
                "already_pulled": True,
                "already_loaded": False,
            }

    # Priority 3: best model that fits (needs pull)
    for model in VISION_MODELS:
        if model["vram_mb"] <= free_vram_mb:
            return {
                "model": model["name"],
                "quality": model["quality"],
                "vram_required_mb": model["vram_mb"],
                "free_vram_mb": free_vram_mb,
                "already_pulled": False,
                "already_loaded": False,
            }

    return {
        "model": None,
        "error": f"No model fits in {free_vram_mb}MB free VRAM (minimum: {VISION_MODELS[-1]['vram_mb']}MB)",
    }


def full_report() -> dict[str, Any]:
    """Full GPU + Ollama + model selection report."""
    gpu = detect_gpu()
    ollama = detect_ollama()

    report: dict[str, Any] = {
        "gpu": gpu,
        "ollama": ollama,
    }

    if gpu["available"] and ollama["available"]:
        pulled = list_pulled_vision_models(ollama.get("models", []))
        loaded = ollama.get("loaded_models", [])
        selection = select_best_model(gpu["free_mb"], pulled, loaded)
        report["vision_models_pulled"] = pulled
        report["vision_models_loaded"] = loaded
        report["selected_model"] = selection
        report["ready"] = selection.get("model") is not None
    else:
        report["ready"] = False
        errors = []
        if not gpu["available"]:
            errors.append(f"GPU: {gpu.get('error', 'unavailable')}")
        if not ollama["available"]:
            errors.append(f"Ollama: {ollama.get('error', 'unavailable')}")
        report["errors"] = errors

    return report


def main() -> int:
    """CLI: print report or check readiness."""
    check_mode = "--check" in sys.argv

    report = full_report()

    if check_mode:
        if report["ready"]:
            model = report["selected_model"]["model"]
            quality = report["selected_model"]["quality"]
            print(f"OK — {model} ({quality} quality)")
            return 0
        else:
            errors = report.get("errors", [])
            if errors:
                print(f"NOT READY — {'; '.join(errors)}")
            else:
                sel = report.get("selected_model", {})
                print(f"NOT READY — {sel.get('error', 'unknown')}")
            return 1

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
