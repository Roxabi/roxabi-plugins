#!/usr/bin/env bash
set -euo pipefail
# R2: skills/ or commands/ changed without a version bump -> block.
# Two independent surfaces, same trigger (plugins/<p>/skills/** and commands/**):
#   Claude: plugins/<p>/.claude-plugin/plugin.json .version
#   OMP:    .omp-plugin/marketplace.json plugins[].version — the cache key
#           (<marketplace>___<plugin>___<version>). Not package.json, not
#           plugins/<p>/.omp-plugin/plugin.json, not the catalogue document version.
# A missing version on one surface is a visible SKIP and does not hide the other.
# Constraints (documented): plugin rename may not fire on the renaming push;
# commands/ dir is forward-compatible (absent today); requires fetched origin/main.
# Preflight: jq absence skips only the Claude plugin.json branch. The OMP
# catalogue check always runs. A failed fetch with a local origin/main is not
# a proven baseline, so the catalogue comparison is unverified and exits 1.
# origin/main missing entirely stays a visible SKIP (nothing to compare).
export GIT_TERMINAL_PROMPT=0
have_jq=0
command -v jq >/dev/null 2>&1 && have_jq=1
fetch_ok=0
if timeout 30 git fetch origin main --quiet; then
  fetch_ok=1
fi
if ! git rev-parse --verify --quiet origin/main >/dev/null; then
  echo "SKIP: check-skill-version (origin/main unreachable — cannot compare versions)" >&2
  exit 0
fi
if [ "$fetch_ok" -ne 1 ]; then
  echo "cannot verify origin/main:.omp-plugin/marketplace.json — fetch failed"
  exit 1
fi
changed=$(git diff --name-only origin/main...HEAD -- 'plugins/*/skills/**' 'plugins/*/commands/**')
mapfile -t plugins < <(printf '%s\n' "$changed" | sed -nE 's#^plugins/([^/]+)/.*#\1#p' | sort -u)
fail=0

# ABSENT only when the blob is missing. Stream the bytes into the classifier:
# capturing them in a shell variable strips NUL before Bun.JSON.parse.
omp_row_status() {
  local rev="$1" name="$2" status
  if ! git cat-file -e "${rev}:.omp-plugin/marketplace.json" 2>/dev/null; then
    printf 'ABSENT'
    return 0
  fi
  if ! status=$(git show "${rev}:.omp-plugin/marketplace.json" | OMP_PLUGIN_NAME="$name" bun -e '
const name = process.env.OMP_PLUGIN_NAME ?? ""
const bytes = new Uint8Array(await new Response(Bun.stdin).arrayBuffer())
const emit = (code) => {
  console.log(code)
  process.exit(0)
}
const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
if (raw.includes("\u0000") || raw.charCodeAt(0) === 0xfeff) emit("PARSE")
let doc
try {
  doc = JSON.parse(raw)
} catch {
  emit("PARSE")
}
if (doc === null || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.plugins)) {
  emit("PARSE")
}
const want = name.toLowerCase()
const rows = doc.plugins.filter(
  (row) =>
    row &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    String(row.name ?? "").toLowerCase() === want,
)
if (rows.length > 1) emit("DUPLICATE")
if (rows.length === 0) emit("MISSING")
const version = rows[0].version
if (version === undefined || version === null) emit("MISSING")
if (typeof version !== "string" || version.length === 0 || /[\r\n]/.test(version)) emit("BAD")
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
if (!semver.test(version)) emit("BAD")
emit("VERSION:" + version)
'); then
    printf 'PARSE'
    return 0
  fi
  case "$status" in
    PARSE | DUPLICATE | MISSING | BAD | VERSION:*) printf '%s' "$status" ;;
    *) printf 'PARSE' ;;
  esac
}

# Exit 0 only when OMP would install head over base. A throw, or order <= 0, fails.
omp_is_upgrade() {
  local head="$1" base="$2"
  OMP_HEAD_VER="$head" OMP_BASE_VER="$base" bun -e '
const head = process.env.OMP_HEAD_VER
const base = process.env.OMP_BASE_VER
let order
try {
  order = Bun.semver.order(head, base)
} catch {
  process.exit(1)
}
if (typeof order !== "number" || !(order > 0)) process.exit(1)
'
}

omp_fail() {
  echo "$1: $2 — bump .omp-plugin/marketplace.json"
  fail=1
}

for p in "${plugins[@]}"; do
  [ -n "$p" ] || continue
  pj="plugins/$p/.claude-plugin/plugin.json"
  if [ "$have_jq" -ne 1 ]; then
    echo "SKIP: $p Claude plugin.json check needs jq (not found) — OMP catalogue check still runs" >&2
  elif [ ! -f "$pj" ]; then
    echo "SKIP: $p has no .claude-plugin/plugin.json — no version gate" >&2
  else
    cur=$(jq -r '.version // empty' "$pj" 2>/dev/null || true)
    if [ -z "$cur" ]; then
      echo "SKIP: $p is SHA-based (no .version in $pj) — bump gate inert for this plugin" >&2
    else
      base=$(git show "origin/main:$pj" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
      if [ "$base" = "$cur" ]; then
        echo "$p: skills/commands changed without version bump (still $cur) — bump $pj"
        fail=1
      fi
    fi
  fi

  # OMP cache key is the catalogue row of the commit being pushed,
  # not the worktree file and not the document version.
  cur_status=$(omp_row_status HEAD "$p")
  case "$cur_status" in
    PARSE) omp_fail "$p" "cannot parse .omp-plugin/marketplace.json" ;;
    DUPLICATE) omp_fail "$p" "duplicate plugins[] rows in .omp-plugin/marketplace.json" ;;
    BAD) omp_fail "$p" "catalogue version is not a single-line semver in .omp-plugin/marketplace.json" ;;
    ABSENT | MISSING)
      echo "SKIP: $p has no version in .omp-plugin/marketplace.json — OMP bump gate inert for this plugin" >&2
      ;;
    VERSION:*)
      cur_omp="${cur_status#VERSION:}"
      base_status=$(omp_row_status origin/main "$p")
      case "$base_status" in
        PARSE) omp_fail "$p" "cannot parse origin/main:.omp-plugin/marketplace.json" ;;
        DUPLICATE) omp_fail "$p" "duplicate plugins[] rows in origin/main:.omp-plugin/marketplace.json" ;;
        BAD) omp_fail "$p" "origin/main catalogue version is not a single-line semver in .omp-plugin/marketplace.json" ;;
        ABSENT | MISSING) ;;
        VERSION:*)
          base_omp="${base_status#VERSION:}"
          if [ "$base_omp" = "$cur_omp" ]; then
            echo "$p: skills/commands changed without version bump (still $cur_omp) — bump .omp-plugin/marketplace.json"
            fail=1
          elif ! omp_is_upgrade "$cur_omp" "$base_omp"; then
            omp_fail "$p" "catalogue version is not a newer semver OMP will install in .omp-plugin/marketplace.json"
          fi
          ;;
        *) omp_fail "$p" "cannot parse origin/main:.omp-plugin/marketplace.json" ;;
      esac
      ;;
    *) omp_fail "$p" "cannot parse .omp-plugin/marketplace.json" ;;
  esac
done
[ "$fail" -eq 0 ]
