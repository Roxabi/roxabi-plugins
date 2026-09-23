#!/usr/bin/env bash
set -euo pipefail
# provision-release-gate.sh — the two-part gate provisioner (#353, S12 / D6 / D15).
#
# Makes the `release-consistency` gate REAL (not advisory) on a target repo, and
# is the exact thing /promote step 1 (S7) probes for. Two artifacts, one script:
#
#   (a) commits the per-repo caller stub `.github/workflows/release-consistency.yml`
#       into the TARGET repo (heredoc-rendered). The stub carries the TRIGGERS
#       (pull_request/push/workflow_dispatch) — a reusable workflow's own
#       non-workflow_call triggers fire in its HOST repo, never in the caller
#       (D15), so the triggers must live in a committed per-repo stub. The stub's
#       single job is named `release-consistency`, byte-for-byte equal to the
#       reusable workflow's job name (T11) — that name IS the required-check
#       context (D15, S7/S12 agree byte-for-byte).
#
#   (b) creates a `main`-targeting branch ruleset REQUIRING the
#       `release-consistency` check-run context with ZERO bypass actors (a
#       bypassable required check is advisory with better marketing — edge case).
#
# Idempotent: a clean re-run makes no change (blob-sha compare for the stub,
# name lookup for the ruleset). `--remove` reverses BOTH — deletes the stub
# commit and the ruleset.
#
# NOTE ON THE FILENAME COLLISION: the caller stub and the reusable workflow share
# the basename `release-consistency.yml` but live in different repos (stub in the
# target repo, reusable in Roxabi/roxabi-plugins). That is intentional and fine.
#
# ORDER MATTERS: the stub is committed BEFORE the ruleset is created. Reversing
# the order would arm a required status check on a branch that has no workflow
# reporting it → the branch deadlocks before the stub can land.
#
# Every mutation goes through `gh api` / `gh`. Nothing here runs until invoked;
# the file is `bash -n`-clean and safe to inspect without touching the live org.
#
# ╔════════════════════════════════════════════════════════════════════════════╗
# ║ RESIDUAL RISK — READ THIS BEFORE ENABLING THE GATE (#385 item 2)           ║
# ╚════════════════════════════════════════════════════════════════════════════╝
# This gate is NOT tamper-proof, and provisioning it does not make it so.
#
# THE HOLE. Artifact (a) — the caller stub — is a file committed INTO THE TARGET
# REPO, and GitHub evaluates a pull request's workflows from that pull request's
# own merge ref. So a PR may edit `.github/workflows/release-consistency.yml` in
# the same PR it is trying to land, and replace the `uses:` job with `run: exit 0`.
# The ruleset in (b) requires a check-run CONTEXT BY NAME: a green
# `release-consistency` produced by `exit 0` satisfies it exactly as well as a
# real run. `bypass_actors: []` does not help — nothing is being bypassed.
#
# This is not fixable inside release-consistency.yml. A workflow cannot defend
# the file that decides whether the workflow runs. It needs a control over WHO
# MAY CHANGE `.github/workflows/**`. Three, with what each does and does not
# cover:
#
#   1. Ruleset `file_path_restriction` on `.github/workflows/**` (repo or org).
#      COVERS: blocks the commit outright — no PR can modify a workflow file, so
#        the stub cannot be rewritten, deleted or renamed on a PR branch.
#      DOES NOT COVER: the maintainers who own the gate lose ordinary workflow
#        edits too, so they need a bypass actor or a temporary disable — and that
#        bypass, once granted, is this hole again wearing a different hat. It
#        also does not protect a repo whose ruleset can be edited by the same
#        people it restricts.
#
#   2. CODEOWNERS on `.github/workflows/**` + required Code Owner review.
#      COVERS: the edit becomes visible and needs a second, named human to
#        approve it. Cheap, no plan requirement, works per repo.
#      DOES NOT COVER: it is a REVIEW control, not a mechanical one. A code owner
#        who approves without reading the workflow diff re-opens the hole, and a
#        repo with a single active maintainer has no second human to ask.
#
#   3. Org-level required workflow (org/Enterprise policy).
#      COVERS: the run is injected by the ORG, not by a file in the repo, so the
#        committed stub stops being the trust root. This is the only option that
#        REMOVES the hole instead of guarding it.
#      DOES NOT COVER: needs org-admin rights and the right plan, applies
#        org-wide rather than per repo, and does not retroactively neutralise the
#        stubs this script already committed.
#
# WHAT THE GATE IS WORTH WITHOUT ONE OF THE THREE: it catches DRIFT and MISTAKES
# — a stale promote PR, a hand-edited version file, a forgotten re-price — which
# is exactly what it was built for (#353 D5). It does NOT stop an author with
# write access who means to get around it. Report it that way.
#
# WHY THERE IS NO BLOCKING POLICY PREFLIGHT (#385 item 5). This script does not
# refuse to provision a repo whose `main` carries no `release:` block; it prints
# an advisory report and continues. A blocking preflight would add a network read
# that can brick provisioning, and it would block the safe ordering (arm the gate
# first, land the policy second) for a deadlock that does not exist: with the
# gate armed and no policy, ordinary branch→main PRs early-green at the
# `head != staging` scope gate and pushes to main early-green on the default
# `version_files: []`. Only a staging→main PROMOTE PR reds, which is the intended
# D13 onboarding REFUSE.

# ── constants (do NOT drift from T11) ────────────────────────────────────────
STUB_PATH=".github/workflows/release-consistency.yml"
JOB_NAME="release-consistency"          # == reusable workflow job name == required context (D15)
RULESET_NAME="release-consistency-gate" # ruleset object name (distinct from PR_Main)
REUSABLE_REPO="Roxabi/roxabi-plugins"   # the repo HOSTING the reusable workflow
REUSABLE="${REUSABLE_REPO}/.github/workflows/release-consistency.yml"
PIN_NAMESPACE="${REUSABLE_REPO#*/}"     # that repo's tag namespace: <namespace>/vX.Y.Z
COMMIT_BRANCH="main"                    # the gate lives on main: the ruleset targets refs/heads/main
                                        # and pull_request(base=main) reads the workflow from main.
STACK_PATH=".dev/stack.yml"             # target-repo release policy, read for the advisory report

# NO DEFAULT_REF LITERAL (#385 item 5). The host repo cuts a new
# <namespace>/vX.Y.Z tag on every merge, so a literal pin in this file is stale
# the day after it is written — and a stale pin provisions a repo against an old
# gate, silently. The two non-answers are both worse: a branch pin (`@main`)
# re-points every provisioned stub under its repo's feet on every merge, and a
# "use the literal if resolution fails" fallback is a stale pin that hides that
# it is stale. So the pin is RESOLVED at provision time from the host repo's own
# tags, and an unresolvable pin is a hard, loud failure — never a guess.

usage() {
  cat >&2 <<'USAGE'
Usage: provision-release-gate.sh <owner/repo> [--ref <git-ref>] [--remove]

  <owner/repo>   target repo (a bare name is prefixed with the Roxabi org)
  --ref <ref>    reusable-workflow pin in the stub's `uses:`. Omitted, the newest
                 <namespace>/vX.Y.Z tag of the host repo is resolved at run time
                 and provisioning FAILS if it cannot be. Must be a tag or a full
                 40-hex commit sha — a branch is rejected.
  --remove       reverse BOTH artifacts: delete the caller stub and the ruleset

Provisions (idempotent):
  1. commit .github/workflows/release-consistency.yml (caller stub) to main
  2. create a main-targeting ruleset requiring the `release-consistency`
     check-run context with ZERO bypass actors

READ scripts/provision-release-gate.sh's RESIDUAL RISK header before enabling
this gate: the caller stub is committed into the target repo and a PR can edit
it, so the gate catches drift, not a determined author. The three controls that
close that (ruleset file_path_restriction, CODEOWNERS, org required-workflow)
are listed there with what each does and does not cover.
USAGE
  exit "${1:-2}"
}

# ── arg parsing ──────────────────────────────────────────────────────────────
REPO=""
REF=""                                  # empty → resolved from the host repo's tags
REMOVE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      [ "$#" -ge 2 ] || { echo "error: --ref needs an argument" >&2; usage 2; }
      REF="$2"; shift 2 ;;
    --ref=*)  REF="${1#--ref=}"; shift ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) usage 0 ;;
    -*) echo "error: unknown flag '$1'" >&2; usage 2 ;;
    *)
      [ -z "$REPO" ] || { echo "error: unexpected extra argument '$1'" >&2; usage 2; }
      REPO="$1"; shift ;;
  esac
done

[ -n "$REPO" ] || { echo "error: target repo is required" >&2; usage 2; }
# bare name → default org
case "$REPO" in */*) : ;; *) REPO="Roxabi/${REPO}" ;; esac

# ── preflight ────────────────────────────────────────────────────────────────
for bin in gh jq git base64; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: '$bin' is required but not found" >&2; exit 3; }
done

# ── pin resolution (#385 item 5) ─────────────────────────────────────────────
# Newest <namespace>/vX.Y.Z tag of the host repo, or an empty string. Every
# failure mode (gh missing auth, network, zero tags) collapses to "" rather than
# a pipefail abort, so the CALLER owns what emptiness means and can say so.
resolve_pin() {
  local names
  names=$(gh api "repos/${REUSABLE_REPO}/tags" --paginate --jq '.[].name' 2>/dev/null || true)
  printf '%s\n' "$names" \
    | sed -nE "s|^${PIN_NAMESPACE}/v([0-9]+\.[0-9]+\.[0-9]+)\$|\1|p" \
    | sort -V | tail -n1 | sed -E "s|^|${PIN_NAMESPACE}/v|"
}

# A pin is an IMMUTABLE reference: a <namespace>/vX.Y.Z tag, or a full 40-hex
# commit sha. Everything else is rejected — `--ref main` / `--ref staging` is the
# specific mistake this refuses, because a moving ref silently re-points every
# provisioned stub, so one bad merge in the host repo reds every consumer's main
# at once with no local change to explain it.
validate_pin() {
  case "$1" in
    "${PIN_NAMESPACE}"/v[0-9]*.[0-9]*.[0-9]*) return 0 ;;
  esac
  case "$1" in
    '' | *[!0-9a-f]*) : ;;
    ????????????????????????????????????????) return 0 ;;
  esac
  {
    echo "error: --ref '$1' is not an immutable pin."
    echo "  expected: ${PIN_NAMESPACE}/vX.Y.Z (a tag) or a full 40-hex commit sha"
    echo "  a branch is rejected on purpose: it re-points every provisioned stub on every merge"
  } >&2
  exit 4
}

# --remove is the escape hatch for the day the gate misfires, so it must not
# depend on resolving anything: the pin is irrelevant when deleting the stub.
if [ "$REMOVE" -eq 0 ]; then
  if [ -n "$REF" ]; then
    validate_pin "$REF"
  else
    REF="$(resolve_pin)"
    if [ -z "$REF" ]; then
      {
        echo "error: could not resolve a pin from ${REUSABLE_REPO}'s tags."
        echo "  Looked for the newest ${PIN_NAMESPACE}/vX.Y.Z tag via 'gh api repos/${REUSABLE_REPO}/tags'."
        echo "  Nothing was provisioned. This script does NOT fall back to a hardcoded tag"
        echo "  (stale and silent) nor to a branch (it would move under the stub)."
        echo "  Check 'gh auth status' and network access, or pass an explicit --ref <tag|sha>."
      } >&2
      exit 5
    fi
    echo "pin: resolved ${REF} (newest ${PIN_NAMESPACE}/v* tag on ${REUSABLE_REPO})"
  fi

  # The pin must actually exist in the host repo. Without this a typo'd --ref
  # commits a stub whose `uses:` 404s at run time — and a workflow that cannot
  # start reports NOTHING, which under a required check is a deadlock.
  gh api "repos/${REUSABLE_REPO}/commits/${REF}" --jq '.sha' >/dev/null 2>&1 || {
    echo "error: pin '${REF}' does not resolve in ${REUSABLE_REPO} — nothing provisioned" >&2
    exit 5
  }
fi

# ── stub renderer ────────────────────────────────────────────────────────────
# Quoted heredoc: no bash expansion, so GitHub `${{ ... }}` expressions survive
# verbatim. The reusable-workflow ref is the ONLY dynamic field — injected by a
# single sed against the `@__REF__` sentinel on the `uses:` line.
render_stub() {
  local ref=$1 out
  out=$(sed "s|@__REF__|@${ref}|" <<'YAML'
# Caller stub — release-consistency gate (#353, S9b / D15).
# GENERATED by scripts/provision-release-gate.sh in Roxabi/roxabi-plugins.
#
# This thin per-repo stub carries the TRIGGERS. A reusable workflow's own
# non-workflow_call triggers fire in its HOST repo, never in the caller (D15),
# so pull_request/push/workflow_dispatch MUST live here. The single job's NAME
# (release-consistency) is the required-check context the main ruleset requires
# and /promote step 1 (S7) probes for — keep it byte-identical to the reusable
# workflow's job name.
name: release-consistency

# Quoted so YAML 1.1 does not coerce the `on` key to boolean true.
"on":
  pull_request:
    branches: [main]
    # `edited` is required: the PR title is a witness (D9) and editing a title
    # fires no other event. `synchronize` re-prices per head SHA on mid-review
    # pushes (D6).
    types: [opened, edited, synchronize, reopened]
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      version_files_override:
        description: >-
          JSON/YAML list of version-file paths to check on the push/dispatch
          path, overriding release.version_files (S10 verification). Passed
          straight through to the reusable workflow.
        type: string
        required: false

permissions:
  contents: read

jobs:
  # Job name == required-check context. Do NOT rename without updating the
  # ruleset context (provision-release-gate.sh) and /promote's step-1 probe in
  # lockstep (D15).
  release-consistency:
    uses: Roxabi/roxabi-plugins/.github/workflows/release-consistency.yml@__REF__
    with:
      # Null on pull_request/push (coerces to ""); the reusable workflow treats
      # an empty override as "use release.version_files".
      version_files_override: ${{ inputs.version_files_override }}
YAML
)
  # The heredoc is quoted (it must be — it carries `${{ … }}`), so the reusable's
  # path is a literal inside it while $REUSABLE is a literal out here. Assert they
  # agree instead of letting the two drift into pointing at different workflows.
  case "$out" in
    *"uses: ${REUSABLE}@"*) : ;;
    *) echo "error: render_stub's uses: line does not name \${REUSABLE} (${REUSABLE}) — the two literals have drifted" >&2; exit 6 ;;
  esac
  printf '%s\n' "$out"
}

# ── remote helpers ───────────────────────────────────────────────────────────
# Blob sha GitHub stores for the stub path on COMMIT_BRANCH ("" if absent).
remote_stub_sha() {
  gh api "repos/${REPO}/contents/${STUB_PATH}?ref=${COMMIT_BRANCH}" --jq '.sha' 2>/dev/null || true
}

# Ruleset id by name ("" if none).
ruleset_id() {
  gh api "repos/${REPO}/rulesets" \
    --jq ".[] | select(.name == \"${RULESET_NAME}\") | .id" 2>/dev/null | head -n1 || true
}

# ── advisory: target release policy (#385 item 5) ────────────────────────────
# Reads the TARGET repo's .dev/stack.yml on COMMIT_BRANCH — the exact blob the
# gate's PR path reads as AUTHORITY — and says what the gate will do with it.
# ADVISORY ONLY: it never returns non-zero and never blocks provisioning (see
# "WHY THERE IS NO BLOCKING POLICY PREFLIGHT" in the header). Its job is to make
# the day-1 state legible before the required check is armed, not to veto it.
report_target_policy() {
  local raw component=""
  raw=$(gh api "repos/${REPO}/contents/${STACK_PATH}?ref=${COMMIT_BRANCH}" --jq '.content' 2>/dev/null \
    | base64 -d 2>/dev/null || true)

  if [ -n "$raw" ]; then
    if command -v yq >/dev/null 2>&1; then
      component=$(printf '%s\n' "$raw" | yq -r '.release.component // ""' 2>/dev/null || true)
    elif command -v python3 >/dev/null 2>&1; then
      component=$(printf '%s\n' "$raw" | python3 -c 'import sys,yaml; d=yaml.safe_load(sys.stdin) or {}; print(((d.get("release") or {}).get("component")) or "")' 2>/dev/null || true)
    else
      echo "policy: ${STACK_PATH} present on ${COMMIT_BRANCH} but no YAML reader (yq/python3) here — cannot report release.component"
      return 0
    fi
  fi

  case "$component" in
    '' | null)
      {
        echo "policy: WARN — no release.component on ${REPO}@${COMMIT_BRANCH}:${STACK_PATH}"
        echo "  The gate reads its AUTHORITY from the base branch, so until that lands:"
        echo "    · every ordinary branch→main PR      → early GREEN (head != staging)"
        echo "    · every push to main                 → early GREEN (version_files: [])"
        echo "    · a staging→main PROMOTE PR          → RED (release.component missing, D13)"
        echo "  That last one is the intended onboarding REFUSE, not a deadlock — the gate is"
        echo "  safe to arm now."
        echo "  ONBOARDING (this is the path for roxabi-factory / roxabi-live, which carry no"
        echo "  release: block on either branch):"
        echo "    1. Open an ORDINARY branch→${COMMIT_BRANCH} PR adding a release: block to"
        echo "       ${STACK_PATH} (component + version_files, model if not staging-train)."
        echo "       It early-greens at the scope gate, so it is mergeable with the gate armed."
        echo "    2. Only then is a staging→main promote PR gated for real."
        echo "  Order does not matter: provisioning before or after step 1 is equally safe."
      } >&2
      ;;
    *) echo "policy: release.component='${component}' on ${REPO}@${COMMIT_BRANCH}:${STACK_PATH} — promote PRs will be gated for real" ;;
  esac
}

# ── residual risk, printed BEFORE any mutation (#385 item 2) ─────────────────
# The header block is the authoritative text; this is the version an operator
# cannot miss, because they see it on the run that arms the check.
print_residual_risk() {
  cat >&2 <<'EOF_RESIDUAL'
─────────────────────────────────────────────────────────────────────────────
RESIDUAL RISK — this gate is NOT tamper-proof.
  The caller stub is a file committed into the TARGET repo, and a pull request's
  workflows are evaluated from that PR's own merge ref. A PR can therefore
  rewrite the `uses:` job to `run: exit 0` in the same PR it wants to land; the
  ruleset requires the check-run CONTEXT BY NAME and is satisfied by that green.
  Zero bypass actors does not help — nothing is being bypassed.
  Closing it needs a control on who may change .github/workflows/**:
    1. ruleset file_path_restriction — blocks the edit outright; also blocks
       your own maintainers, so the bypass it forces is the hole again.
    2. CODEOWNERS + required Code Owner review — makes the edit visible and
       needs a second human; it is a review control, not a mechanical one.
    3. org-level required workflow — the only one that removes the hole (the
       org injects the run, so the stub stops being the trust root); needs org
       admin and does not neutralise stubs already committed.
  Without one of those this gate catches DRIFT and MISTAKES, not a determined
  author with write access. See the RESIDUAL RISK header in this script.
─────────────────────────────────────────────────────────────────────────────
EOF_RESIDUAL
}

# ── provision (a): caller stub ───────────────────────────────────────────────
provision_stub() {
  local tmp local_sha remote_sha content
  tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" RETURN
  render_stub "$REF" > "$tmp"

  local_sha=$(git hash-object "$tmp")   # == the git blob sha GitHub stores
  remote_sha=$(remote_stub_sha)

  if [ "$local_sha" = "$remote_sha" ]; then
    echo "stub: up to date (${STUB_PATH}@${COMMIT_BRANCH}, ref=${REF}) — no change"
    return 0
  fi

  content=$(base64 -w0 "$tmp")
  local -a args=(
    "repos/${REPO}/contents/${STUB_PATH}" --method PUT
    -f "message=chore: provision release-consistency gate stub (#353)"
    -f "content=${content}"
    -f "branch=${COMMIT_BRANCH}"
  )
  # Updating an existing file requires its current blob sha.
  [ -n "$remote_sha" ] && args+=(-f "sha=${remote_sha}")

  gh api "${args[@]}" >/dev/null
  if [ -n "$remote_sha" ]; then
    echo "stub: updated ${STUB_PATH}@${COMMIT_BRANCH} (ref=${REF})"
  else
    echo "stub: created ${STUB_PATH}@${COMMIT_BRANCH} (ref=${REF})"
  fi
}

# ── provision (b): main-targeting ruleset ────────────────────────────────────
provision_ruleset() {
  local id body
  id=$(ruleset_id)
  if [ -n "$id" ]; then
    echo "ruleset: '${RULESET_NAME}' already present (id=${id}) — no change"
    return 0
  fi

  # ZERO bypass actors (empty list) — a bypassable required check is advisory.
  body=$(jq -n \
    --arg name "$RULESET_NAME" \
    --arg ctx "$JOB_NAME" \
    '{
      name: $name,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [ { context: $ctx } ]
          }
        }
      ],
      bypass_actors: []
    }')

  printf '%s' "$body" | gh api "repos/${REPO}/rulesets" --method POST --input - >/dev/null
  echo "ruleset: created '${RULESET_NAME}' — requires '${JOB_NAME}' on main, zero bypass actors"
}

# ── remove: reverse BOTH ─────────────────────────────────────────────────────
remove_stub() {
  local remote_sha
  remote_sha=$(remote_stub_sha)
  if [ -z "$remote_sha" ]; then
    echo "stub: ${STUB_PATH}@${COMMIT_BRANCH} absent — no change"
    return 0
  fi
  gh api "repos/${REPO}/contents/${STUB_PATH}" --method DELETE \
    -f "message=chore: remove release-consistency gate stub (#353)" \
    -f "sha=${remote_sha}" \
    -f "branch=${COMMIT_BRANCH}" >/dev/null
  echo "stub: removed ${STUB_PATH}@${COMMIT_BRANCH}"
}

remove_ruleset() {
  local id
  id=$(ruleset_id)
  if [ -z "$id" ]; then
    echo "ruleset: '${RULESET_NAME}' absent — no change"
    return 0
  fi
  gh api "repos/${REPO}/rulesets/${id}" --method DELETE >/dev/null
  echo "ruleset: removed '${RULESET_NAME}' (id=${id})"
}

# ── main ─────────────────────────────────────────────────────────────────────
if [ "$REMOVE" -eq 1 ]; then
  echo "== removing release-consistency gate on ${REPO} =="
  # Reverse order of provisioning: drop the ruleset first (so the required check
  # stops blocking), then delete the stub.
  remove_ruleset
  remove_stub
  echo "== done =="
else
  echo "== provisioning release-consistency gate on ${REPO} (ref=${REF}) =="
  # Both before the mutations: the operator sees what the gate is worth and what
  # the target's day-1 state is while nothing has been armed yet.
  print_residual_risk
  report_target_policy
  provision_stub      # (a) — must land before the ruleset arms the required check
  provision_ruleset   # (b)
  echo "== done =="
fi
