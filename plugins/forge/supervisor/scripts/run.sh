#!/usr/bin/env bash
# Wrapper for forge server — serves $FORGE_DIR (default: ~/.roxabi/forge) on port 8080.
export FORGE_DIR="${FORGE_DIR:-${DIAGRAMS_DIR:-$HOME/.roxabi/forge}}"

exec python3 "$FORGE_DIR/serve.py"
