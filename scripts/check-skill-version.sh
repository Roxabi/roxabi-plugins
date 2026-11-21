#!/usr/bin/env bash
set -euo pipefail
# R2: distributed plugin runtime changed without a version bump -> block.
# Runtime includes every plugin-owned file except source-only tests and docs. This
# covers OMP extensions, hooks, engines, generated outputs, manifests, and skills
# while letting root/CI and plugin documentation changes remain version-neutral.
# Two independent version surfaces:
#   Claude: plugin.json .version, otherwise the Claude catalogue row's version
#   OMP:    .omp-plugin/marketplace.json plugins[].version — the cache key
#           (<marketplace>___<plugin>___<version>). Not package.json, not
#           plugins/<p>/.omp-plugin/plugin.json, not the catalogue document version.
# A missing version on one surface is a visible SKIP and does not hide the other.
# Constraints (documented): plugin rename may not fire on the renaming push;
# requires fetched origin/main, unless CHECK_SKILL_VERSION_BASE names the base.
#
# Plugin root README, docs/, and test/fixture paths intentionally do not trigger a
# bump: they do not change a runtime effect, even if a host copies them. GLOSSARY.md
# is runtime: omp-build pins it as a review input (roxabi/uw-action-plugin-files.ts).
is_distributed_runtime_path() {
  case "$1" in
    plugins/*/*) ;;
    *) return 1 ;;
  esac
  local relative="${1#plugins/*/}" nested skill
  case "$relative" in
    README.md) return 1 ;;
    # Each Markdown file under commands/ or agents/ is a component at any depth
    # (commands/docs/labels.md is /plugin:docs:labels), whatever its group or file is named.
    commands/*.md | agents/*.md) return 0 ;;
  esac
  # Test-runner files only, by basename: agents/issue.spec.md, templates/issue.spec.json
  # and anything under an issue.spec.v2/ directory ship.
  case "${relative##*/}" in
    *.test.[jt]s | *.test.[jt]sx | *.test.[cm][jt]s | *.spec.[jt]s | *.spec.[jt]sx | *.spec.[cm][jt]s) return 1 ;;
  esac
  nested="$relative"
  # A skills/ directory that holds SKILL.md (at HEAD or the base) is a skill, and its
  # name is not a category: skills/docs/SKILL.md is runtime. Without SKILL.md, a
  # category-named directory (skills/__tests__/) stays source-only.
  case "$nested" in
    skills/*/*)
      skill="${nested#skills/}"
      skill="${skill%%/*}"
      case "$skill" in
        docs | test | tests | testing | __tests__ | __snapshots__ | fixtures | __fixtures__)
          if git cat-file -e "HEAD:${1%"$relative"}skills/$skill/SKILL.md" 2>/dev/null ||
            git cat-file -e "$base_rev:${1%"$relative"}skills/$skill/SKILL.md" 2>/dev/null; then
            nested="${nested#skills/*/}"
          fi
          ;;
      esac
      ;;
  esac
  # __snapshots__/ holds Vitest-managed expected output for a colocated test.
  case "/$nested" in
    */docs/* | */test/* | */tests/* | */testing/* | */__tests__/* | */__snapshots__/* | */fixtures/* | */__fixtures__/*)
      return 1
      ;;
  esac
  return 0
}

# Preflight: jq absence skips only the Claude plugin.json branch. The OMP
# catalogue check always runs.
# CHECK_SKILL_VERSION_BASE (CI): compare the HEAD commit with that commit, with
# no fetch; an empty value or a base that does not resolve fails closed.
# Otherwise (pre-push): compare with origin/main. A failed fetch with a local
# origin/main is not a proven baseline, so the catalogue comparison is
# unverified and exits 1. origin/main missing entirely stays a visible SKIP.
export GIT_TERMINAL_PROMPT=0
have_jq=0
command -v jq >/dev/null 2>&1 && have_jq=1
explicit_base=0
if [ -n "${CHECK_SKILL_VERSION_BASE+set}" ]; then
  explicit_base=1
  base_label="$CHECK_SKILL_VERSION_BASE"
  if [ -z "$CHECK_SKILL_VERSION_BASE" ] ||
    ! base_rev=$(git rev-parse --verify --quiet "${CHECK_SKILL_VERSION_BASE}^{commit}"); then
    echo "cannot resolve CHECK_SKILL_VERSION_BASE='$CHECK_SKILL_VERSION_BASE' to a commit"
    exit 1
  fi
  diff_range=("$base_rev" HEAD)
else
  base_rev=origin/main
  base_label=origin/main
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
  diff_range=(origin/main...HEAD)
fi
# -z: otherwise git quotes a non-ASCII path ("plugins/p/r\303\251sum\303\251.md") and
# the quoted string never matches plugins/<p>/, so the change would go unchecked.
# --no-renames: a rename lists only its destination, so moving commands/x.md to docs/
# would hide the retired command. Without rename detection both ends are listed.
# A plain assignment keeps the pipeline status: a failed diff exits under set -e,
# where mapfile over a process substitution would report success on no plugins.
changed=$(
  git diff --name-only -z --no-renames "${diff_range[@]}" -- 'plugins/*' |
    while IFS= read -r -d '' path; do
      if is_distributed_runtime_path "$path"; then
        path="${path#plugins/}"
        printf '%s\n' "${path%%/*}"
      fi
    done
)
mapfile -t plugins < <(printf '%s\n' "$changed" | sort -u)
fail=0

# Classify the row named NAME in catalogue PATH at REV: ABSENT (no blob), LINK (the
# catalogue or its directory is a symlink), PARSE, DUPLICATE, NO_ROW, REMOTE, MISSING
# (row without version), BAD, or VERSION:<v>. Rows match by name in both catalogues:
# tools/validate_plugins.py requires a local Claude row to be named after its
# ./plugins/<name> source, so the name is the plugin directory. MODE=omp requires a
# semver (the OMP cache key). MODE=claude reports a row with a remote (object)
# source as REMOTE, takes a free-string version, and treats an explicit null as BAD
# because Claude Code refuses to install that row.
# Stream the bytes into the classifier: capturing them in a shell variable strips
# NUL before Bun.JSON.parse.
catalog_row_status() {
  local rev="$1" name="$2" path="$3" mode="$4" status entry
  for entry in "${path%/*}" "$path"; do
    if [ "$(git ls-tree "$rev" -- "$entry" | cut -d' ' -f1)" = 120000 ]; then
      printf 'LINK'
      return 0
    fi
  done
  if ! git cat-file -e "${rev}:${path}" 2>/dev/null; then
    printf 'ABSENT'
    return 0
  fi
  if ! status=$(git show "${rev}:${path}" | OMP_PLUGIN_NAME="$name" CATALOG_MODE="$mode" bun -e '
const name = process.env.OMP_PLUGIN_NAME ?? ""
const claude = process.env.CATALOG_MODE === "claude"
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
if (rows.length === 0) emit("NO_ROW")
// A remote (object) source is another install, not this directory. Anything else is
// read as the row of this plugin; validate_plugins.py rejects a missing or malformed source.
const source = rows[0].source
if (claude && source !== null && typeof source === "object" && !Array.isArray(source)) emit("REMOTE")
const version = rows[0].version
if (version === undefined || (version === null && !claude)) emit("MISSING")
if (typeof version !== "string" || version.length === 0 || /[\r\n]/.test(version)) emit("BAD")
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
if (!claude && !semver.test(version)) emit("BAD")
emit("VERSION:" + version)
'); then
    printf 'PARSE'
    return 0
  fi
  case "$status" in
    LINK | PARSE | DUPLICATE | MISSING | NO_ROW | REMOTE | BAD | VERSION:*) printf '%s' "$status" ;;
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

# FILE's bytes at REV, resolved like a checkout: path components left to right,
# each symlink replaced by its target before any later "..". Claude plugins may
# symlink files inside the repository.
# Exit 1: a component of the requested path is missing (FILE is absent).
# Exit 2: a symlink is absolute, leaves the tree, loops or dangles, or FILE exists
# but is not a file.
rev_file() {
  local rev="$1" cwd="" part target mode hops=0 linked=0 from_link todo=() parts=()
  IFS=/ read -ra todo <<<"$2"
  while [ "${#todo[@]}" -gt 0 ]; do
    part="${todo[0]}"
    todo=("${todo[@]:1}")
    # Components queued from link targets sit at the front of todo: a missing one dangles.
    from_link=0
    if [ "$linked" -gt 0 ]; then
      linked=$((linked - 1))
      from_link=1
    fi
    case "$part" in
      '' | .) continue ;;
      ..)
        [ -n "$cwd" ] || return 2
        case "$cwd" in */*) cwd="${cwd%/*}" ;; *) cwd="" ;; esac
        continue
        ;;
    esac
    mode=$(git --literal-pathspecs ls-tree --full-tree "$rev" -- "${cwd:+$cwd/}$part" | cut -c1-6)
    case "$mode" in
      120000)
        hops=$((hops + 1))
        [ "$hops" -le 40 ] || return 2
        target=$(git show "$rev:${cwd:+$cwd/}$part") || return 2
        case "$target" in /*) return 2 ;; esac
        IFS=/ read -ra parts <<<"$target"
        todo=("${parts[@]}" "${todo[@]}")
        linked=$((linked + ${#parts[@]}))
        ;;
      040000) cwd="${cwd:+$cwd/}$part" ;;
      100644 | 100755)
        [ "${#todo[@]}" -eq 0 ] || return $((1 + from_link))
        git show "$rev:${cwd:+$cwd/}$part"
        return
        ;;
      '') return $((1 + from_link)) ;;
      *) return 2 ;;
    esac
  done
  return 2
}

# Claude manifest of the candidate: the HEAD commit with an explicit base (CI),
# the worktree file otherwise (pre-push). Same exit codes as rev_file.
claude_manifest() {
  if [ "$explicit_base" -eq 1 ]; then
    rev_file HEAD "$1"
  else
    [ -f "$1" ] || return 1
    cat "$1"
  fi
}

unresolvable_link() {
  echo "$1: cannot resolve $2 — a symlink on its path is absolute, leaves the repository, loops or dangles, or it is not a file"
  fail=1
}

CLAUDE_CATALOG=.claude-plugin/marketplace.json

claude_row_status() {
  catalog_row_status "$1" "$2" "$CLAUDE_CATALOG" claude
}

catalogue_link_fail() {
  echo "$1: $2 is a symlink or sits under one — keep catalogues as regular files"
  fail=1
}

claude_catalog_fail() {
  case "$3" in
    LINK) catalogue_link_fail "$1" "$2" ;;
    DUPLICATE) echo "$1: duplicate plugins[] rows named $1 in $2" ;;
    BAD) echo "$1: Claude catalogue version is not a non-empty single-line string in $2" ;;
    *) echo "$1: cannot parse $2" ;;
  esac
  fail=1
}

for p in "${plugins[@]}"; do
  [ -n "$p" ] || continue
  pj="plugins/$p/.claude-plugin/plugin.json"
  # The Claude catalogue row must be valid whichever source supplies the version.
  head_row=$(claude_row_status HEAD "$p")
  case "$head_row" in
    LINK | PARSE | DUPLICATE | BAD) claude_catalog_fail "$p" "$CLAUDE_CATALOG" "$head_row" ;;
  esac
  cur_read=0
  if [ "$have_jq" -eq 1 ]; then
    manifest=$(claude_manifest "$pj") || cur_read=$?
  fi
  if [ "$have_jq" -ne 1 ]; then
    echo "SKIP: $p Claude version check needs jq (not found) — OMP catalogue check still runs" >&2
  elif [ "$cur_read" -eq 2 ]; then
    unresolvable_link "$p" "HEAD:$pj"
  else
    # Claude Code takes plugin.json .version, else the plugin's Claude catalogue row,
    # else the commit SHA. HEAD's source names the file to bump; the base resolves
    # in the same order, so moving the version between the two still compares.
    cur=$(printf '%s\n' "$manifest" | jq -r '.version // empty' 2>/dev/null || true)
    claude_file="$pj"
    if [ -z "$cur" ]; then
      claude_file="$CLAUDE_CATALOG"
      case "$head_row" in
        VERSION:*) cur="${head_row#VERSION:}" ;;
        ABSENT | NO_ROW | REMOTE | MISSING)
          if [ "$cur_read" -eq 1 ] && [ "$head_row" != MISSING ]; then
            echo "SKIP: $p has no Claude manifest or local catalogue row — no Claude version gate" >&2
          else
            echo "SKIP: $p takes its Claude version from the commit SHA (no version in plugin.json or $CLAUDE_CATALOG) — Claude bump gate inert" >&2
          fi
          ;;
      esac
    fi
    if [ -n "$cur" ]; then
      base=""
      base_read=0
      base_manifest=$(rev_file "$base_rev" "$pj") || base_read=$?
      if [ "$base_read" -eq 2 ]; then
        unresolvable_link "$p" "$base_label:$pj"
      else
        base=$(printf '%s\n' "$base_manifest" | jq -r '.version // empty' 2>/dev/null || true)
        if [ -z "$base" ]; then
          base_row=$(claude_row_status "$base_rev" "$p")
          case "$base_row" in
            VERSION:*) base="${base_row#VERSION:}" ;;
            ABSENT | NO_ROW | MISSING) ;;
            REMOTE)
              echo "NOTE: $p was a remote Claude plugin at $base_label; its previous version is outside this repository — set one above it" >&2
              ;;
            *) claude_catalog_fail "$p" "$base_label:$CLAUDE_CATALOG" "$base_row" ;;
          esac
        fi
      fi
      if [ -n "$base" ] && [ "$base" = "$cur" ]; then
        echo "$p: distributed runtime changed without version bump (still $cur) — bump $claude_file"
        fail=1
      fi
    fi
  fi

  # OMP cache key is the catalogue row of the commit being pushed,
  # not the worktree file and not the document version.
  cur_status=$(catalog_row_status HEAD "$p" ".omp-plugin/marketplace.json" omp)
  case "$cur_status" in
    LINK) catalogue_link_fail "$p" ".omp-plugin/marketplace.json" ;;
    PARSE) omp_fail "$p" "cannot parse .omp-plugin/marketplace.json" ;;
    DUPLICATE) omp_fail "$p" "duplicate plugins[] rows in .omp-plugin/marketplace.json" ;;
    BAD) omp_fail "$p" "catalogue version is not a single-line semver in .omp-plugin/marketplace.json" ;;
    ABSENT | MISSING | NO_ROW)
      echo "SKIP: $p has no version in .omp-plugin/marketplace.json — OMP bump gate inert for this plugin" >&2
      ;;
    VERSION:*)
      cur_omp="${cur_status#VERSION:}"
      base_status=$(catalog_row_status "$base_rev" "$p" ".omp-plugin/marketplace.json" omp)
      case "$base_status" in
        LINK) catalogue_link_fail "$p" "$base_label:.omp-plugin/marketplace.json" ;;
        PARSE) omp_fail "$p" "cannot parse $base_label:.omp-plugin/marketplace.json" ;;
        DUPLICATE) omp_fail "$p" "duplicate plugins[] rows in $base_label:.omp-plugin/marketplace.json" ;;
        BAD) omp_fail "$p" "$base_label catalogue version is not a single-line semver in .omp-plugin/marketplace.json" ;;
        ABSENT | MISSING | NO_ROW) ;;
        VERSION:*)
          base_omp="${base_status#VERSION:}"
          if [ "$base_omp" = "$cur_omp" ]; then
            echo "$p: distributed runtime changed without version bump (still $cur_omp) — bump .omp-plugin/marketplace.json"
            fail=1
          elif ! omp_is_upgrade "$cur_omp" "$base_omp"; then
            omp_fail "$p" "catalogue version is not a newer semver OMP will install in .omp-plugin/marketplace.json"
          fi
          ;;
        *) omp_fail "$p" "cannot parse $base_label:.omp-plugin/marketplace.json" ;;
      esac
      ;;
    *) omp_fail "$p" "cannot parse .omp-plugin/marketplace.json" ;;
  esac
done
[ "$fail" -eq 0 ]
