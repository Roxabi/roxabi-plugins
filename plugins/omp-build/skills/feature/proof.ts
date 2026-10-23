/**
 * Landing admission from producer evidence (#768).
 *
 * `admitLanding` only reads Git objects of the freshly established selected base
 * and candidate plus the PR's common-codec history and body. It never runs
 * Semctx, assertledger, a test or an LLM. The evidence was acquired earlier by
 * `proof-acquire.ts` in a private checkout of the candidate and conserved as a
 * confirmed common record. Admission re-reads it, re-derives every binding input
 * itself, and applies the policy.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  buildRecord,
  type CanonicalRecord,
  classifyHistory,
  type DecodedHistory,
  decodeHistory,
  githubScope,
  type Json,
  readGitHubHistory,
  selectApplicableMandate,
} from '../../dist/contracts.js'
import type { Diagnostic } from '../../engine/record-values.ts'
import type { ProofSelector } from '../../engine/workflow-reconstruction-types.ts'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import { resolveReviewSemanticContext } from '../../roxabi/review-context'
import { fixKind, type TicketSignals, ticketOfBranch } from './epic'

export type GitResult = { code: number; stdout: string; stderr: string }
/** Non-throwing Git with untrimmed UTF-8 stdout; qualifying blobs also bind their exact bytes. */
export type Git = (cwd: string, args: string[]) => Promise<GitResult>
export type Gh = (cwd: string, args: string[]) => Promise<string>
export type PrComment = { id?: number; author: { login: string }; body: string; createdAt?: string; updatedAt?: string }

export type Producer = 'semctx' | 'assertledger'
export type RefusalReason = 'unreadable' | 'ambiguous' | 'missing' | 'unbound' | 'verdict' | 'unjustified'
/** `candidate`: the selected candidate or its checkout could not be bound, before any producer applies. */
export type Refusal = { ok: false; producer: Producer | 'candidate'; reason: RefusalReason; error: string }
/** The closed NO TEST enum. Nothing widens it. */
export const NO_TEST_REASONS = ['infra-not-wired', 'prompt-logic-only', 'ui-manual-only', 'out-of-scope'] as const
export type NoTestReason = (typeof NO_TEST_REASONS)[number]

const SHA = /^[0-9a-f]{40}$/
const NATIVE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const CHANGES_DIR = '.semctx/semantic/changes/'
export const CONFIG = '.semctx/config.json'
export const STACK = '.dev/stack.yml'
export const ASSERTLEDGER_CONFIG = 'assertledger.config.json'
/** Paths a mandate pin must name. Omission is not absence. */
export const PROOF_CONFIG_PATHS = [CONFIG, STACK, ASSERTLEDGER_CONFIG] as const
const PIN_PRODUCER: Record<string, Producer | 'candidate'> = {
  [CONFIG]: 'semctx',
  [ASSERTLEDGER_CONFIG]: 'assertledger',
}

/**
 * Git identity of one proof-configuration path at one source commit.
 * `blob: null` is explicit absence. Ignored working-tree files are never a pin.
 * Field names match the engine `ProofConfigPin`; this alias is replaced by that export.
 */
export type ProofConfigPin = {
  path: string
  sourceCommit: string
  blob: string | null
}
/**
 * Pins of the one applicable mandate. `null` means no mandate exists: the
 * existing producer no-op stays. A refused, empty, or drifted pin is not that no-op.
 */
export function pinsFromApplicableMandate(
  history: DecodedHistory,
  external: DecodedHistory[] = [],
): ProofConfigPin[] | Refusal | null {
  const selected = selectApplicableMandate(history, external) as
    | { status: 'applicable'; mandate: { payload: { proofPins?: unknown } } }
    | { status: 'refused'; reason?: string }
  if (selected.status !== 'applicable') {
    if (selected.reason === 'missing') return null
    return refuse('candidate', 'missing', `mandate ${selected.reason ?? 'unresolved'}`)
  }
  const pins = selected.mandate.payload.proofPins
  if (!Array.isArray(pins) || pins.length === 0) return refuse('candidate', 'missing', 'mandate has no proof pins')
  return pins as ProofConfigPin[]
}

function refuse(producer: Producer | 'candidate', reason: RefusalReason, error: string): Refusal {
  return { ok: false, producer, reason, error }
}

export function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * An ignored `.semctx` directory is not a portable declaration.  We still
 * detect it so a checkout or principal cannot silently downgrade an owed proof
 * to absence; its contents are deliberately never read as configuration.
 */
async function ignoredSemctxState(git: Git, toplevel: string): Promise<string | Error | null> {
  const listed = await git(toplevel, ['worktree', 'list', '--porcelain', '-z'])
  if (listed.code !== 0) return new Error(gitError(['worktree', 'list', '--porcelain', '-z'], listed))
  const roots = new Set([toplevel])
  const principal = listed.stdout
    .split('\0')
    .find((field) => field.startsWith('worktree '))
    ?.slice('worktree '.length)
  if (principal) roots.add(principal)
  for (const root of roots) {
    const state = join(root, '.semctx')
    try {
      lstatSync(state)
      return state
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      return new Error(`${JSON.stringify(state)} cannot be read: ${errorMessage(error)}`)
    }
  }
  return null
}

/** One trailing newline is the terminator; everything else — spaces, embedded newlines — is the path. */
function oneLine(stdout: string): string {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
}

function gitError(args: string[], result: GitResult): string {
  return `git ${args.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim() || '(no output)'}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Establish the selected base: resolve origin's explicit URL through gh and
 * require the selected repository before fetching it. GitHub's `baseRefOid` is
 * recorded when the PR is opened, its head pushed or its base retargeted, and does
 * not follow the branch: the fetch, never that field, is the selected tip, and a
 * later fetch that differs from it is a moved base.
 */
export async function refreshSelectedBase(
  cwd: string,
  base: string,
  git: Git,
  gh: Gh,
): Promise<{ ok: true; tip: string } | Refusal> {
  if (!base || base.startsWith('-'))
    return refuse('candidate', 'unreadable', `PR base ${JSON.stringify(base)} is not a branch name`)
  const remote = await git(cwd, ['remote', 'get-url', 'origin'])
  const url = oneLine(remote.stdout)
  if (remote.code !== 0 || !url || url.startsWith('-'))
    return refuse('candidate', 'unreadable', 'origin has no readable repository URL')
  let selected: string
  let source: string
  try {
    selected = await repositoryOf(gh, cwd)
    source = await repositoryOf(gh, cwd, url)
  } catch {
    return refuse('candidate', 'unreadable', 'gh cannot resolve origin and selected repository identities')
  }
  if (source !== selected)
    return refuse('candidate', 'unbound', `origin repository ${source} conflicts with selected repository ${selected}`)
  // Keep the verified URL, not the mutable remote name, as this fetch's source.
  const fetchArgs = ['fetch', '--quiet', '--no-tags', url, `+refs/heads/${base}:refs/remotes/origin/${base}`]
  const fetched = await git(cwd, fetchArgs)
  if (fetched.code !== 0)
    return refuse(
      'candidate',
      'unreadable',
      `verified origin base ${JSON.stringify(base)} fetch failed (${fetched.code})`,
    )
  const args = ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]
  const read = await git(cwd, args)
  const tip = oneLine(read.stdout)
  if (read.code !== 0 || !SHA.test(tip)) return refuse('candidate', 'unreadable', gitError(args, read))
  return { ok: true, tip }
}

// ---------------------------------------------------------------------------
// Candidate facts: the bound root and the base's and candidate's committed trees
// ---------------------------------------------------------------------------

type TreeEntry = { mode: string; type: string; oid: string; path: string }
/** A declaration committed at `at`: the established base tip or the candidate sha. */
export type Declared = { at: string; entry: TreeEntry }

/**
 * The Semctx configuration the producer runs under, committed at the candidate
 * (and equal to the base configuration when the base declares one). `sha256`
 * is of the committed text.
 */
export type SemctxConfig = { source: 'committed'; path: string; text: string; sha256: string }

export type CandidateFacts = {
  /** `git rev-parse --show-toplevel` of the caller's cwd, lossless. */
  toplevel: string
  candidate: string
  /** The selected PR base branch and its freshly established, immutable commit. */
  base: string
  baseTip: string
  semctx: 'absent' | 'configured'
  /** Set exactly when Semctx is configured. */
  config: SemctxConfig | null
  /** Every `.semctx/semantic/changes/**.sem` committed at the candidate. */
  changeFiles: string[]
  /** `.dev/stack.yml` as the base and the candidate commit it. */
  stacks: Declared[]
  /** The assertledger configuration declarations the base and the candidate commit. */
  adapters: Declared[]
}

function parseTree(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of stdout.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    if (tab < 0 || !mode || !type || !oid) throw new Error(`unreadable ls-tree entry ${JSON.stringify(record)}`)
    entries.push({ mode, type, oid, path: record.slice(tab + 1) })
  }
  return entries
}

const REGULAR: Record<string, true> = { '100644': true, '100755': true }

export async function blob(git: Git, toplevel: string, entry: TreeEntry): Promise<string> {
  if (entry.type !== 'blob' || !REGULAR[entry.mode]) {
    throw new Error(`${entry.path} is not a regular file (mode ${entry.mode})`)
  }
  const result = await git(toplevel, ['cat-file', 'blob', entry.oid])
  if (result.code !== 0) throw new Error(gitError(['cat-file', 'blob', entry.oid], result))
  return result.stdout
}

/** The entries `rev` commits under the paths applicability reads, or the Git error. */
async function declarations(git: Git, toplevel: string, rev: string): Promise<TreeEntry[] | Error> {
  const args = ['ls-tree', '-r', '-z', '--full-tree', `${rev}^{commit}`, '--', '.semctx', STACK, ASSERTLEDGER_CONFIG]
  const tree = await git(toplevel, args)
  if (tree.code !== 0) return new Error(gitError(args, tree))
  try {
    return parseTree(tree.stdout)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * What the base and the candidate commit, bound to the repository root and to a
 * local tip that is the candidate. Applicability is the union of the established
 * base commit and candidate, so a PR cannot exempt itself by deleting a
 * declaration: Semctx applies when either holds `.semctx`. Semctx runs only
 * under the candidate's committed config, which must equal the base's when the
 * base commits one (a PR never relaxes the policy it is judged by). `absent` is
 * only when neither tree has Semctx state. Anything else refuses: Git errors, a
 * missing or corrupt base or candidate, a malformed config, committed working
 * state, changed configurations, or Semctx state without a committed config.
 */
export async function candidateFacts(
  cwd: string,
  candidate: string,
  base: string | undefined,
  baseTip: string,
  git: Git,
): Promise<CandidateFacts | Refusal> {
  if (!SHA.test(candidate))
    return refuse('candidate', 'unreadable', `candidate ${JSON.stringify(candidate)} is not a commit sha`)
  if (!base || base.startsWith('-')) {
    return refuse('candidate', 'unreadable', `the PR base ${JSON.stringify(base ?? null)} is not a branch name`)
  }
  if (!SHA.test(baseTip)) return refuse('candidate', 'unreadable', `PR base ${base} has no commit sha`)
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return refuse('candidate', 'unreadable', gitError(['rev-parse', '--show-toplevel'], top))
  const toplevel = oneLine(top.stdout)
  if (!toplevel || !isAbsolute(toplevel)) {
    return refuse('candidate', 'unreadable', `git rev-parse --show-toplevel gave no root for ${cwd}`)
  }
  const tipArgs = ['rev-parse', '--verify', 'HEAD^{commit}']
  const tip = await git(toplevel, tipArgs)
  if (tip.code !== 0)
    return refuse('candidate', 'unreadable', `the local tip cannot be read — ${gitError(tipArgs, tip)}`)
  if (oneLine(tip.stdout) !== candidate) {
    return refuse(
      'candidate',
      'unbound',
      `the local tip ${oneLine(tip.stdout)} is not candidate ${candidate}: land from the checkout of the reviewed head`,
    )
  }
  const entries = await declarations(git, toplevel, candidate)
  if (entries instanceof Error) {
    return refuse('candidate', 'unreadable', `candidate ${candidate} cannot be read — ${entries.message}`)
  }
  const baseRef = `origin/${base}`
  const baseEntries = await declarations(git, toplevel, baseTip)
  if (baseEntries instanceof Error) {
    return refuse('candidate', 'unreadable', `${baseRef} cannot be read — ${baseEntries.message}`)
  }
  const sides: [string, TreeEntry[]][] = [
    [baseTip, baseEntries],
    [candidate, entries],
  ]
  const declared = (pick: (tree: TreeEntry[]) => TreeEntry | null): Declared[] => {
    const out: Declared[] = []
    for (const [at, tree] of sides) {
      const entry = pick(tree)
      if (entry && !out.some((seen) => seen.entry.path === entry.path && seen.entry.oid === entry.oid)) {
        out.push({ at, entry })
      }
    }
    return out
  }
  const find = (tree: TreeEntry[], path: string) => tree.find((entry) => entry.path === path) ?? null
  const isSemctx = (entry: TreeEntry) => entry.path === '.semctx' || entry.path.startsWith('.semctx/')
  const semctxEntries = entries.filter(isSemctx)
  const facts = {
    toplevel,
    candidate,
    base,
    baseTip,
    changeFiles: semctxEntries
      .map((entry) => entry.path)
      .filter((path) => path.startsWith(CHANGES_DIR) && path.endsWith('.sem'))
      .sort(),
    stacks: declared((tree) => find(tree, STACK)),
    adapters: declared((tree) => find(tree, ASSERTLEDGER_CONFIG)),
  }
  const working = semctxEntries.filter(
    (entry) => entry.path.startsWith('.semctx/working/') && entry.path !== '.semctx/working/.gitkeep',
  )
  if (working.length) {
    return refuse(
      'semctx',
      'ambiguous',
      `candidate ${candidate} commits Semctx working state (${working.map((entry) => entry.path).join(', ')}); it overrides committed contracts — remove it from the branch`,
    )
  }
  if (!semctxEntries.length && !baseEntries.some(isSemctx)) {
    const ignored = await ignoredSemctxState(git, toplevel)
    if (ignored instanceof Error) return refuse('semctx', 'unreadable', ignored.message)
    if (ignored) {
      return refuse(
        'semctx',
        'ambiguous',
        `ignored local Semctx state at ${JSON.stringify(ignored)} cannot establish portable proof — commit the configuration or remove the state`,
      )
    }
  }
  const baseConfig = find(baseEntries, CONFIG)
  const committed = find(entries, CONFIG)
  if (baseConfig && committed?.oid !== baseConfig.oid) {
    return refuse(
      'semctx',
      'ambiguous',
      `candidate ${candidate} ${committed ? 'changes' : 'deletes'} the ${CONFIG} ${baseRef} commits: a PR is judged under the base's Semctx policy, never its own — a configuration change lands outside landPr`,
    )
  }
  if (committed) {
    let text: string
    try {
      text = await blob(git, toplevel, committed)
      if (!isMap(JSON.parse(text))) throw new Error('not a JSON object')
    } catch (error) {
      return refuse(
        'semctx',
        'unreadable',
        `${CONFIG} at ${candidate} is malformed or unreadable: ${errorMessage(error)}`,
      )
    }
    return {
      ...facts,
      semctx: 'configured',
      config: { source: 'committed', path: CONFIG, text, sha256: createHash('sha256').update(text).digest('hex') },
    }
  }
  const committedState = semctxEntries[0] ?? baseEntries.find(isSemctx)
  if (committedState) {
    const where = semctxEntries.length ? `candidate ${candidate}` : `${baseRef} (the candidate removes it)`
    return refuse(
      'semctx',
      'ambiguous',
      `${where} commits .semctx (${committedState.path}) without a regular ${CONFIG}: ignored local configuration cannot establish portable proof — commit the configuration or remove the Semctx state`,
    )
  }
  return { ...facts, semctx: 'absent', config: null }
}

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

/** Re-read each pin's source commit. A blob mismatch is drift, not a new pin. */
export async function rereadProofConfigPins(
  git: Git,
  toplevel: string,
  pins: readonly ProofConfigPin[],
): Promise<{ ok: true } | Refusal> {
  if (!pins.length) return refuse('candidate', 'missing', 'approved proof configuration pins are absent')
  const seen = new Set<string>()
  for (const pin of pins) {
    if (seen.has(pin.path)) {
      return refuse('candidate', 'ambiguous', `approved proof pins name ${pin.path} more than once`)
    }
    seen.add(pin.path)
    if (!SHA.test(pin.sourceCommit) || (pin.blob !== null && !SHA.test(pin.blob))) {
      return refuse('candidate', 'unreadable', `proof pin ${pin.path} is not a commit/blob identity`)
    }
    const current = await readProofConfigPins(git, toplevel, pin.sourceCommit, [pin.path])
    if ('ok' in current) return current
    const found = current[0]
    if (!found || found.blob !== pin.blob) {
      return refuse(
        PIN_PRODUCER[pin.path] ?? 'candidate',
        'unbound',
        `${pin.path} at ${pin.sourceCommit} is ${found?.blob ?? 'absent'}, not the approved ${pin.blob ?? 'absence'}`,
      )
    }
  }
  return { ok: true }
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
  for (const path of PROOF_CONFIG_PATHS) {
    if (!pins.some((pin) => pin.path === path)) {
      return refuse('candidate', 'missing', `approved proof pins omit ${path}`)
    }
  }
  for (const pin of pins) {
    const producer = PIN_PRODUCER[pin.path] ?? 'candidate'
    const at = async (commit: string): Promise<string | null | Refusal> => {
      const entry = await entryAt(git, facts.toplevel, commit, pin.path)
      if (entry instanceof Error) return refuse(producer, 'unreadable', entry.message)
      const identity = pinIdentity(entry, commit, pin.path)
      if (identity instanceof Error) return refuse(producer, 'ambiguous', identity.message)
      return identity.blob
    }
    const baseBlob = await at(facts.baseTip)
    if (baseBlob !== null && typeof baseBlob === 'object') return baseBlob
    const candidateBlob = await at(facts.candidate)
    if (candidateBlob !== null && typeof candidateBlob === 'object') return candidateBlob
    // STACK may diverge across base/candidate; CONFIG and assertledger must not.
    if (pin.path !== STACK && baseBlob !== null && candidateBlob !== null && baseBlob !== candidateBlob) {
      return refuse(
        producer,
        'unbound',
        `${pin.path} at ${facts.candidate} (${candidateBlob}) differs from ${facts.baseTip} (${baseBlob})`,
      )
    }
    // Landing/policy stack applicability is the selected base tip; candidate stack
    // is read later for e2e OR. Other paths still prefer the candidate blob.
    const applicable = pin.path === STACK ? baseBlob : (candidateBlob ?? baseBlob)
    if (applicable !== pin.blob) {
      return refuse(
        producer,
        'unbound',
        `${pin.path} applicable ${applicable ?? 'absence'} is not the approved ${pin.blob ?? 'absence'} at ${pin.sourceCommit}`,
      )
    }
    if (pin.path === CONFIG && facts.semctx === 'configured' && pin.blob === null) {
      return refuse('semctx', 'unbound', `${CONFIG} is configured, but the approved pin records absence`)
    }
    if (pin.path === CONFIG && facts.semctx === 'absent' && pin.blob !== null) {
      return refuse('semctx', 'unbound', `${CONFIG} is absent, but the approved pin records ${pin.blob}`)
    }
    if (pin.path === ASSERTLEDGER_CONFIG) {
      const declared = facts.adapters.map((item) => item.entry.oid)
      if (declared.some((oid) => oid !== pin.blob) || (declared.length === 0) !== (pin.blob === null)) {
        return refuse(
          'assertledger',
          'unbound',
          `${ASSERTLEDGER_CONFIG} declarations [${declared.join(', ')}] do not match approved ${pin.blob ?? 'absence'}`,
        )
      }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Conserved records: common codec transport, native proof semantics
// ---------------------------------------------------------------------------

type Found = { record: unknown; recordId: string; parts: PrComment[] } | { missing: string } | { unreadable: string }
type SelectedRecord = Extract<Found, { record: unknown }>

const proofOperationPrefix = (producer: Producer, candidate: string) => `proof:${producer}:${candidate}:`

export function findProofRecord(history: DecodedHistory, producer: Producer, candidate: string): Found {
  const foreignOperationIds = new Set(
    classifyHistory(history)
      .classes.filter((entry) => entry.authority === 'foreign' && entry.operationId !== null)
      .map((entry) => entry.operationId),
  )
  const sourcePosition = new Map(history.source.comments.map((comment, index) => [comment.locator, index]))
  const lastPosition = (parts: (typeof history.operations)[number]['parts']) =>
    Math.max(...parts.map((part) => sourcePosition.get(part.locator) ?? -1))
  const operations = history.operations
    .filter(
      (operation) =>
        operation.operationId?.startsWith(proofOperationPrefix(producer, candidate)) &&
        operation.operationId !== null &&
        !foreignOperationIds.has(operation.operationId),
    )
    .sort((left, right) => lastPosition(left.parts) - lastPosition(right.parts))
  if (!operations.length) {
    const legacy = history.source.comments.some(
      (comment) =>
        comment.author === history.source.expectedAuthor &&
        comment.body.includes(`<!-- omp-build:proof producer=${producer} -->`) &&
        comment.body.includes(`<!-- omp-build:proof-head sha=${candidate}`),
    )
    return legacy
      ? {
          unreadable: `a legacy ${producer} proof record exists for ${candidate}; historical proof framing cannot admit landing`,
        }
      : { missing: `no ${producer} common proof record for candidate ${candidate}` }
  }
  const latest = operations.at(-1)
  if (!latest) return { unreadable: `the latest ${producer} proof operation for ${candidate} is missing` }
  if (latest.status !== 'complete' || latest.record === null)
    return { unreadable: `the latest ${producer} proof operation for ${candidate} is ${latest.status}` }
  if (
    latest.record.kind !== 'proof' ||
    latest.record.payload.candidateGitSHA !== candidate ||
    !isMap(latest.record.payload.data) ||
    latest.record.payload.data.producer !== producer
  )
    return { unreadable: `the latest ${producer} proof operation for ${candidate} has invalid proof data` }
  if (latest.record.recordId.length === 0) {
    return { unreadable: `the latest ${producer} proof operation for ${candidate} has no record id` }
  }
  return {
    record: latest.record.payload.data,
    recordId: latest.record.recordId,
    parts: latest.parts.map((part) => ({
      id: part.nativeId === null ? undefined : Number(part.nativeId),
      author: { login: part.author ?? '' },
      body: part.body,
      ...(part.createdAt === null ? {} : { createdAt: part.createdAt }),
      ...(part.updatedAt === null ? {} : { updatedAt: part.updatedAt }),
    })),
  }
}

export function newProofRecord(
  repository: string,
  pr: number,
  producer: Producer,
  candidate: string,
  data: unknown,
): CanonicalRecord {
  const operationId = `${proofOperationPrefix(producer, candidate)}${randomUUID()}`
  const built = buildRecord({
    version: 1,
    recordId: operationId,
    runId: `proof:${candidate}:${randomUUID()}`,
    operationId,
    repository,
    target: githubScope(repository, pr).target,
    kind: 'proof',
    payload: { candidateGitSHA: candidate, data: data as Json },
  })
  if (!built.ok) {
    throw new Error(`proof record refused: ${built.diagnostics.map((item) => item.code).join(',')}`)
  }
  return built.value
}
// ---------------------------------------------------------------------------
// Semctx: the protocol both acquisition and admission derive
// ---------------------------------------------------------------------------

export type Step = { argv: string[]; exit: number; stdout: string }

export type SemctxInvocation = {
  repository: string
  pr: number
  candidate: string
  base: string
  mergeBase: string
  /** Changed `.semctx/semantic/changes/<id>.sem` files in `mergeBase..candidate`, sorted. */
  contracts: string[]
  /** The private checkout the producer ran in. */
  root: string
  tool: { path: string; version: string }
  /** The Semctx configuration the run used (`CandidateFacts.config`), by source and digest. */
  config: { source: SemctxConfig['source']; sha256: string }
  /** `git status --porcelain -z --untracked-files=all` of the private checkout, before and after. */
  status: { before: string; after: string }
  /** Ignored paths of the private checkout after the run. */
  ignored: string[]
}

export type SemctxRecord = { producer: 'semctx'; invocation: SemctxInvocation; native: Step[] }

export const changeIdOf = (path: string) => path.slice(CHANGES_DIR.length, -'.sem'.length)

/** The Semctx argv sequence, after the binary, for one acquisition. */
export function semctxSteps(root: string, contracts: string[], mergeBase: string, candidate: string): string[][] {
  const at = ['--root', root]
  const steps = [
    [...at, 'index', '--json'],
    [...at, 'status', '--json'],
    [...at, 'semantic', 'check', '--json'],
  ]
  for (const id of contracts.map(changeIdOf)) {
    steps.push([...at, 'change', 'inspect', id, '--json'])
    steps.push([...at, 'change', 'verify', id, '--base', mergeBase, '--head', candidate, '--json'])
  }
  steps.push([...at, 'status', '--json'])
  return steps
}

/** Exit codes a recorded step may have; anything else was a protocol failure, never posted. */
export function stepExitAllowed(argv: string[]): number[] {
  const verb = argv.slice(2, 4).join(' ')
  return verb === 'change verify' ? [0, 3] : [0]
}

/** A changed contract file in `mergeBase..candidate`: `A` added, `M` modified. */
export type ChangedContract = { path: string; status: 'A' | 'M' }

/**
 * Changed contract files in `mergeBase..candidate`, sorted by path. Only added
 * or modified `<id>.sem` files directly in `.semctx/semantic/changes/` are
 * supported: a deleted, renamed, retyped or nested contract fails closed.
 */
export async function changedContracts(
  git: Git,
  toplevel: string,
  mergeBase: string,
  candidate: string,
): Promise<ChangedContract[] | Error> {
  const args = ['diff', '--name-status', '-z', '--no-renames', mergeBase, candidate, '--', CHANGES_DIR]
  const diff = await git(toplevel, args)
  if (diff.code !== 0) return new Error(gitError(args, diff))
  const parts = diff.stdout.split('\0')
  const out: ChangedContract[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] ?? ''
    const path = parts[i + 1] ?? ''
    if (!path.endsWith('.sem')) continue
    if (path.slice(CHANGES_DIR.length).includes('/'))
      return new Error(`${path}: a change contract must sit directly in ${CHANGES_DIR}`)
    if (status !== 'A' && status !== 'M') return new Error(`${path}: change contract status ${status} is not supported`)
    out.push({ path, status })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export async function mergeBaseOf(
  git: Git,
  toplevel: string,
  baseTip: string,
  candidate: string,
): Promise<string | Error> {
  const args = ['merge-base', baseTip, candidate]
  const result = await git(toplevel, args)
  const sha = oneLine(result.stdout)
  if (result.code !== 0 || !SHA.test(sha)) return new Error(gitError(args, result))
  return sha
}

// ---------------------------------------------------------------------------
// Semctx: reading a record against the re-derived inputs
// ---------------------------------------------------------------------------

type ContractProvenance = 'author' | 'agent' | 'derived'

/** The inputs a Semctx record must bind to, re-derived from Git and the PR. */
export type SemctxExpected = {
  repository: string
  pr: number
  candidate: string
  base: string
  mergeBase: string
  contracts: string[]
  changeFiles: string[]
  /** Source-qualified retained companions, never supplied by the producer record. */
  historicalContracts: ReadonlyMap<string, ContractProvenance>
  config: { source: SemctxConfig['source']; sha256: string }
}

function parseJson(step: Step | undefined): unknown {
  if (!step) throw new Error('a native step is missing')
  try {
    return JSON.parse(step.stdout)
  } catch {
    throw new Error(`${step.argv.slice(2).join(' ')} printed no JSON`)
  }
}

function isStep(value: unknown): value is Step {
  return (
    isMap(value) &&
    Array.isArray(value.argv) &&
    value.argv.every((arg) => typeof arg === 'string') &&
    Number.isInteger(value.exit) &&
    typeof value.stdout === 'string'
  )
}

function sameList(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i])
}

/** Stable text of a JSON value, for the before/after seal comparison. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isMap(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export type ChangeResult = {
  id: string
  verdict: 'VERIFIED' | 'PARTIAL'
  lifecycle: string
  /** The named native gaps of a PARTIAL: one per warn finding (its first ref, else its kind). */
  gaps: string[]
}

/**
 * Binds a conserved Semctx record to the re-derived inputs and returns each
 * relevant change's native result. Any field that does not bind refuses as
 * `unbound`; a native result that cannot be read refuses as `unreadable`.
 */
export function readSemctxRecord(record: unknown, expected: SemctxExpected): ChangeResult[] | Refusal {
  const unbound = (error: string) => refuse('semctx', 'unbound', `the Semctx record does not bind: ${error}`)
  if (!isMap(record) || record.producer !== 'semctx' || !isMap(record.invocation) || !Array.isArray(record.native)) {
    return refuse('semctx', 'unreadable', 'the Semctx record has no producer/invocation/native parts')
  }
  const inv = record.invocation
  const fields: [keyof SemctxExpected, unknown][] = [
    ['repository', inv.repository],
    ['pr', inv.pr],
    ['candidate', inv.candidate],
    ['base', inv.base],
    ['mergeBase', inv.mergeBase],
  ]
  for (const [key, value] of fields) {
    if (value !== expected[key]) {
      return unbound(`${key} ${JSON.stringify(value)} ≠ ${JSON.stringify(expected[key])}`)
    }
  }
  if (!sameList(inv.contracts, expected.contracts)) {
    return unbound(`contracts ${JSON.stringify(inv.contracts)} ≠ changed ${JSON.stringify(expected.contracts)}`)
  }
  if (
    !isMap(inv.config) ||
    inv.config.source !== expected.config.source ||
    inv.config.sha256 !== expected.config.sha256
  ) {
    return unbound(
      `the run's Semctx configuration ${JSON.stringify(inv.config)} is not the ${expected.config.source} one in force now (sha256 ${expected.config.sha256})`,
    )
  }
  if (typeof inv.root !== 'string' || !isAbsolute(inv.root)) return unbound('no private checkout root')
  if (!isMap(inv.status) || inv.status.before !== '' || inv.status.after !== '') {
    return unbound('the private checkout was not clean before and after the run')
  }
  if (
    !Array.isArray(inv.ignored) ||
    inv.ignored.some((path) => typeof path !== 'string' || path.startsWith('.semctx/working/'))
  ) {
    return unbound('the private checkout held Semctx working state')
  }
  if (!isMap(inv.tool) || typeof inv.tool.version !== 'string' || typeof inv.tool.path !== 'string') {
    return unbound('no tool path/version')
  }
  const steps = semctxSteps(inv.root, expected.contracts, expected.mergeBase, expected.candidate)
  const native = record.native
  if (native.length !== steps.length || !native.every(isStep)) return unbound(`expected ${steps.length} native steps`)
  for (const [i, step] of native.entries()) {
    if (!sameList(step.argv, steps[i] ?? [])) return unbound(`step ${i + 1} ran ${JSON.stringify(step.argv)}`)
    if (!stepExitAllowed(step.argv).includes(step.exit)) return unbound(`step ${i + 1} exited ${step.exit}`)
  }
  try {
    const seals: string[] = []
    for (const [label, step] of [
      ['before', native[1]],
      ['after', native.at(-1)],
    ] as const) {
      const status = parseJson(step)
      if (!isMap(status) || status.verdict !== 'FRESH' || !isMap(status.freshnessSeal)) {
        return unbound(`status ${label} the run is not FRESH`)
      }
      const seal = status.freshnessSeal
      if (seal.headAtCapture !== expected.candidate || seal.indexedHeadCommit !== expected.candidate) {
        return unbound(`status ${label} the run is sealed at ${String(seal.headAtCapture)}, not ${expected.candidate}`)
      }
      if (seal.indexedRepositoryRoot !== inv.root) return unbound(`status ${label} the run indexed another root`)
      seals.push(canonical(seal))
    }
    if (seals[0] !== seals[1]) return unbound('the freshness seal changed during the run')
    const check = parseJson(native[2])
    if (!isMap(check) || check.ok !== true || !isMap(check.counts) || check.counts.errors !== 0) {
      return refuse('semctx', 'verdict', 'semantic check reports errors in the candidate model')
    }
    if (check.counts.changes !== expected.changeFiles.length) {
      return refuse(
        'semctx',
        'verdict',
        `the model declares ${String(check.counts.changes)} change(s) but the candidate commits ${expected.changeFiles.length} change file(s): each change must be the one block of its own ${CHANGES_DIR}<id>.sem`,
      )
    }
    // The clean checkout holds no active pointer, so Semctx names every non-terminal change in
    // ACTIVE_CHANGE_POINTER_MISSING: each must be committed as its own contract file.
    if (!Array.isArray(check.lifecycleFindings)) throw new Error('semantic check reports no lifecycleFindings')
    const committed = new Set(expected.changeFiles.map(changeIdOf))
    for (const finding of check.lifecycleFindings) {
      if (!isMap(finding) || typeof finding.code !== 'string')
        throw new Error('semantic check reports a malformed lifecycle finding')
      if (!finding.code.startsWith('ACTIVE_CHANGE_')) continue
      if (finding.code !== 'ACTIVE_CHANGE_POINTER_MISSING') {
        return refuse(
          'semctx',
          'unbound',
          `semantic check reports ${finding.code} in a checkout that holds no active pointer`,
        )
      }
      const ids = finding.subjectIds
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        throw new Error(`${finding.code} names no subject ids`)
      }
      const hidden = ids.filter((id) => !committed.has(id))
      if (hidden.length) {
        return refuse(
          'semctx',
          'verdict',
          `non-terminal change(s) ${hidden.join(', ')} are not committed as their own ${CHANGES_DIR}<id>.sem: a change outside its contract file escapes verification`,
        )
      }
    }
    const results: ChangeResult[] = []
    for (const [n, path] of expected.contracts.entries()) {
      const id = changeIdOf(path)
      const inspect = parseJson(native[3 + 2 * n])
      const verify = parseJson(native[4 + 2 * n])
      const result = changeResult(id, path, inspect, verify, expected)
      if ('ok' in result) return result
      results.push(result)
    }
    return results
  } catch (error) {
    return refuse('semctx', 'unreadable', errorMessage(error))
  }
}

/** Lifecycles a relevant change may land in; every other known lifecycle refuses. */
const LANDABLE: Record<string, boolean> = {
  active: true,
  partial: true,
  verified: true,
  draft: false,
  blocked: false,
  stale: false,
  superseded: false,
}

function changeResult(
  id: string,
  path: string,
  inspect: unknown,
  verify: unknown,
  expected: SemctxExpected,
): ChangeResult | Refusal {
  const name = `change ${id}`
  if (!isMap(inspect) || inspect.id !== id || !Array.isArray(inspect.sourceRefs) || !inspect.sourceRefs.length) {
    return refuse('semctx', 'unbound', `${name}: change inspect did not read a change contract named ${id}`)
  }
  if (!inspect.sourceRefs.every((ref) => isMap(ref) && ref.file === path)) {
    return refuse('semctx', 'unbound', `${name} is not declared by ${path} alone`)
  }
  if (!isMap(verify) || verify.changeId !== id || !isMap(verify.underlying)) {
    return refuse('semctx', 'unreadable', `${name}: change verify printed no result for it`)
  }
  const underlying = verify.underlying
  if (
    underlying.head !== expected.candidate ||
    underlying.mergeBase !== expected.mergeBase ||
    underlying.base !== expected.mergeBase
  ) {
    return refuse(
      'semctx',
      'unbound',
      `${name}: verified range ${String(underlying.base)}..${String(underlying.head)} is not ${expected.mergeBase}..${expected.candidate}`,
    )
  }
  const lifecycle = verify.lifecycle
  if (typeof lifecycle !== 'string' || !(lifecycle in LANDABLE) || lifecycle !== inspect.lifecycle) {
    return refuse('semctx', 'unreadable', `${name}: unknown lifecycle ${JSON.stringify(lifecycle)}`)
  }
  const historicalProvenance = expected.historicalContracts.get(path)
  if (lifecycle === 'superseded' && historicalProvenance !== undefined && inspect.provenance !== historicalProvenance) {
    return refuse('semctx', 'unbound', `${name}: native provenance does not match its retained Git source`)
  }
  if (!LANDABLE[lifecycle] && !(lifecycle === 'superseded' && historicalProvenance !== undefined)) {
    return refuse(
      'semctx',
      'verdict',
      `${name} is ${lifecycle}; only an active, partial or verified change, or a source-qualified retained companion, lands`,
    )
  }
  const verdict = verify.verdict
  const findings = Array.isArray(verify.findings) ? verify.findings : null
  const pending = Array.isArray(verify.pendingEvidence) ? verify.pendingEvidence : null
  const unknowns = Array.isArray(verify.openUnknowns) ? verify.openUnknowns : null
  const stale = Array.isArray(verify.stale) ? verify.stale : null
  const preserved = Array.isArray(verify.preserved) ? verify.preserved : null
  const proved = Array.isArray(verify.provedEvidence) ? verify.provedEvidence : null
  if (!findings || !pending || !unknowns || !stale || !preserved || !proved || !findings.every(isMap)) {
    return refuse('semctx', 'unreadable', `${name}: change verify result is incomplete`)
  }
  if (verdict === 'BLOCKED' || verdict === 'STALE') {
    const why = findings
      .filter((finding) => finding.severity !== 'warn')
      .map((finding) => String(finding.message))
      .join('; ')
    return refuse('semctx', 'verdict', `${name} is ${verdict}${why ? `: ${why}` : ''}`)
  }
  const requires = Array.isArray(inspect.requiresEvidence) ? inspect.requiresEvidence : []
  if (verdict === 'VERIFIED') {
    const contradiction = [
      findings.length && `${findings.length} finding(s)`,
      pending.length && `${pending.length} pending evidence`,
      unknowns.length && `${unknowns.length} open unknown(s)`,
      stale.length && `${stale.length} stale link(s)`,
      underlying.verdict !== 'PASS' && `impact ${String(underlying.verdict)}`,
      preserved.some((item) => !isMap(item) || (item.state !== 'proved' && item.state !== 'untouched')) &&
        'an invariant that is neither proved nor untouched',
    ].filter(Boolean)
    if (contradiction.length) {
      return refuse(
        'semctx',
        'verdict',
        `${name} reports VERIFIED with ${contradiction.join(', ')}: contradictory result`,
      )
    }
    if (!requires.length) {
      return refuse(
        'semctx',
        'verdict',
        `${name} is VERIFIED but requires no evidence: a vacuous result proves nothing — declare its evidence`,
      )
    }
    const provedIds = proved.map((item) => (isMap(item) ? item.id : null))
    if (!requires.every((evidence) => provedIds.includes(evidence))) {
      return refuse('semctx', 'verdict', `${name} is VERIFIED but not every required evidence is proved`)
    }
    return { id, verdict, lifecycle, gaps: [] }
  }
  if (verdict === 'PARTIAL') {
    if (lifecycle === 'verified') {
      return refuse(
        'semctx',
        'verdict',
        `${name} is closed as verified while its result is PARTIAL: a PARTIAL stays partial`,
      )
    }
    const contradiction = [
      findings.some((finding) => finding.severity !== 'warn') && 'a blocking or stale finding',
      stale.length && `${stale.length} stale link(s)`,
      underlying.verdict !== 'PASS' && underlying.verdict !== 'WARN' && `impact ${String(underlying.verdict)}`,
    ].filter(Boolean)
    if (contradiction.length) {
      return refuse('semctx', 'verdict', `${name} is PARTIAL with ${contradiction.join(', ')}: contradictory result`)
    }
    // Each pending evidence and open unknown is a gap even when no finding mirrors it.
    const open = [...pending, ...unknowns].map((item) => (isMap(item) && typeof item.id === 'string' ? item.id : ''))
    if (open.some((gap) => !gap)) {
      return refuse('semctx', 'unreadable', `${name}: a pending evidence or open unknown names no id`)
    }
    const gaps = [
      ...findings.map((finding) =>
        Array.isArray(finding.refs) && typeof finding.refs[0] === 'string' && finding.refs[0]
          ? finding.refs[0]
          : String(finding.kind ?? ''),
      ),
      ...open,
    ]
    if (!gaps.length || gaps.some((gap) => !gap)) {
      return refuse('semctx', 'unjustified', `${name} is PARTIAL with no named gap: a PARTIAL must name each gap`)
    }
    return { id, verdict, lifecycle, gaps: [...new Set(gaps)] }
  }
  return refuse('semctx', 'unreadable', `${name}: unknown verdict ${JSON.stringify(verdict)}`)
}

// ---------------------------------------------------------------------------
// PARTIAL justification: the selected PR body
// ---------------------------------------------------------------------------

const ID_CHAR = String.raw`[\w.:/-]`
const NO_TEST_CELL = /^⚠\s*NO TEST\s*(?:—|--|-)\s*(.+?)\s*$/

/** The NO TEST reasons the body's table rows give `gap`, from the rows whose first cell names it. */
export function noTestReasons(body: string, gap: string): string[] {
  const named = new RegExp(`(?<!${ID_CHAR})${gap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${ID_CHAR})`)
  const reasons: string[] = []
  for (const line of body.split('\n')) {
    const row = line.trim()
    if (!row.startsWith('|') || !row.endsWith('|')) continue
    const cells = row
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
    if (!named.test(cells[0] ?? '')) continue
    const reason = (cells.at(-1) ?? '').match(NO_TEST_CELL)?.[1]
    if (reason !== undefined) reasons.push(reason)
  }
  return reasons
}

export type BrowserCheck = { steps: string; url: string; observed: string }

const BROWSER_FIELDS: Record<string, keyof BrowserCheck> = { steps: 'steps', url: 'url', observed: 'observed' }

/** The body's `Browser check <gap>` block (the gap bare or in backticks): its Steps, URL and Observed lines. */
export function browserCheck(body: string, gap: string): Partial<BrowserCheck> | null {
  const lines = body.split('\n')
  const heading = /^(?:#{1,6}\s*)?Browser check\s+(?:`([^`]+)`|([^\s`:]+))\s*:?\s*$/i
  const start = lines.findIndex((line) => {
    const match = line.trim().match(heading)
    return (match?.[1] ?? match?.[2]) === gap
  })
  if (start < 0) return null
  const out: Partial<BrowserCheck> = {}
  for (const line of lines.slice(start + 1)) {
    const text = line.trim()
    if (/^#{1,6}\s/.test(text) || heading.test(text)) break
    const field = text.match(/^[-*]\s*(Steps|URL|Observed)\s*:\s*(.*)$/i)
    const key = BROWSER_FIELDS[(field?.[1] ?? '').toLowerCase()]
    if (key) out[key] ??= field?.[2] ?? ''
  }
  return out
}

/** An http(s) URL. WHATWG parsing already rejects an http(s) URL with an empty host. */
function validUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Whether `.dev/stack.yml` text declares a non-blank `commands.test_e2e`. Throws on unreadable YAML. */
export function declaresE2e(stackText: string): boolean {
  if (!stackText.trim()) return false
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
    throw new Error('reading .dev/stack.yml needs bun >= 1.2.21 (Bun.YAML)')
  }
  const doc = Bun.YAML.parse(stackText)
  if (doc == null) return false
  if (!isMap(doc)) throw new Error('the document is not a map')
  const commands = doc.commands
  if (commands == null) return false
  if (!isMap(commands)) throw new Error('commands is not a map')
  const e2e = commands.test_e2e
  return typeof e2e === 'string' ? e2e.trim().length > 0 : e2e != null
}

export type Justification = { gap: string; reason: NoTestReason }

/**
 * Every PARTIAL gap needs exactly one NO TEST reason from the closed enum in the
 * selected PR body. `ui-manual-only` is refused when the base or the candidate
 * commits an e2e command; otherwise the body carries that gap's browser check with nonblank
 * steps, an http(s) URL and a nonblank observed result.
 */
export function justifyGaps(results: ChangeResult[], body: string, e2e: () => boolean): Refusal | Justification[] {
  const out: Justification[] = []
  for (const result of results) {
    for (const gap of result.gaps) {
      const reasons = [...new Set(noTestReasons(body, gap))]
      if (reasons.length === 0) {
        return refuse('semctx', 'unjustified', `change ${result.id}: gap ${gap} has no NO TEST row in the PR body`)
      }
      if (reasons.length > 1) {
        return refuse(
          'semctx',
          'unjustified',
          `change ${result.id}: gap ${gap} has conflicting NO TEST rows (${reasons.join(', ')})`,
        )
      }
      const written = reasons[0] ?? ''
      const reason = NO_TEST_REASONS.find((known) => known === written)
      if (!reason) {
        return refuse(
          'semctx',
          'unjustified',
          `change ${result.id}: gap ${gap} gives NO TEST reason ${JSON.stringify(written)}, outside ${NO_TEST_REASONS.join(', ')}`,
        )
      }
      if (reason === 'ui-manual-only') {
        if (e2e()) {
          return refuse(
            'semctx',
            'unjustified',
            `change ${result.id}: gap ${gap} is ui-manual-only but ${STACK} on the base or the candidate declares commands.test_e2e — that command is the proof`,
          )
        }
        const check = browserCheck(body, gap)
        const missing = [
          !check && 'the browser check block',
          check && !check.steps?.trim() && 'steps',
          check && !validUrl(check.url?.trim() ?? '') && 'a valid http(s) URL',
          check && !check.observed?.trim() && 'the observed result',
        ].filter(Boolean)
        if (missing.length) {
          return refuse(
            'semctx',
            'unjustified',
            `change ${result.id}: ui-manual-only gap ${gap} lacks ${missing.join(', ')} in the PR body`,
          )
        }
      }
      out.push({ gap, reason })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export type SemctxOutcome =
  | 'absent'
  | {
      verdict: 'VERIFIED' | 'PARTIAL'
      changes: { id: string; verdict: 'VERIFIED' | 'PARTIAL' }[]
      gaps: Justification[]
    }
export type ProofSummary = { semctx: SemctxOutcome; assertledger: 'not-applicable' | 'detection' }
export type Admission = { ok: true; proof: ProofSummary } | Refusal
/** Approval publication time and the retained exact review-input digest are separate constraints. */
export type Target = {
  pr: number
  candidate: string
  base: string | undefined
  baseTip: string
  reviewedAt: string | null
  reviewInput: string | null
  /** Approved mandate pins. Production landing passes this; omission is not approval. */
  proofPins?: readonly ProofConfigPin[]
}
export type Deps = {
  gh: Gh
  git: Git /** Test injection. Production omits this and calls the shared resolver. */
  semantic?: ProofSemanticContext
}
type Read = { repository: string }
type PrBody = { body: string; lastEditedAt: string | null }
type ReviewSnapshot = {
  ok: true
  input: string | null
  body: PrBody | null
  facts: CandidateFacts
  read: Read | null
  semctx: SelectedRecord | null
  assertledger: SelectedRecord | null
}

/** Confirmed semantic context. Proof hashes this; it does not resolve bindings. */
export type ProofSemanticContext =
  | {
      mode: 'bound'
      bindingId: string
      scope: { repository: string; target: string }
      acceptedSpec: { reference: string; body: string; digest: string }
      /** Mandate, editorial, and accept-material provenance. Not pause/resume/control. */
      chain: readonly unknown[]
      /** Mandate ref plus applied assessment/acceptance refs. Identity only, not action rights. */
      sourceRefs: readonly unknown[]
      requirements: readonly string[]
      config: { productVersion: string; version: string; digest: string; serialized: string }
    }
  | {
      mode: 'standalone'
      /** Explicit discovered Spec. Null is a complete no-tracker review, not a fallback. */
      discoveredSpec: { reference: string; body: string; digest: string } | null
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function scopeOf(value: unknown): { repository: string; target: string } | null {
  if (!isRecord(value) || typeof value.repository !== 'string' || typeof value.target !== 'string') return null
  if (value.repository.length === 0 || value.target.length === 0) return null
  return { repository: value.repository, target: value.target }
}

function specBytes(value: unknown, label: string): { reference: string; body: string; digest: string } | Refusal {
  if (
    !isRecord(value) ||
    typeof value.body !== 'string' ||
    typeof value.reference !== 'string' ||
    value.reference.length === 0
  ) {
    return refuse('candidate', 'unreadable', `${label} has no reference and body`)
  }
  if (typeof value.digest !== 'string' || value.digest.length === 0)
    return refuse('candidate', 'unreadable', `${label} digest is missing`)
  if (value.digest !== sha256(value.body))
    return refuse('candidate', 'unreadable', `${label} digest does not match its body`)
  return { reference: value.reference, body: value.body, digest: value.digest }
}

function chainCanon(chain: unknown): unknown[] | Refusal {
  if (!Array.isArray(chain) || chain.length === 0)
    return refuse('candidate', 'unreadable', 'accepted Spec chain is missing')
  const out: unknown[] = []
  for (const item of chain) {
    if (
      !isRecord(item) ||
      typeof item.kind !== 'string' ||
      typeof item.recordId !== 'string' ||
      item.recordId.length === 0
    ) {
      return refuse('candidate', 'unreadable', 'accepted Spec chain ref is unreadable')
    }
    const scope = scopeOf(item.scope)
    if (!scope) return refuse('candidate', 'unreadable', 'accepted Spec chain ref has no scope')
    if (item.kind === 'mandate') {
      if (typeof item.specDigest !== 'string')
        return refuse('candidate', 'unreadable', 'mandate chain ref has no spec digest')
      out.push(['mandate', item.recordId, scope.repository, scope.target, item.specDigest])
    } else if (item.kind === 'editorial') {
      if (typeof item.acceptedDigest !== 'string' || typeof item.currentDigest !== 'string') {
        return refuse('candidate', 'unreadable', 'editorial chain ref has no digests')
      }
      out.push(['editorial', item.recordId, scope.repository, scope.target, item.acceptedDigest, item.currentDigest])
    } else if (item.kind === 'accept-material') {
      if (typeof item.specDigest !== 'string' || !isRecord(item.assessment)) {
        return refuse('candidate', 'unreadable', 'accept-material chain ref has no assessment')
      }
      const assessment = scopeOf(item.assessment.scope)
      if (!assessment || typeof item.assessment.recordId !== 'string' || typeof item.assessment.kind !== 'string') {
        return refuse('candidate', 'unreadable', 'accept-material assessment ref is unreadable')
      }
      out.push([
        'accept-material',
        item.recordId,
        scope.repository,
        scope.target,
        item.specDigest,
        assessment.repository,
        assessment.target,
        item.assessment.recordId,
        item.assessment.kind,
      ])
    } else {
      return refuse('candidate', 'unreadable', `accepted Spec chain ref kind ${item.kind} is not a spec acceptance`)
    }
  }
  return out
}

/** External record identity only. These refs are not permissions or action rights. */
function sourceRefsCanon(refs: unknown): unknown[] | Refusal {
  if (!Array.isArray(refs) || refs.length === 0)
    return refuse('candidate', 'unreadable', 'accepted Spec source refs are missing')
  const out: unknown[] = []
  for (const item of refs) {
    if (
      !isRecord(item) ||
      typeof item.recordId !== 'string' ||
      item.recordId.length === 0 ||
      typeof item.kind !== 'string' ||
      item.kind.length === 0
    ) {
      return refuse('candidate', 'unreadable', 'accepted Spec source ref is unreadable')
    }
    if (Object.keys(item).some((key) => key !== 'scope' && key !== 'recordId' && key !== 'kind')) {
      return refuse('candidate', 'unreadable', 'accepted Spec source ref is not an external record identity')
    }
    const scope = scopeOf(item.scope)
    if (!scope) return refuse('candidate', 'unreadable', 'accepted Spec source ref has no scope')
    out.push([scope.repository, scope.target, item.recordId, item.kind])
  }
  return out
}

function configOf(
  value: Record<string, unknown>,
): { productVersion: string; version: string; digest: string; serialized: string } | Refusal {
  const raw = isRecord(value.effectiveConfig)
    ? value.effectiveConfig
    : isRecord(value.configIdentity)
      ? value.configIdentity
      : null
  if (
    !raw ||
    typeof raw.productVersion !== 'string' ||
    typeof raw.version !== 'string' ||
    typeof raw.digest !== 'string' ||
    typeof raw.serialized !== 'string'
  ) {
    return refuse('candidate', 'unreadable', 'bound review config identity is missing')
  }
  return {
    productVersion: raw.productVersion,
    version: raw.version,
    digest: raw.digest,
    serialized: raw.serialized,
  }
}

/** Project the shared resolver value. A partial binding is a refusal, never standalone. */
export function proofSemanticContext(value: unknown): ProofSemanticContext | Refusal {
  if (!isRecord(value) || (value.mode !== 'bound' && value.mode !== 'standalone')) {
    return refuse('candidate', 'unreadable', 'review semantic context mode is missing')
  }
  if (value.mode === 'standalone') {
    if (
      value.binding !== null ||
      value.acceptedSpec !== null ||
      (value.effectiveConfig !== null && value.effectiveConfig !== undefined) ||
      (value.configIdentity !== null && value.configIdentity !== undefined)
    ) {
      return refuse('candidate', 'unreadable', 'a partial workflow binding is not a standalone review')
    }
    if (value.currentSpec === null) return { mode: 'standalone', discoveredSpec: null }
    const discovered = specBytes(value.currentSpec, 'discovered Spec')
    if ('ok' in discovered) return discovered
    return { mode: 'standalone', discoveredSpec: discovered }
  }
  if (!isRecord(value.binding) || typeof value.binding.recordId !== 'string' || value.binding.recordId.length === 0) {
    return refuse('candidate', 'unreadable', 'bound review has no binding record')
  }
  const scope = scopeOf(value.binding.scope)
  if (!scope) return refuse('candidate', 'unreadable', 'bound review has no scope')
  const accepted = specBytes(value.acceptedSpec, 'accepted Spec')
  if ('ok' in accepted) return accepted
  const chain = chainCanon(isRecord(value.acceptedSpec) ? value.acceptedSpec.chain : undefined)
  if ('ok' in chain) return chain
  const sourceRefs = sourceRefsCanon(isRecord(value.acceptedSpec) ? value.acceptedSpec.sourceRefs : undefined)
  if ('ok' in sourceRefs) return sourceRefs
  if (
    !Array.isArray(value.additionalRequirements) ||
    value.additionalRequirements.some((item) => typeof item !== 'string')
  ) {
    return refuse('candidate', 'unreadable', 'bound review requirements are not strings')
  }
  const config = configOf(value)
  if ('ok' in config) return config
  return {
    mode: 'bound',
    bindingId: value.binding.recordId,
    scope,
    acceptedSpec: accepted,
    chain,
    sourceRefs,
    requirements: value.additionalRequirements,
    config,
  }
}

/**
 * The only semantic slot supplied to the model and to `hashReviewInput`.
 * Pause, resume, control, review count, labels, and lastEditedAt are absent.
 * Bound reviews hash the accepted Spec, not the live issue body. `sourceRefs`
 * are external-record identity, not action rights and not a second copy of `chain`.
 */
export function reviewSemanticCanon(semantic: ProofSemanticContext): string {
  if (semantic.mode === 'standalone') {
    return JSON.stringify(
      semantic.discoveredSpec === null
        ? ['standalone', null]
        : [
            'standalone',
            semantic.discoveredSpec.reference,
            semantic.discoveredSpec.body,
            semantic.discoveredSpec.digest,
          ],
    )
  }
  return JSON.stringify([
    'bound',
    semantic.bindingId,
    semantic.scope.repository,
    semantic.scope.target,
    semantic.acceptedSpec.reference,
    semantic.acceptedSpec.body,
    semantic.acceptedSpec.digest,
    semantic.chain,
    semantic.sourceRefs,
    [...semantic.requirements],
    semantic.config.productVersion,
    semantic.config.version,
    semantic.config.digest,
    semantic.config.serialized,
  ])
}

/** Exact observed bytes, native publication identities, and the shared semantic canon. */
export function hashReviewInput(
  repository: string,
  target: Pick<Target, 'pr' | 'candidate'>,
  body: PrBody,
  semctx: PrComment[] | null,
  assertledger: PrComment[] | null,
  semantic: ProofSemanticContext,
): string {
  const parts = (run: PrComment[] | null) =>
    run?.map((part) => [part.id, part.body, part.createdAt, part.updatedAt]) ?? null
  const bytes = JSON.stringify([
    'omp-build:review-input/2',
    repository,
    target.pr,
    target.candidate,
    [body.body, body.lastEditedAt],
    parts(semctx),
    parts(assertledger),
    reviewSemanticCanon(semantic),
  ])
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

/** The producer command an admission refusal names; run in the normal workflow, never by admission. */
export function acquireCommand(pr: number, extra = ''): string {
  const script = new URL('./proof-acquire.ts', import.meta.url).pathname
  return `bun '${script.replace(/'/g, `'\\''`)}' --pr ${pr}${extra}`
}

/** `key` of a JSON object answer; undefined when the answer is not an object. */
function jsonField(raw: string, key: string): unknown {
  const data: unknown = JSON.parse(raw)
  return isMap(data) ? data[key] : undefined
}

export async function repositoryOf(gh: Gh, cwd: string, url?: string): Promise<string> {
  const raw = await gh(cwd, ['repo', 'view', ...(url === undefined ? [] : [url]), '--json', 'nameWithOwner'])
  const name = jsonField(raw, 'nameWithOwner')
  if (typeof name !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(name)) {
    throw new Error(`gh repo view returned no nameWithOwner — ${raw.slice(0, 200)}`)
  }
  return name
}

/** Native close sorts flat file links; no other source formatting is equivalent here. */
function sortFileLinkRuns(lines: string[]): void {
  const fileLink = /^ {2}link: file:\S[^\r\n]*\r?$/
  for (let start = 0; start < lines.length; ) {
    if (!fileLink.test(lines[start] ?? '')) {
      start++
      continue
    }
    let end = start + 1
    while (end < lines.length && fileLink.test(lines[end] ?? '')) end++
    if (end - start > 1) {
      const sorted = lines.slice(start, end).sort()
      for (let index = start; index < end; index++) lines[index] = sorted[index - start] as string
    }
    start = end
  }
}

/** A bounded source transition, not a replacement Semctx parser or transmission claim. */
function retainedProvenance(before: string, after: string, id: string): ContractProvenance | undefined {
  const original = before.split('\n')
  const candidate = after.split('\n')
  if (original.length !== candidate.length) return undefined
  let headerSeen = false
  let status: { line: number; replacement: string } | undefined
  let provenance: ContractProvenance | undefined
  for (const [index, line] of original.entries()) {
    const content = line.trim()
    if (content === '' || content.startsWith('#')) continue
    if (line[0] !== ' ' && line[0] !== '\t') {
      if (headerSeen || /^change\s+(\S+)\s*$/.exec(line)?.[1] !== id) return undefined
      headerSeen = true
      continue
    }
    if (!headerSeen) return undefined
    const colon = line.indexOf(':')
    if (colon < 0) continue
    // Native field names and values use trim(), including non-ASCII whitespace.
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1)
    const value = raw.trim()
    if (key === 'status') {
      if (status || (value !== 'active' && value !== 'partial' && value !== 'verified')) return undefined
      status = { line: index, replacement: line.slice(0, colon + 1) + raw.replace(value, 'superseded') }
    } else if (key === 'provenance') {
      if (provenance !== undefined || (value !== 'author' && value !== 'agent' && value !== 'derived')) return undefined
      provenance = value
    }
  }
  if (!status || provenance === undefined) return undefined
  original[status.line] = status.replacement
  sortFileLinkRuns(original)
  sortFileLinkRuns(candidate)
  return original.every((line, index) => line === candidate[index]) ? provenance : undefined
}

/**
 * The Semctx inputs admission and acquisition derive the same way from Git and
 * the facts. The candidate must add a change contract of its own. Modified
 * companions remain verified beside it; only conserved source transitions qualify as history.
 */
export async function semctxInputs(
  facts: CandidateFacts,
  git: Git,
): Promise<Pick<SemctxExpected, 'base' | 'mergeBase' | 'contracts' | 'historicalContracts' | 'config'> | Refusal> {
  if (!facts.config) return refuse('semctx', 'unreadable', `candidate ${facts.candidate} has no Semctx configuration`)
  const mergeBase = await mergeBaseOf(git, facts.toplevel, facts.baseTip, facts.candidate)
  if (mergeBase instanceof Error)
    return refuse('semctx', 'unreadable', `merge-base with origin/${facts.base}: ${mergeBase.message}`)
  const changed = await changedContracts(git, facts.toplevel, mergeBase, facts.candidate)
  if (changed instanceof Error) return refuse('semctx', 'unbound', changed.message)
  if (!changed.some((contract) => contract.status === 'A')) {
    const modified = changed.map((contract) => contract.path)
    return refuse(
      'semctx',
      'missing',
      `candidate ${facts.candidate} adds no ${CHANGES_DIR}<id>.sem since ${mergeBase}${modified.length ? ` (it only modifies ${modified.join(', ')}, which cannot stand in for this ticket's own)` : ''}: open the change contract for this ticket (skills/feature/proof.ts semctxInputs)`,
    )
  }
  const historicalContracts = new Map<string, ContractProvenance>()
  for (const contract of changed) {
    if (contract.status !== 'M') continue
    const args = ['rev-parse', `${mergeBase}:${contract.path}`, `${facts.candidate}:${contract.path}`]
    const resolved = await git(facts.toplevel, args)
    const oids = oneLine(resolved.stdout).split('\n')
    const [beforeOid, afterOid] = oids
    if (
      resolved.code !== 0 ||
      oids.length !== 2 ||
      !beforeOid ||
      !afterOid ||
      !SHA.test(beforeOid) ||
      !SHA.test(afterOid)
    )
      return refuse(
        'semctx',
        'unbound',
        `${contract.path}: cannot resolve historical Git blobs — ${gitError(args, resolved)}`,
      )
    const sources = await Promise.all([
      git(facts.toplevel, ['cat-file', 'blob', beforeOid]),
      git(facts.toplevel, ['cat-file', 'blob', afterOid]),
    ])
    for (const source of sources) {
      if (source.code !== 0)
        return refuse('semctx', 'unbound', `${contract.path}: cannot read historical Git blob — ${source.stderr}`)
    }
    const provenance = retainedProvenance(sources[0].stdout, sources[1].stdout, changeIdOf(contract.path))
    if (provenance === undefined) continue
    for (const [oid, source] of [
      [beforeOid, sources[0]],
      [afterOid, sources[1]],
    ] as const) {
      const roundTrip = createHash('sha1')
        .update(`blob ${Buffer.byteLength(source.stdout, 'utf8')}\0`)
        .update(source.stdout, 'utf8')
        .digest('hex')
      if (roundTrip !== oid)
        return refuse('semctx', 'unbound', `${contract.path}: Git blob ${oid} cannot be read losslessly as UTF-8`)
    }
    historicalContracts.set(contract.path, provenance)
  }
  const contracts = changed.map((contract) => contract.path)
  const config = { source: facts.config.source, sha256: facts.config.sha256 }
  return { base: facts.base, mergeBase, contracts, historicalContracts, config }
}

/** GitHub's native UTC instants, including a real calendar date; no inferred timestamp. */
function nativeInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !NATIVE_INSTANT.test(value)) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return null
  return time
}

/** Acquisition only creates parts: a readable native revision invalidates reuse. */
export function recordIntegrity(parts: PrComment[], producer: Producer): Refusal | null {
  for (const [index, part] of parts.entries()) {
    const created = nativeInstant(part.createdAt)
    const revised = nativeInstant(part.updatedAt)
    if (created === null || revised === null || revised < created) {
      return refuse(
        producer,
        'unreadable',
        `proof part ${index + 1}/${parts.length} has unreadable native creation/revision facts (${JSON.stringify(part.createdAt)}, ${JSON.stringify(part.updatedAt)}); obtain readable GitHub metadata before re-review`,
      )
    }
    if (revised !== created) {
      return refuse(
        producer,
        'unbound',
        `proof part ${index + 1}/${parts.length} was revised after publication; acquire a new producer record, then review the head (skills/feature/proof.ts recordIntegrity)`,
      )
    }
  }
  return null
}

/** Every selected native part was published, unmodified, before this approval. */
function reviewedRecord(parts: PrComment[], target: Target, producer: Producer): Refusal | null {
  const integrity = recordIntegrity(parts, producer)
  if (integrity) return integrity
  const approved = nativeInstant(target.reviewedAt)
  if (approved === null)
    return refuse(
      producer,
      'unjustified',
      `the review of candidate ${target.candidate} has no readable native creation time: re-review the head (skills/feature/proof.ts reviewedRecord)`,
    )
  for (const [index, part] of parts.entries()) {
    const created = nativeInstant(part.createdAt)
    if (created === null || created >= approved) {
      return refuse(
        producer,
        'unjustified',
        `proof part ${index + 1}/${parts.length} was published at ${part.createdAt}, not before approving review ${target.reviewedAt}: re-review the same head (skills/feature/proof.ts reviewedRecord), reuse the unmodified record without a producer`,
      )
    }
  }
  return null
}

const PR_BODY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { body lastEditedAt }
  }
}`

/** Current body and native edit metadata from one response, without tightening the existing date policy. */
async function readPrBody(cwd: string, pr: number, gh: Gh, repository: string): Promise<PrBody> {
  const [owner, name] = repository.split('/')
  const raw = await gh(cwd, [
    'api',
    'graphql',
    '-f',
    `query=${PR_BODY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${pr}`,
  ])
  const data = jsonField(raw, 'data')
  const repo = isMap(data) ? data.repository : undefined
  const pull = isMap(repo) ? repo.pullRequest : undefined
  const body = isMap(pull) ? pull.body : undefined
  const edited = isMap(pull) ? pull.lastEditedAt : undefined
  if (
    typeof body !== 'string' ||
    (edited !== null && (typeof edited !== 'string' || Number.isNaN(Date.parse(edited))))
  ) {
    throw new Error(`the body of PR #${pr} could not be read — ${raw.slice(0, 200)}`)
  }
  return { body, lastEditedAt: edited }
}

/** Preserve the existing PARTIAL body chronology policy against the captured body. */
function reviewedBody(target: Target, pull: PrBody): { body: string } | Refusal {
  const { body, lastEditedAt: edited } = pull
  if (edited === null) return { body }
  const reviewed = target.reviewedAt === null ? Number.NaN : Date.parse(target.reviewedAt)
  if (!(Date.parse(edited) < reviewed)) {
    return refuse(
      'semctx',
      'unjustified',
      `the PR #${target.pr} body that justifies the PARTIAL gaps was edited at ${edited}, not before the review record that approved ${target.candidate} (${target.reviewedAt ?? 'no time'}): that review never judged it — re-review the head (skills/feature/proof.ts reviewedBody)`,
    )
  }
  return { body }
}

async function admitSemctx(
  facts: CandidateFacts,
  target: Target,
  deps: Deps,
  read: Read,
  found: SelectedRecord,
  capturedBody: PrBody,
): Promise<SemctxOutcome | Refusal> {
  const inputs = await semctxInputs(facts, deps.git)
  if ('ok' in inputs) return inputs
  const results = readSemctxRecord(found.record, {
    repository: read.repository,
    pr: target.pr,
    candidate: target.candidate,
    ...inputs,
    changeFiles: facts.changeFiles,
  })
  if ('ok' in results) return results
  const chronology = reviewedRecord(found.parts, target, 'semctx')
  if (chronology) return chronology
  const changes = results.map(({ id, verdict }) => ({ id, verdict }))
  if (results.every((result) => result.verdict === 'VERIFIED')) return { verdict: 'VERIFIED', changes, gaps: [] }
  const pull = reviewedBody(target, capturedBody)
  if ('ok' in pull) return pull
  const { body } = pull
  // The base's or the candidate's `test_e2e` makes it the proof: deleting it in the PR exempts nothing.
  let e2e: boolean | Error = false
  for (const { at, entry } of facts.stacks) {
    try {
      if (declaresE2e(await blob(deps.git, facts.toplevel, entry))) e2e = true
    } catch (error) {
      e2e = new Error(`${STACK} at ${at} cannot be read: ${errorMessage(error)}`)
      break
    }
  }
  let gaps: Refusal | Justification[]
  try {
    gaps = justifyGaps(results, body, () => {
      if (e2e instanceof Error) throw e2e
      return e2e
    })
  } catch (error) {
    return refuse('semctx', 'unreadable', errorMessage(error))
  }
  if ('ok' in gaps) return gaps
  return { verdict: 'PARTIAL', changes, gaps }
}

// ---------------------------------------------------------------------------
// assertledger: fix tickets of repositories with an adapter
// ---------------------------------------------------------------------------

const CLOSING_ISSUES = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefName
      closingIssuesReferences(first: 25) {
        totalCount
        nodes { number title labels(first: 50) { totalCount nodes { name } } issueType { name } }
      }
    }
  }
}`

/** The ticket a head branch names (`<type>/<N>-<slug>`), with the same signals a closing reference carries. */
const NAMED_TICKET = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number title labels(first: 50) { totalCount nodes { name } } issueType { name } }
  }
}`

/** A closing issue node's type signals, or null when the node is not readable as one. */
function signalsOf(node: unknown): TicketSignals | null {
  if (!isMap(node) || typeof node.title !== 'string' || !isMap(node.labels) || !('issueType' in node)) return null
  const labels = node.labels.nodes
  if (!Array.isArray(labels) || node.labels.totalCount !== labels.length) return null
  const names = labels.map((label) => (isMap(label) && typeof label.name === 'string' ? label.name : null))
  const type = node.issueType
  const issueType = isMap(type) && typeof type.name === 'string' ? type.name : null
  if (names.includes(null) || (type !== null && issueType === null)) return null
  return { title: node.title, labels: names.filter((label) => label !== null), issueType }
}

/**
 * Whether the assertledger requirement applies: the base or the candidate
 * declares an `assertledger.config.json` with an `adapter`, and the selected PR
 * is a fix (`fixKind`: its head branch, or the title, labels or org issue type
 * of a closing issue or of the ticket the head branch names), all read from
 * their sources. GitHub links closing keywords only for a PR into the default
 * branch, so the named ticket is read even when nothing closes it. An unreadable
 * declaration refuses, an unreadable closing list or named ticket throws, and a
 * PR whose type nothing establishes refuses.
 */
export async function assertledgerApplies(
  cwd: string,
  facts: CandidateFacts,
  target: Pick<Target, 'pr'>,
  deps: { gh: Gh; git: Git },
  repository: string,
): Promise<boolean | Refusal> {
  if (!facts.adapters.length) return false
  for (const { at, entry } of facts.adapters) {
    let config: unknown
    try {
      config = JSON.parse(await blob(deps.git, facts.toplevel, entry))
    } catch (error) {
      return refuse('assertledger', 'unreadable', `${ASSERTLEDGER_CONFIG} at ${at}: ${errorMessage(error)}`)
    }
    if (!isMap(config) || !isMap(config.adapter)) {
      return refuse('assertledger', 'ambiguous', `${ASSERTLEDGER_CONFIG} at ${at} declares no adapter`)
    }
  }
  const adapter = facts.adapters.map(({ at, entry }) => `${entry.path} at ${at}`).join(', ')
  const [owner, name] = repository.split('/')
  const raw = await deps.gh(cwd, [
    'api',
    'graphql',
    '-f',
    `query=${CLOSING_ISSUES}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${target.pr}`,
  ])
  const data = jsonField(raw, 'data')
  const repo = isMap(data) ? data.repository : undefined
  const pull = isMap(repo) ? repo.pullRequest : undefined
  const closing = isMap(pull) ? pull.closingIssuesReferences : undefined
  const nodes = isMap(closing) && Array.isArray(closing.nodes) ? closing.nodes : null
  const tickets = nodes?.map(signalsOf) ?? []
  if (
    !isMap(pull) ||
    typeof pull.headRefName !== 'string' ||
    !isMap(closing) ||
    !nodes ||
    closing.totalCount !== nodes.length ||
    tickets.includes(null)
  ) {
    throw new Error(`the closing issues of PR #${target.pr} could not be read — ${raw.slice(0, 200)}`)
  }
  const signals = tickets.filter((ticket) => ticket !== null)
  const named = ticketOfBranch(pull.headRefName)
  if (named !== null && !nodes.some((node) => isMap(node) && node.number === named)) {
    const read = await deps.gh(cwd, [
      'api',
      'graphql',
      '-f',
      `query=${NAMED_TICKET}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${named}`,
    ])
    const found = jsonField(read, 'data')
    const issue = isMap(found) && isMap(found.repository) ? signalsOf(found.repository.issue) : null
    if (!issue) {
      throw new Error(
        `issue #${named}, which branch ${JSON.stringify(pull.headRefName)} names, could not be read — ${read.slice(0, 200)}`,
      )
    }
    signals.push(issue)
  }
  const kind = fixKind(pull.headRefName, signals)
  if (kind === 'unknown') {
    return refuse(
      'assertledger',
      'unreadable',
      `PR #${target.pr} (branch ${JSON.stringify(pull.headRefName)}, closing ${nodes.length} issue(s)) establishes no ticket type: whether ${adapter} owes a detection is unknown — type the ticket or name the branch <type>/<N>-<slug>`,
    )
  }
  return kind === 'fix'
}

export type AssertledgerInvocation = {
  repository: string
  pr: number
  candidate: string
  /** The private snapshot actually replayed; the same bytes are `native.manifest`. */
  manifest: string
  tool: { path: string; version: string }
}
export type AssertledgerRecord = {
  producer: 'assertledger'
  invocation: AssertledgerInvocation
  native: { manifest: string; replay: Step }
}

const REPLAY_FLAGS = ['valid', 'schemaValid', 'decisionDigestValid', 'artifactDigestValid', 'decisionSemanticsValid']
const GIT_REGRESSION = 'assertledger-git-regression/1'

/**
 * `detection` when the conserved manifest replays valid, its reference world
 * carries assertledger's own git provenance for exactly the candidate commit
 * and tree, and its decision is VERIFIED with only ELIGIBLE selected candidates.
 * A provenance assertledger did not derive from Git (the kit's request-authored
 * `working tree of <short sha>`) is an unknown binding and refuses.
 */
export function readAssertledgerRecord(
  record: unknown,
  expected: { repository: string; pr: number; candidate: string; tree: string },
): 'detection' | Refusal {
  const fail = (reason: RefusalReason, error: string) => refuse('assertledger', reason, error)
  if (!isMap(record) || record.producer !== 'assertledger' || !isMap(record.invocation) || !isMap(record.native)) {
    return fail('unreadable', 'the assertledger record has no producer/invocation/native parts')
  }
  const inv = record.invocation
  for (const key of ['repository', 'pr', 'candidate'] as const) {
    if (inv[key] !== expected[key]) {
      return fail(
        'unbound',
        `the assertledger record does not bind: ${key} ${JSON.stringify(inv[key])} ≠ ${JSON.stringify(expected[key])}`,
      )
    }
  }
  const { manifest: text, replay } = record.native
  if (typeof text !== 'string' || !isStep(replay) || replay.argv[0] !== 'replay' || replay.argv.at(-1) !== '--json') {
    return fail('unreadable', 'the assertledger record carries no manifest and replay')
  }
  let verdict: unknown
  let manifest: unknown
  try {
    verdict = JSON.parse(replay.stdout)
    manifest = JSON.parse(text)
  } catch {
    return fail('unreadable', 'the conserved manifest or its replay is not JSON')
  }
  if (replay.exit !== 0 || !isMap(verdict) || !REPLAY_FLAGS.every((flag) => verdict[flag] === true)) {
    return fail('unreadable', `the manifest does not replay valid: ${replay.stdout.trim() || `exit ${replay.exit}`}`)
  }
  const context = isMap(manifest) ? manifest.evidenceContext : undefined
  const worlds = isMap(context) && Array.isArray(context.worlds) ? context.worlds : []
  const provenances = worlds.map((world) => {
    try {
      return isMap(world) && typeof world.provenance === 'string' ? (JSON.parse(world.provenance) as unknown) : null
    } catch {
      return null
    }
  })
  const reference = provenances.find((p) => isMap(p) && p.format === GIT_REGRESSION && p.role === 'reference')
  if (!isMap(reference)) {
    return fail(
      'unbound',
      `the manifest's reference world carries no ${GIT_REGRESSION} provenance: its binding to ${expected.candidate} is unknown (a request-authored provenance such as the kit's "working tree of <short sha>" binds nothing) — produce a git-regression check manifest with --after ${expected.candidate}`,
    )
  }
  if (reference.commit !== expected.candidate || reference.tree !== expected.tree) {
    return fail(
      'unbound',
      `the manifest's reference world is ${String(reference.commit)}, not candidate ${expected.candidate}`,
    )
  }
  const decision = isMap(manifest) ? manifest.decision : undefined
  const candidates = isMap(manifest) && Array.isArray(manifest.candidates) ? manifest.candidates.filter(isMap) : []
  const selected = isMap(decision) && Array.isArray(decision.selectedCandidateIds) ? decision.selectedCandidateIds : []
  const eligible = selected.every((id) =>
    candidates.some((candidate) => candidate.id === id && candidate.status === 'ELIGIBLE'),
  )
  if (isMap(decision) && decision.status === 'VERIFIED' && selected.length && eligible) return 'detection'
  if (candidates.some((candidate) => candidate.status === 'WEAK_ORACLE')) {
    return fail(
      'verdict',
      `assertledger reports WEAK_ORACLE for ${expected.candidate}: the test does not detect the fault`,
    )
  }
  return fail(
    'verdict',
    `assertledger reports no detection for ${expected.candidate} (miss: ${isMap(decision) ? String(decision.status) : 'no decision'})`,
  )
}

export type ProofReadiness =
  | { status: 'ready'; selector: ProofSelector }
  | { status: 'unusable'; reason: string; evidence: Diagnostic[] }

function proofSelector(input: {
  candidateGitSHA: string | null
  applicability: ProofSelector['applicability']
  admission: ProofSelector['admission']
  input: string | null
  evidence: Diagnostic[]
}): ProofSelector {
  return {
    admission: input.admission,
    candidateGitSHA: input.candidateGitSHA,
    input: input.input,
    applicability: input.applicability,
    evidence: input.evidence,
  }
}

function proofEvidence(code: string, message: string): Diagnostic {
  return { code, message }
}

type BoundProof =
  | { status: 'bound'; recordId: string; input: string }
  | { status: 'unbound'; evidence: Diagnostic[] }
  | { status: 'unusable'; reason: string; evidence: Diagnostic[] }

function unboundProof(producer: Producer, reason: RefusalReason, error: string): BoundProof {
  return { status: 'unbound', evidence: [proofEvidence('proof-unbound', refuse(producer, reason, error).error)] }
}

/** The same native-comment check capture uses. Empty or unreadable identity does not bind. */
function nativeProofIdentity(found: SelectedRecord, producer: Producer): BoundProof | null {
  if (found.parts.some((part) => !Number.isSafeInteger(part.id) || Number(part.id) < 1)) {
    return unboundProof(
      producer,
      'unreadable',
      'the selected producer publication has no readable native comment identity',
    )
  }
  return null
}

async function boundSemctx(
  repository: string,
  pr: number,
  candidate: string,
  facts: CandidateFacts,
  history: DecodedHistory,
  git: Git,
): Promise<BoundProof> {
  const found = findProofRecord(history, 'semctx', candidate)
  if ('missing' in found) return unboundProof('semctx', 'missing', found.missing)
  if ('unreadable' in found) return unboundProof('semctx', 'unreadable', found.unreadable)
  const identity = nativeProofIdentity(found, 'semctx')
  if (identity) return identity
  if (facts.config === null) {
    return {
      status: 'unusable',
      reason: 'semctx is configured without a committed config digest',
      evidence: [
        proofEvidence('proof-unusable', `candidate ${candidate} has Semctx state and no committed config digest`),
      ],
    }
  }
  const inputs = await semctxInputs(facts, git)
  if ('ok' in inputs) return unboundProof('semctx', inputs.reason, inputs.error)
  const results = readSemctxRecord(found.record, {
    repository,
    pr,
    candidate,
    ...inputs,
    changeFiles: facts.changeFiles,
  })
  if ('ok' in results) return unboundProof('semctx', results.reason, results.error)
  return { status: 'bound', recordId: found.recordId, input: `semctx-config:${facts.config.sha256}` }
}

async function boundAssertledger(
  repository: string,
  pr: number,
  candidate: string,
  facts: CandidateFacts,
  history: DecodedHistory,
  git: Git,
): Promise<BoundProof> {
  const found = findProofRecord(history, 'assertledger', candidate)
  if ('missing' in found) return unboundProof('assertledger', 'missing', found.missing)
  if ('unreadable' in found) return unboundProof('assertledger', 'unreadable', found.unreadable)
  const identity = nativeProofIdentity(found, 'assertledger')
  if (identity) return identity
  const args = ['rev-parse', `${candidate}^{tree}`]
  const tree = await git(facts.toplevel, args)
  const treeSha = oneLine(tree.stdout)
  if (tree.code !== 0 || !SHA.test(treeSha)) return unboundProof('assertledger', 'unreadable', gitError(args, tree))
  const outcome = readAssertledgerRecord(found.record, { repository, pr, candidate, tree: treeSha })
  if (outcome !== 'detection') return unboundProof('assertledger', outcome.reason, outcome.error)
  return { status: 'bound', recordId: found.recordId, input: `assertledger-tree:${treeSha}` }
}

/**
 * Pre-review proof readiness. Applicability is candidateFacts plus assertledgerApplies,
 * never "a pull request is open". Admission is the existing record readers and native
 * comment identity. It does not call admitLanding and does not require an approving review.
 * A missing pull request is not-started, not an applicable no-op. Unreadable facts, an
 * undecidable assertledger type, a missing established base tip, or incomplete history
 * when a producer applies are unusable, not not-applicable.
 * `baseTip` is the tip from refreshSelectedBase, never baseRefOid.
 */
export async function readProofReadiness(input: {
  cwd: string
  repository: string
  pr: number | null
  candidate: string | null
  base: string | null
  baseTip: string | null
  history: DecodedHistory | null
  git: Git
  gh: Gh
}): Promise<ProofReadiness> {
  if (input.pr === null || input.candidate === null || input.base === null) {
    return {
      status: 'ready',
      selector: proofSelector({
        candidateGitSHA: input.candidate,
        applicability: 'required',
        admission: null,
        input: null,
        evidence: [],
      }),
    }
  }
  if (input.baseTip === null) {
    const message = 'the selected base tip is missing; establish it with refreshSelectedBase, never baseRefOid'
    return { status: 'unusable', reason: message, evidence: [proofEvidence('proof-unusable', message)] }
  }
  const facts = await candidateFacts(input.cwd, input.candidate, input.base, input.baseTip, input.git)
  if ('ok' in facts) {
    return { status: 'unusable', reason: facts.error, evidence: [proofEvidence('proof-unusable', facts.error)] }
  }
  const ledger = await assertledgerApplies(
    input.cwd,
    facts,
    { pr: input.pr },
    { gh: input.gh, git: input.git },
    input.repository,
  )
  if (typeof ledger === 'object') {
    return { status: 'unusable', reason: ledger.error, evidence: [proofEvidence('proof-unusable', ledger.error)] }
  }
  if (facts.semctx !== 'configured' && !ledger) {
    return {
      status: 'ready',
      selector: proofSelector({
        candidateGitSHA: input.candidate,
        applicability: 'not-applicable',
        admission: null,
        input: null,
        evidence: [],
      }),
    }
  }
  if (input.history === null || !input.history.source.complete) {
    const message = `the complete common proof history for PR #${input.pr} could not be read`
    return { status: 'unusable', reason: message, evidence: [proofEvidence('proof-unusable', message)] }
  }
  const producers: BoundProof[] = []
  if (facts.semctx === 'configured') {
    producers.push(await boundSemctx(input.repository, input.pr, input.candidate, facts, input.history, input.git))
  }
  if (ledger) {
    producers.push(
      await boundAssertledger(input.repository, input.pr, input.candidate, facts, input.history, input.git),
    )
  }
  const unusable = producers.find((producer) => producer.status === 'unusable')
  if (unusable && unusable.status === 'unusable') {
    return { status: 'unusable', reason: unusable.reason, evidence: unusable.evidence }
  }
  const unbound = producers.filter((producer) => producer.status === 'unbound')
  if (unbound.length > 0 || producers.length === 0) {
    return {
      status: 'ready',
      selector: proofSelector({
        candidateGitSHA: input.candidate,
        applicability: 'required',
        admission: null,
        input: null,
        evidence: unbound.flatMap((producer) => (producer.status === 'unbound' ? producer.evidence : [])),
      }),
    }
  }
  const bound = producers.filter((producer) => producer.status === 'bound')
  const identity = bound.map((producer) => (producer.status === 'bound' ? producer.input : '')).join('\n')
  const recordIds = bound.map((producer) => (producer.status === 'bound' ? producer.recordId : ''))
  if (identity.length === 0 || recordIds.some((recordId) => recordId.length === 0)) {
    const message = `PR #${input.pr} proof records did not bind a candidate, input, and record id`
    return { status: 'unusable', reason: message, evidence: [proofEvidence('proof-unusable', message)] }
  }
  return {
    status: 'ready',
    selector: proofSelector({
      candidateGitSHA: input.candidate,
      applicability: 'required',
      admission: { ok: true, candidateGitSHA: input.candidate, input: identity, recordIds },
      input: identity,
      evidence: [],
    }),
  }
}

async function admitAssertledger(
  facts: CandidateFacts,
  target: Target,
  deps: Deps,
  read: Read,
  found: SelectedRecord,
): Promise<Refusal | null> {
  const args = ['rev-parse', `${target.candidate}^{tree}`]
  const tree = await deps.git(facts.toplevel, args)
  if (tree.code !== 0) return refuse('assertledger', 'unreadable', gitError(args, tree))
  const outcome = readAssertledgerRecord(found.record, {
    repository: read.repository,
    pr: target.pr,
    candidate: target.candidate,
    tree: oneLine(tree.stdout),
  })
  return outcome === 'detection' ? reviewedRecord(found.parts, target, 'assertledger') : outcome
}

async function pullRequestBranch(cwd: string, pr: number, gh: Gh, repository: string): Promise<string | Refusal> {
  const raw = await gh(cwd, ['pr', 'view', String(pr), '--repo', repository, '--json', 'headRefName'])
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return refuse('candidate', 'unreadable', `PR #${pr} branch could not be read`)
  }
  if (!isRecord(parsed) || typeof parsed.headRefName !== 'string' || parsed.headRefName.length === 0) {
    return refuse('candidate', 'unreadable', `PR #${pr} has no head branch`)
  }
  return parsed.headRefName
}

async function loadSemantic(
  cwd: string,
  target: Pick<Target, 'pr' | 'base'>,
  deps: Deps,
  repository: string,
  body: string,
): Promise<ProofSemanticContext | Refusal> {
  if (deps.semantic) return deps.semantic
  const branch = await pullRequestBranch(cwd, target.pr, deps.gh, repository)
  if (typeof branch !== 'string') return branch
  if (target.base === undefined || target.base.length === 0) {
    return refuse('candidate', 'unreadable', `PR #${target.pr} has no base branch`)
  }
  const resolved = await resolveReviewSemanticContext({
    cwd,
    repository,
    pr: target.pr,
    body,
    branch,
    base: target.base,
    gh: deps.gh,
  })
  if (!resolved.ok) {
    const diagnostic = resolved.diagnostics[0]
    const code = typeof diagnostic?.code === 'string' ? diagnostic.code : ''
    const message = typeof diagnostic?.message === 'string' ? diagnostic.message : ''
    return refuse(
      'candidate',
      code.endsWith('unreadable') ? 'unreadable' : 'unbound',
      message.length > 0 ? message : 'review semantic context refused',
    )
  }
  return proofSemanticContext(resolved.value)
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/**
 * The landing admission for the selected PR's current candidate. Reads only;
 * a refusal names what must be produced outside admission. Transport failures
 * (`gh`) throw: an unreadable source authorizes nothing. Semctx absence makes
 * only Semctx non-applicable; the assertledger requirement is decided apart.
 * Neither skip is a semantic binding: every review hashes the shared canon,
 * and proof parts may be empty.
 */
export async function captureReviewInput(
  cwd: string,
  target: Pick<Target, 'pr' | 'candidate' | 'base' | 'baseTip'>,
  deps: Deps,
): Promise<ReviewSnapshot | Refusal> {
  const facts = await candidateFacts(cwd, target.candidate, target.base, target.baseTip, deps.git)
  if ('ok' in facts) return facts
  const repository = await repositoryOf(deps.gh, cwd)
  const ledger = await assertledgerApplies(cwd, facts, target, deps, repository)
  if (typeof ledger === 'object') return ledger
  const read = { repository }
  let semctx: SelectedRecord | null = null
  let assertledger: SelectedRecord | null = null
  if (facts.semctx === 'configured' || ledger) {
    const history = decodeHistory(
      await readGitHubHistory(githubScope(repository, target.pr), withRoxabiGitHubPolicy({ cwd, gh: deps.gh })),
    )
    if (!history.source.complete)
      return refuse(
        'candidate',
        'unreadable',
        `the complete common proof history for PR #${target.pr} could not be read`,
      )
    const select = (producer: Producer): SelectedRecord | Refusal => {
      const found = findProofRecord(history, producer, target.candidate)
      if ('missing' in found) {
        const extra = producer === 'assertledger' ? ' --assertledger-manifest <manifest.json>' : ''
        return refuse(
          producer,
          'missing',
          `${found.missing}. Produce it outside admission: ${acquireCommand(target.pr, extra)}`,
        )
      }
      if ('unreadable' in found) return refuse(producer, 'unreadable', found.unreadable)
      if (found.parts.some((part) => !Number.isSafeInteger(part.id) || Number(part.id) < 1))
        return refuse(
          producer,
          'unreadable',
          'the selected producer publication has no readable native comment identity',
        )
      return found
    }
    if (facts.semctx === 'configured') {
      const selected = select('semctx')
      if ('ok' in selected) return selected
      semctx = selected
    }
    if (ledger) {
      const selected = select('assertledger')
      if ('ok' in selected) return selected
      assertledger = selected
    }
  }
  const body = await readPrBody(cwd, target.pr, deps.gh, repository)
  const semantic = await loadSemantic(cwd, target, deps, repository, body.body)
  if ('ok' in semantic) return semantic
  return {
    ok: true,
    input: hashReviewInput(repository, target, body, semctx?.parts ?? null, assertledger?.parts ?? null, semantic),
    body,
    facts,
    read,
    semctx,
    assertledger,
  }
}

/** Admission evaluates the very selections/body whose read binding it compares. */
export async function admitLanding(cwd: string, target: Target, deps: Deps): Promise<Admission> {
  const snapshot = await captureReviewInput(cwd, target, deps)
  if (!snapshot.ok) return snapshot
  const { facts, read, body } = snapshot
  if (target.proofPins) {
    const pinned = await compareApplicableProofPins(deps.git, facts, target.proofPins)
    if (!pinned.ok) return pinned
  }

  const next = `re-read the exact body and selected producer parts and re-review the same head (skills/feature/proof.ts admitLanding)`
  if (!read || !body || snapshot.input === null) {
    return refuse('candidate', 'unreadable', `the current Spec could not be bound into the review input — ${next}`)
  }
  let semctx: SemctxOutcome = 'absent'
  if (snapshot.semctx) {
    const outcome = await admitSemctx(facts, target, deps, read, snapshot.semctx, body)
    if (typeof outcome === 'object' && 'ok' in outcome) return outcome
    semctx = outcome
  }
  if (snapshot.assertledger) {
    const refused = await admitAssertledger(facts, target, deps, read, snapshot.assertledger)
    if (refused) return refused
  }
  if (target.reviewInput === null)
    return refuse(
      'candidate',
      'unbound',
      `the approval has no review-input binding and cannot approve the current Spec — ${next}`,
    )
  if (!/^[0-9a-f]{64}$/.test(target.reviewInput))
    return refuse(
      'candidate',
      'unreadable',
      `the approval's review-input binding is malformed or unsupported — ${next}`,
    )
  if (target.reviewInput !== snapshot.input)
    return refuse(
      'candidate',
      'unbound',
      `the current Spec, config, PR body, or selected producer publication is not the exact input that was reviewed — ${next}`,
    )
  return { ok: true, proof: { semctx, assertledger: snapshot.assertledger ? 'detection' : 'not-applicable' } }
}
