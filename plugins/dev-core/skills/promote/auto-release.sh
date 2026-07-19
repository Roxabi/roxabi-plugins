#!/usr/bin/env bash
# auto-release.sh — trunk-mode release orchestrator (Model B, #371).
#
# The SOLE owner of the merge-to-main derive → classify → reconcile flow. It is
# the trunk analogue of promote SKILL.md step 9b, extracted so the generated
# auto-release.yml stays a THIN invoker (no orchestration logic baked into YAML)
# and so /checkup can diff a stable expected workflow (N11).
#
# It reuses the existing engine — NO second copy of the logic:
#   price.sh     → the version deriver (D10): reachability floor + conventional-
#                  commit bump map. Called `COMPONENT M^1 M` and `--base-only`.
#   lib/finalize.ts → the pure finalize classifier (#369): structural REFUSE,
#                  drift REFUSE, per-artifact idempotent act. The tested verdict
#                  IS the executed verdict.
#
# Trunk-mode specialisation vs /promote 9b:
#   - Every merge to main IS the promote → --is-promote true (no head=staging PR).
#   - Witnesses are absent (auto-stamp deferred, D4) → no --witness-* flags.
#   - A stray 1-parent push to main is LOUD-RED (D3), never a silent release.
#   - An empty payload (no version-bumping commit) is a green no-op, exit 0 —
#     this workflow fires on EVERY merge and most merges are not releases.
#
# Usage:
#   auto-release.sh COMPONENT [M]            M defaults to HEAD (the pushed merge)
#   auto-release.sh --dry-run COMPONENT [M]  decide + print; no git push / gh release
#
# Exit:
#   0  → released (tag/release created) OR green no-op (empty payload)
#   1  → REFUSE (stray 1-parent, tag/release drift, price.sh error) — loud-red (D3)
set -euo pipefail

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
  shift
fi

COMPONENT="${1:?usage: auto-release.sh [--dry-run] COMPONENT [M]}"
M_REF="${2:-HEAD}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

M=$(git rev-parse --verify "${M_REF}^{commit}")

# ── Merge-commit prerequisite (D3): a release requires a 2-parent merge. ──
# 3 words (M + 2 parents) = 2 parents. A stray 1-parent push (direct commit,
# squash, fast-forward) is loud-red — it must never be silently released.
PARENT_COUNT=$(( $(git rev-list --parents -n1 "$M" | wc -w) - 1 ))
if [ "$PARENT_COUNT" -ne 2 ]; then
  echo "REFUSE: merge-to-main $M has $PARENT_COUNT parent(s), not 2 — trunk releases require a merge commit (D3)." >&2
  exit 1
fi

# ── Derive DERIVED + BASE — BOTH from price.sh, the sole deriver (D10). ──
# --base-only reuses the deriver's own floor predicate so the gate and this
# orchestrator never diverge from a second copy.
set +e; DERIVED=$(bash "${HERE}/price.sh" "$COMPONENT" "${M}^1" "$M"); RC=$?; set -e
if [ "$RC" -ge 1 ] && [ "$RC" -ne 10 ]; then
  echo "REFUSE: price.sh error ($RC)" >&2
  exit 1
fi
if [ "$RC" -eq 10 ]; then
  DERIVED=0.1.0; BASE=""                       # first release — no floor
else
  set +e; BASE=$(bash "${HERE}/price.sh" --base-only "$COMPONENT" "${M}^1"); BRC=$?; set -e
  if [ "$BRC" -ge 1 ] && [ "$BRC" -ne 10 ]; then
    echo "REFUSE: price.sh --base-only error ($BRC)" >&2
    exit 1
  fi
  [ "$BRC" -eq 10 ] && BASE=""
fi
VERSION="${COMPONENT}/v${DERIVED}"

# ── Empty-payload short-circuit (D16/D18): a merge adding no version-bumping ──
# commit derives == base. In trunk mode that is a green no-op, NOT a refuse:
# every merge fires this workflow and most carry nothing to release.
if [ -n "$BASE" ] && [ "$DERIVED" = "$BASE" ]; then
  echo "noop: empty payload — derived $DERIVED == base $BASE, nothing to release."
  exit 0
fi

# ── Reconcile tag + release per artifact (D16). finalize.ts is the sole ──
# classifier (structural REFUSE, drift REFUSE, per-artifact act). Bounded loop
# so a finalize that died mid-way converges (tag → create-release → noop).
# Witnesses are absent in trunk mode (D4) — no --witness-* flags.
for _ in 1 2 3; do
  TAG_AT=$(git rev-list -n1 "$VERSION" 2>/dev/null || true)
  if   [ -z "$TAG_AT" ];     then TAG_STATE=absent
  elif [ "$TAG_AT" = "$M" ]; then TAG_STATE=points-at-M
  else                            TAG_STATE=points-elsewhere; fi

  if [ "$DRY_RUN" = false ] && gh release view "$VERSION" >/dev/null 2>&1; then
    if [ "$TAG_AT" = "$M" ]; then RELEASE_STATE=points-at-M; else RELEASE_STATE=points-elsewhere; fi
  else
    RELEASE_STATE=absent   # dry-run (or no release): nothing to reconcile against
  fi

  set +e
  VERDICT=$(bun run "${HERE}/lib/finalize.ts" \
    --parent-count "$PARENT_COUNT" --is-promote true \
    --derived "$DERIVED" --base "$BASE" \
    --tag-state "$TAG_STATE" --release-state "$RELEASE_STATE")
  FRC=$?
  set -e
  ACTION=$(printf '%s\n' "$VERDICT" | sed -n 's/^action=//p')

  # finalize.ts exits 1 ONLY for a structured refuse (it still prints
  # action=refuse; every other action exits 0). The old `|| true` forgave that
  # non-zero exit but ALSO swallowed a genuine crash (bun failure, TS throw,
  # arg-parse error) into an empty ACTION → the `*) break` wildcard → a false
  # exit 0. On the write-authoritative path that is a silent non-release, the
  # exact D3 "loud-red, never a silent release" violation. Forgive a non-zero
  # exit only when it carries a parseable `action=refuse`; treat every other
  # non-zero exit — and any empty action on a clean exit — as loud-red.
  if { [ "$FRC" -ne 0 ] && [ "$ACTION" != refuse ]; } || [ -z "$ACTION" ]; then
    echo "REFUSE: finalize.ts gave no actionable verdict (exit $FRC, action='${ACTION}') — refusing to guess (D3)." >&2
    printf '%s\n' "$VERDICT" >&2
    exit 1
  fi

  case "$ACTION" in
    refuse)
      printf '%s\n' "$VERDICT" | sed -n 's/^reason=/REFUSE: /p' >&2
      exit 1
      ;;
    tag)
      echo "tag: $VERSION -> $M"
      [ "$DRY_RUN" = true ] && break
      git tag -a "$VERSION" -m "Release $VERSION" "$M"
      git push origin "$VERSION"
      ;;
    create-release)
      echo "create-release: $VERSION"
      [ "$DRY_RUN" = true ] && break
      TITLE="${VERSION/\/v/ v}"
      gh release create "$VERSION" --title "$TITLE" --generate-notes
      ;;
    noop | *)
      break
      ;;
  esac
done
