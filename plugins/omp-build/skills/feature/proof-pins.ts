import {
  ASSERTLEDGER_CONFIG,
  CONFIG,
  type Git,
  gitError,
  PIN_PRODUCER,
  PROOF_CONFIG_PATHS,
  type ProofConfigPin,
  type Refusal,
  refuse,
  SHA,
  STACK,
} from './proof-base'
import type { CandidateFacts } from './proof-candidate'
import { parseTree, REGULAR, type TreeEntry } from './proof-tree'

async function entryAt(git: Git, toplevel: string, commit: string, path: string): Promise<TreeEntry | null | Error> {
  if (!SHA.test(commit)) return new Error(`commit ${JSON.stringify(commit)} is not a sha`)
  if (path === '' || path.startsWith('-') || path.includes('\0') || path.includes('..')) {
    return new Error(`path ${JSON.stringify(path)} is not a proof-config pin path`)
  }
  const args = ['ls-tree', '-z', `${commit}^{commit}`, '--', path]
  const tree = await git(toplevel, args)
  if (tree.code !== 0) return new Error(gitError(args, tree))
  let entries: TreeEntry[]
  try {
    entries = parseTree(tree.stdout).filter((entry) => entry.path === path)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  if (entries.length > 1) return new Error(`${path} at ${commit} is ambiguous`)
  return entries[0] ?? null
}

function pinIdentity(entry: TreeEntry | null, commit: string, path: string): { blob: string | null } | Error {
  if (!entry) return { blob: null }
  if (entry.type !== 'blob' || !REGULAR[entry.mode] || !SHA.test(entry.oid)) {
    return new Error(`${path} at ${commit} is not a regular file (mode ${entry.mode}, type ${entry.type})`)
  }
  return { blob: entry.oid }
}

/**
 * Read proof-config identity from Git objects only. A missing path is
 * `blob: null`. A tree, submodule, or unreadable object refuses; it is not absence.
 */
export async function readProofConfigPins(
  git: Git,
  toplevel: string,
  commit: string,
  paths: readonly string[] = PROOF_CONFIG_PATHS,
): Promise<ProofConfigPin[] | Refusal> {
  if (!paths.length) return refuse('candidate', 'missing', 'proof configuration pins name no path')
  const pins: ProofConfigPin[] = []
  for (const path of paths) {
    const entry = await entryAt(git, toplevel, commit, path)
    if (entry instanceof Error) return refuse(PIN_PRODUCER[path] ?? 'candidate', 'unreadable', entry.message)
    const identity = pinIdentity(entry, commit, path)
    if (identity instanceof Error) return refuse(PIN_PRODUCER[path] ?? 'candidate', 'ambiguous', identity.message)
    pins.push({ path, sourceCommit: commit, blob: identity.blob })
  }
  return pins
}

async function rereadProofPin(git: Git, toplevel: string, pin: ProofConfigPin): Promise<{ ok: true } | Refusal> {
  if (!SHA.test(pin.sourceCommit) || (pin.blob !== null && !SHA.test(pin.blob)))
    return refuse('candidate', 'unreadable', `proof pin ${pin.path} is not a commit/blob identity`)
  const current = await readProofConfigPins(git, toplevel, pin.sourceCommit, [pin.path])
  if ('ok' in current) return current
  const found = current[0]
  if (!found || found.blob !== pin.blob)
    return refuse(
      PIN_PRODUCER[pin.path] ?? 'candidate',
      'unbound',
      `${pin.path} at ${pin.sourceCommit} is ${found?.blob ?? 'absent'}, not the approved ${pin.blob ?? 'absence'}`,
    )
  return { ok: true }
}

/** Re-read each pin's source commit. A blob mismatch is drift, not a new pin. */
export async function rereadProofConfigPins(
  git: Git,
  toplevel: string,
  pins: readonly ProofConfigPin[],
): Promise<{ ok: true } | Refusal> {
  if (!pins.length) return refuse('candidate', 'missing', 'approved proof configuration pins are absent')
  const seen = new Set<string>()
  for (const pin of pins) {
    if (seen.has(pin.path))
      return refuse('candidate', 'ambiguous', `approved proof pins name ${pin.path} more than once`)
    seen.add(pin.path)
    const reread = await rereadProofPin(git, toplevel, pin)
    if (!reread.ok) return reread
  }
  return { ok: true }
}

function missingRequiredPin(pins: readonly ProofConfigPin[]): Refusal | null {
  for (const path of PROOF_CONFIG_PATHS) {
    if (!pins.some((pin) => pin.path === path))
      return refuse('candidate', 'missing', `approved proof pins omit ${path}`)
  }
  return null
}

async function blobAt(
  git: Git,
  toplevel: string,
  commit: string,
  path: string,
  producer: Refusal['producer'],
): Promise<string | null | Refusal> {
  const entry = await entryAt(git, toplevel, commit, path)
  if (entry instanceof Error) return refuse(producer, 'unreadable', entry.message)
  const identity = pinIdentity(entry, commit, path)
  if (identity instanceof Error) return refuse(producer, 'ambiguous', identity.message)
  return identity.blob
}

function configPinRefusal(facts: CandidateFacts, pin: ProofConfigPin): Refusal | null {
  if (pin.path !== CONFIG) return null
  if (facts.semctx === 'configured' && pin.blob === null)
    return refuse('semctx', 'unbound', `${CONFIG} is configured, but the approved pin records absence`)
  if (facts.semctx === 'absent' && pin.blob !== null)
    return refuse('semctx', 'unbound', `${CONFIG} is absent, but the approved pin records ${pin.blob}`)
  return null
}

function adapterPinRefusal(facts: CandidateFacts, pin: ProofConfigPin): Refusal | null {
  if (pin.path !== ASSERTLEDGER_CONFIG) return null
  const declared = facts.adapters.map((item) => item.entry.oid)
  if (declared.some((oid) => oid !== pin.blob) || (declared.length === 0) !== (pin.blob === null))
    return refuse(
      'assertledger',
      'unbound',
      `${ASSERTLEDGER_CONFIG} declarations [${declared.join(', ')}] do not match approved ${pin.blob ?? 'absence'}`,
    )
  return null
}

async function comparePin(git: Git, facts: CandidateFacts, pin: ProofConfigPin): Promise<Refusal | null> {
  const producer = PIN_PRODUCER[pin.path] ?? 'candidate'
  const baseBlob = await blobAt(git, facts.toplevel, facts.baseTip, pin.path, producer)
  if (baseBlob !== null && typeof baseBlob === 'object') return baseBlob
  const candidateBlob = await blobAt(git, facts.toplevel, facts.candidate, pin.path, producer)
  if (candidateBlob !== null && typeof candidateBlob === 'object') return candidateBlob
  if (pin.path !== STACK && baseBlob !== null && candidateBlob !== null && baseBlob !== candidateBlob)
    return refuse(
      producer,
      'unbound',
      `${pin.path} at ${facts.candidate} (${candidateBlob}) differs from ${facts.baseTip} (${baseBlob})`,
    )
  const applicable = pin.path === STACK ? baseBlob : (candidateBlob ?? baseBlob)
  if (applicable !== pin.blob)
    return refuse(
      producer,
      'unbound',
      `${pin.path} applicable ${applicable ?? 'absence'} is not the approved ${pin.blob ?? 'absence'} at ${pin.sourceCommit}`,
    )
  return configPinRefusal(facts, pin) ?? adapterPinRefusal(facts, pin)
}

/**
 * Compare the base and candidate blobs `candidateFacts` already bound to the
 * approved pins. Does not read ignored files and does not replace those checks.
 * An omitted required path is not absence. A pin that says absent does not
 * cancel a committed config, and a pin that says present does not become
 * optional because the checkout is unconfigured.
 *
 * `.dev/stack.yml` is special: landing/policy binds the selected base tip, while
 * Semctx e2e justification ORs base and candidate stacks (`admitSemctx`). A
 * candidate that changes only the stack must not fail closed here as unbound —
 * that masked producer refusals/watching behind `candidate`/`unbound`.
 */
export async function compareApplicableProofPins(
  git: Git,
  facts: CandidateFacts,
  pins: readonly ProofConfigPin[],
): Promise<{ ok: true } | Refusal> {
  const reread = await rereadProofConfigPins(git, facts.toplevel, pins)
  if (!reread.ok) return reread
  const missing = missingRequiredPin(pins)
  if (missing) return missing
  for (const pin of pins) {
    const refusal = await comparePin(git, facts, pin)
    if (refusal) return refusal
  }
  return { ok: true }
}
