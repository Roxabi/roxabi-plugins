/**
 * finalize.ts — the finalize verdict for /promote step 9b (S11, D4/D7/D16)
 *
 * `classifyFinalize` is a PURE function judging the finalize action AROUND
 * price.sh output. It does NOT compute versions: the authoritative $VERSION is
 * already derived from the merge object and the tag floor (`price(BASE..M)`,
 * D4). This function takes that derived version, the tag floor (`base`), the
 * three witnesses, and the per-artifact tag/release state, and returns what to
 * do — tag, create-release, noop, or refuse — plus any witness warnings.
 *
 * Invariants (spec 353 §S11):
 *  - Structural REFUSE has precedence over everything (≠2 parents ∨ not a
 *    promote ∨ empty payload — D7). It even beats drift.
 *  - A witness disagreeing with the derivation is a WARN, never a REFUSE: the
 *    merge already shipped, a witness has zero authority independent of the
 *    derivation (D7). Finalize still acts.
 *  - Idempotence is per-artifact (D16): tag and release are reconciled
 *    independently; a tag/release pointing at a different M is drift → REFUSE.
 *
 * No git/IO here — every input is passed in.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-artifact reconciliation state for the tag or the release (D16). */
export type ArtifactState = 'absent' | 'points-at-M' | 'points-elsewhere'

/**
 * The three witnesses of the derivation (D4). Each is the version that artifact
 * asserts, or `null` when the artifact does not exist (e.g. `version_files: []`
 * leaves no file witness — D12).
 */
export interface Witnesses {
  title: string | null
  heading: string | null
  versionFile: string | null
}

export interface FinalizeInput {
  /** Parents of the merge object M. A promotion merge has exactly 2 (D7). */
  parentCount: number
  /** Whether M is a promote by PR metadata (D8). */
  isPromote: boolean
  /** The authoritative version derived from M + tag floor (`price(BASE..M)`). */
  derived: string
  /** The tag floor — the newest reachable component version (BASE). */
  base: string
  /** The three witnesses of the derivation. */
  witnesses: Witnesses
  /** Reconciliation state of the tag `<component>/v<derived>`. */
  tagState: ArtifactState
  /** Reconciliation state of the release titled `<component> v<derived>`. */
  releaseState: ArtifactState
}

export type FinalizeAction = 'tag' | 'create-release' | 'noop' | 'refuse'

export interface FinalizeVerdict {
  action: FinalizeAction
  /** Repair actions for disagreeing witnesses (D7). Empty when all agree. */
  warnings: string[]
  /** Human-readable reason. Empty string for a clean act. */
  reason: string
}

// ─── Witness evaluation ───────────────────────────────────────────────────────

/**
 * Build the WARN list for witnesses that disagree with the derivation (D7).
 * An absent (null) witness is silent — there is nothing to reconcile.
 */
function witnessWarnings(witnesses: Witnesses, derived: string): string[] {
  const warnings: string[] = []
  const checks: Array<[keyof Witnesses, string]> = [
    ['title', 'PR title'],
    ['heading', 'CHANGELOG heading'],
    ['versionFile', 'version file'],
  ]
  for (const [key, label] of checks) {
    const value = witnesses[key]
    if (value !== null && value !== derived) {
      warnings.push(
        `${label} witness disagrees: asserts ${value}, derivation is ${derived} — repair the ${label} to ${derived}.`,
      )
    }
  }
  return warnings
}

// ─── Verdict ──────────────────────────────────────────────────────────────────

/**
 * Classify the finalize action for a promotion merge M.
 *
 * Precedence:
 *   1. Structural REFUSE (≠2 parents ∨ not a promote ∨ empty payload) — D7.
 *   2. Drift REFUSE (tag or release points at a different M) — D16.
 *   3. Per-artifact idempotent act (tag / create-release / noop) — D16,
 *      carrying any witness WARNs (D7).
 */
export function classifyFinalize(input: FinalizeInput): FinalizeVerdict {
  const { parentCount, isPromote, derived, base, witnesses, tagState, releaseState } = input

  // 1 ─ Structural REFUSE (highest precedence, beats drift — D7).
  if (parentCount !== 2) {
    return {
      action: 'refuse',
      warnings: [],
      reason: `Merge has ${parentCount} parent(s), not 2 — M^2 is undefined (squash or fast-forward). Not a promotion merge.`,
    }
  }
  if (!isPromote) {
    return {
      action: 'refuse',
      warnings: [],
      reason: 'Merge is not a promote by PR metadata (D8) — refusing to tag it.',
    }
  }
  if (derived === base) {
    return {
      action: 'refuse',
      warnings: [],
      reason: `Empty payload: derived ${derived} == base ${base} — nothing to release (D16/D18).`,
    }
  }

  // 2 ─ Drift REFUSE: a tag or release pointing at a different M is drift, not
  //     idempotence (D16). Holds regardless of witness agreement.
  if (tagState === 'points-elsewhere') {
    return {
      action: 'refuse',
      warnings: [],
      reason: `Tag for ${derived} already exists and points elsewhere (≠ M) — drift, not idempotence (D16).`,
    }
  }
  if (releaseState === 'points-elsewhere') {
    return {
      action: 'refuse',
      warnings: [],
      reason: `Release for ${derived} already exists and points elsewhere (≠ M) — drift, not idempotence (D16).`,
    }
  }

  // 3 ─ Per-artifact idempotent act, carrying witness WARNs (D7).
  const warnings = witnessWarnings(witnesses, derived)

  // tagState 'absent' → tag, regardless of releaseState (S11 / D16).
  if (tagState === 'absent') {
    return { action: 'tag', warnings, reason: '' }
  }

  // tagState 'points-at-M' → reconcile the release independently (D16).
  if (releaseState === 'absent') {
    return { action: 'create-release', warnings, reason: '' }
  }

  // Both tag and release exist and point at M → green no-op (D16).
  return { action: 'noop', warnings, reason: '' }
}

// ─── CLI (S11 step 9b — make the tested verdict the EXECUTED verdict, #369) ────────
//
// /promote --finalize runs this so the classifier above IS the decision, not a bash
// re-implementation of part of it. Flags in, three stdout lines out:
//   action=<tag|create-release|noop|refuse>
//   reason=<text>            (empty unless refuse)
//   warning=<text>           (zero or more; witness disagreements — D7)
// Exit 1 on `refuse` so `bun run lib/finalize.ts … || …` short-circuits; 0 otherwise.

function parseFinalizeArgv(argv: string[]): FinalizeInput {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const req = (flag: string): string => {
    const v = get(flag)
    if (v === undefined) throw new Error(`finalize: missing required ${flag}`)
    return v
  }
  // A witness flag absent OR passed empty ('') means "artifact does not exist" → null (D12).
  const witness = (flag: string): string | null => {
    const v = get(flag)
    return v === undefined || v === '' ? null : v
  }
  const artifact = (flag: string): ArtifactState => {
    const v = req(flag)
    if (v !== 'absent' && v !== 'points-at-M' && v !== 'points-elsewhere') {
      throw new Error(`finalize: ${flag} must be absent|points-at-M|points-elsewhere, got '${v}'`)
    }
    return v
  }
  const parentCount = Number(req('--parent-count'))
  if (!Number.isInteger(parentCount)) throw new Error(`finalize: --parent-count must be an integer`)
  return {
    parentCount,
    isPromote: req('--is-promote') === 'true',
    derived: req('--derived'),
    base: req('--base'),
    witnesses: {
      title: witness('--witness-title'),
      heading: witness('--witness-heading'),
      versionFile: witness('--witness-file'),
    },
    tagState: artifact('--tag-state'),
    releaseState: artifact('--release-state'),
  }
}

if (import.meta.main) {
  const verdict = classifyFinalize(parseFinalizeArgv(process.argv.slice(2)))
  console.log(`action=${verdict.action}`)
  console.log(`reason=${verdict.reason}`)
  for (const w of verdict.warnings) console.log(`warning=${w}`)
  process.exit(verdict.action === 'refuse' ? 1 : 0)
}
