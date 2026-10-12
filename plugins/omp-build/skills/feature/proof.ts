/**
 * Landing admission from producer evidence (#768).
 *
 * `admitLanding` only reads: Git objects of the freshly established selected base
 * and candidate, the worktree and principal `.semctx` paths, the PR's comments and body. It never runs
 * Semctx, assertledger, a test or an LLM. The evidence was acquired earlier by
 * `proof-acquire.ts` in a private checkout of the candidate and conserved as a
 * PR comment by the automation login, or a run of parts (`renderRecord`);
 * admission re-reads it, re-derives every binding input itself, and applies the policy.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fixKind, type TicketSignals, ticketOfBranch } from './epic'

export type GitResult = { code: number; stdout: string; stderr: string }
/** Non-throwing, lossless git: stdout exactly as printed. */
export type Git = (cwd: string, args: string[]) => Promise<GitResult>
export type Gh = (cwd: string, args: string[]) => Promise<string>
export type PrComment = { id?: number; author: { login: string }; body: string; createdAt?: string; updatedAt?: string }
export type Comments = () => Promise<{ me: string; comments: PrComment[] }>

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
const CONFIG = '.semctx/config.json'
const STACK = '.dev/stack.yml'
export const ASSERTLEDGER_CONFIG = 'assertledger.config.json'
export const KIT_ADAPTER = 'scripts/kit/assertledger/vitest-adapter.mjs'

function refuse(producer: Producer | 'candidate', reason: RefusalReason, error: string): Refusal {
  return { ok: false, producer, reason, error }
}

export function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
// Candidate facts: the bound root, the principal, the base's and the candidate's
// committed trees, and the configured Semctx state on disk
// ---------------------------------------------------------------------------

type TreeEntry = { mode: string; type: string; oid: string; path: string }
/** A declaration committed at `at`: the established base tip or the candidate sha. */
export type Declared = { at: string; entry: TreeEntry }

/**
 * The Semctx configuration the producer runs under: the one committed at the
 * candidate (equal to the base's when the base commits one), else the
 * operator's uncommitted `.semctx/config.json` on disk (`ignored`), which
 * acquisition copies into its private checkout. `sha256` is of `text`.
 */
export type SemctxConfig = { source: 'committed' | 'ignored'; path: string; text: string; sha256: string }

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
  /** The assertledger adapter declarations the base and the candidate commit. */
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

/** The main worktree of the repository (`worktree list` lists it first); null when it is bare. */
function principalOf(stdout: string): string | null {
  const first = stdout.split('\0\0')[0] ?? ''
  const attributes = first.split('\0')
  if (attributes.includes('bare')) return null
  const line = attributes.find((attribute) => attribute.startsWith('worktree '))
  if (!line) throw new Error('git worktree list named no worktree')
  return line.slice('worktree '.length)
}

/** `present` / `absent` for `<dir>/.semctx`, or the read error. */
function onDisk(dir: string): 'present' | 'absent' | Error {
  try {
    lstatSync(join(dir, '.semctx'))
    return 'present'
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return 'absent'
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** The text of the regular file `path`, null when it does not exist, or the read error. */
function diskText(path: string): string | null | Error {
  try {
    if (!lstatSync(path).isFile()) return new Error('not a regular file')
    return readFileSync(path, 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return null
    return error instanceof Error ? error : new Error(String(error))
  }
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
  const args = [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    `${rev}^{commit}`,
    '--',
    '.semctx',
    STACK,
    ASSERTLEDGER_CONFIG,
    KIT_ADAPTER,
  ]
  const tree = await git(toplevel, args)
  if (tree.code !== 0) return new Error(gitError(args, tree))
  try {
    return parseTree(tree.stdout)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * What the base and the candidate commit and what the checkouts hold, bound to
 * the repository root — never to the caller's cwd — and to a local tip that is
 * the candidate. Applicability is the union of the established base commit, the candidate
 * and the configured state on disk, so a PR cannot exempt itself by deleting a
 * declaration: Semctx applies when any of them holds `.semctx`, an adapter or
 * `test_e2e` applies when the base or the candidate declares it. Semctx runs
 * under the candidate's committed config, which must equal the base's when the
 * base commits one (a PR never relaxes the policy it is judged by); with none
 * committed, under the operator's uncommitted config on disk (the bound
 * worktree and the principal must agree). `absent` is only none of these.
 * Anything else refuses: Git or read errors (a failed HEAD probe is not an
 * unborn branch), a missing or corrupt base or candidate, a malformed config,
 * committed working state, configurations that disagree, or Semctx state with
 * no configuration.
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
  const listArgs = ['worktree', 'list', '--porcelain', '-z']
  const list = await git(toplevel, listArgs)
  if (list.code !== 0) return refuse('candidate', 'unreadable', gitError(listArgs, list))
  let principal: string | null
  try {
    principal = principalOf(list.stdout)
  } catch (error) {
    return refuse('candidate', 'unreadable', errorMessage(error))
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
    adapters: declared((tree) => find(tree, ASSERTLEDGER_CONFIG) ?? find(tree, KIT_ADAPTER)),
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
  const baseConfig = find(baseEntries, CONFIG)
  const committed = find(entries, CONFIG)
  if (baseConfig && committed?.oid !== baseConfig.oid) {
    return refuse(
      'semctx',
      'ambiguous',
      `candidate ${candidate} ${committed ? 'changes' : 'deletes'} the ${CONFIG} ${baseRef} commits: a PR is judged under the base's Semctx policy, never its own — a configuration change lands outside landPr`,
    )
  }
  const dirs = [toplevel, ...(principal !== null && principal !== toplevel ? [principal] : [])]
  const present: string[] = []
  const local: { path: string; text: string }[] = []
  for (const dir of dirs) {
    const state = onDisk(dir)
    if (state instanceof Error) {
      return refuse('semctx', 'unreadable', `${JSON.stringify(join(dir, '.semctx'))} cannot be read: ${state.message}`)
    }
    if (state === 'absent') continue
    present.push(join(dir, '.semctx'))
    // A committed base config is the policy; copies on disk are checkouts of it, never another source.
    if (baseConfig) continue
    const path = join(dir, CONFIG)
    const text = diskText(path)
    if (text instanceof Error)
      return refuse('semctx', 'unreadable', `${JSON.stringify(path)} cannot be read: ${text.message}`)
    if (text !== null) local.push({ path, text })
  }
  let config: Omit<SemctxConfig, 'sha256'> | null = null
  if (committed) {
    try {
      config = { source: 'committed', path: CONFIG, text: await blob(git, toplevel, committed) }
    } catch (error) {
      return refuse('semctx', 'unreadable', `${CONFIG} at ${candidate}: ${errorMessage(error)}`)
    }
  } else if (local[0]) {
    config = { source: 'ignored', path: local[0].path, text: local[0].text }
  }
  const disagreeing = local.filter((copy) => copy.text !== config?.text)
  if (disagreeing.length) {
    return refuse(
      'semctx',
      'ambiguous',
      `${disagreeing.map((copy) => JSON.stringify(copy.path)).join(', ')} disagree${disagreeing.length === 1 ? 's' : ''} with the Semctx configuration ${config?.source === 'committed' ? `candidate ${candidate} commits` : `at ${JSON.stringify(config?.path)}`}: one configuration decides — make them equal`,
    )
  }
  if (config) {
    try {
      if (!isMap(JSON.parse(config.text))) throw new Error('not a JSON object')
    } catch (error) {
      const where = config.source === 'committed' ? `${CONFIG} at ${candidate}` : JSON.stringify(config.path)
      return refuse('semctx', 'unreadable', `${where} is malformed: ${errorMessage(error)}`)
    }
    const digest = createHash('sha256').update(config.text).digest('hex')
    return { ...facts, semctx: 'configured', config: { ...config, sha256: digest } }
  }
  const committedState = semctxEntries[0] ?? baseEntries.find(isSemctx)
  if (committedState) {
    const where = semctxEntries.length ? `candidate ${candidate}` : `${baseRef} (the candidate removes it)`
    return refuse(
      'semctx',
      'ambiguous',
      `${where} commits .semctx (${committedState.path}) without a regular ${CONFIG}, and no configuration is on disk; Semctx state that is not configured is not absence`,
    )
  }
  if (present[0]) {
    return refuse(
      'semctx',
      'ambiguous',
      `${JSON.stringify(present[0])} exists but neither ${baseRef} nor candidate ${candidate} commits a ${CONFIG}, and none is on disk: configured state outside the candidate is not absence — configure it or remove that state`,
    )
  }
  return { ...facts, semctx: 'absent', config: null }
}

// ---------------------------------------------------------------------------
// Conserved records: one PR comment per producer and candidate, or one run of parts
// ---------------------------------------------------------------------------

/** GitHub rejects an issue comment body above this many characters. */
export const COMMENT_LIMIT = 65536
export const proofMark = (producer: Producer) => `<!-- omp-build:proof producer=${producer} -->`
const PROOF_HEAD = /^<!-- omp-build:proof-head sha=([0-9a-f]{40})(?: part=([1-9]\d*)\/([1-9]\d*))? -->$/
const FENCE_OPEN = '```json'
const FENCE_CLOSE = '```'
const NATIVE_OPEN = '<details><summary>Native results and invocation</summary>'
const NATIVE_CLOSE = '</details>'

/**
 * The comment bodies for one producer result. Line 1 names the producer, line 2
 * the candidate; the record is one `json` block, on one line. A backtick
 * inside a JSON string is written `\u0060`, so native output never closes the
 * fence. A record that fits one comment (measured in UTF-8 bytes, the strictest
 * count) is one body; a larger one is a run of bodies headed `part=<i>/<n>`,
 * each holding the next slice of that line, its JSON first escaped to ASCII so
 * no slice splits a character.
 */
export function renderRecord(producer: Producer, candidate: string, summary: string[], record: unknown): string[] {
  const json = JSON.stringify(record).replace(/`/g, '\\u0060')
  const render = (part: string, lines: string[], block: string) =>
    [
      proofMark(producer),
      `<!-- omp-build:proof-head sha=${candidate}${part ? ` ${part}` : ''} -->`,
      `## Proof — ${producer}${part ? ` (${part})` : ''}`,
      '',
      ...lines,
      '',
      NATIVE_OPEN,
      '',
      FENCE_OPEN,
      block,
      FENCE_CLOSE,
      '',
      NATIVE_CLOSE,
    ].join('\n')
  const whole = render('', summary, json)
  if (Buffer.byteLength(whole) <= COMMENT_LIMIT) return [whole]
  const ascii = json.replace(/[\u0080-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
  // The widest frame: part 1 carries the summary, and a seven-digit count bounds every n.
  const room = COMMENT_LIMIT - Buffer.byteLength(render('part=9999999/9999999', summary, ''))
  if (room < 1) throw new Error(`the ${producer} record summary alone exceeds GitHub's ${COMMENT_LIMIT}`)
  const total = Math.ceil(ascii.length / room)
  return Array.from({ length: total }, (_, i) =>
    render(`part=${i + 1}/${total}`, i === 0 ? summary : [], ascii.slice(i * room, (i + 1) * room)),
  )
}

type Found = { record: unknown; parts: PrComment[] } | { missing: string } | { unreadable: string }
type SelectedRecord = Extract<Found, { record: unknown }>
/** Native comments of one posting: a single record or a complete ordered run of parts. */
type Run = { parts: PrComment[]; total: number; broken: boolean }

/**
 * The latest record of `producer` for `candidate` by the automation login, in
 * comment order. Records of other authors, producers or candidates are not
 * read. A run of parts is read whole: its parts 1..n in order, other comments
 * between them ignored; when the latest run lacks a part, or a part comes out
 * of order, the record is missing. A matching record whose blocks do not parse
 * is unreadable.
 */
export function findRecord(comments: PrComment[], me: string, producer: Producer, candidate: string): Found {
  const mark = proofMark(producer)
  let latest: Run | null = null
  const others: string[] = []
  for (const comment of comments) {
    if (comment.author?.login !== me) continue
    const lines = comment.body.split('\n')
    if ((lines[0] ?? '').trimEnd() !== mark) continue
    const head = (lines[1] ?? '').trimEnd().match(PROOF_HEAD)
    if (!head || head[1] !== candidate) {
      others.push(head?.[1] ?? '(no head line)')
      continue
    }
    const part = Number(head[2] ?? 1)
    const total = Number(head[3] ?? 1)
    if (part === 1) latest = { parts: [comment], total, broken: false }
    else if (latest && !latest.broken && latest.total === total && latest.parts.length === part - 1)
      latest.parts.push(comment)
    else latest = { parts: [], total, broken: true }
  }
  if (latest === null) {
    const seen = others.length ? `; records by ${me} name ${[...new Set(others)].join(', ')}` : ''
    return { missing: `no ${producer} record by ${me} for candidate ${candidate}${seen}` }
  }
  if (latest.broken || latest.parts.length !== latest.total) {
    return {
      missing: `the latest ${producer} record by ${me} for candidate ${candidate} is incomplete: its ${latest.total} parts are not all present in order`,
    }
  }
  let json = ''
  for (const { body } of latest.parts) {
    const lines = body.split('\n')
    // Only the writer's seven-line trailing frame is authoritative. Summary
    // text can contain arbitrary fences or even a complete earlier frame.
    const last = lines.length - 1
    const fragment = lines[last - 3]
    if (
      lines[last - 6] !== NATIVE_OPEN ||
      lines[last - 5] !== '' ||
      lines[last - 4] !== FENCE_OPEN ||
      typeof fragment !== 'string' ||
      lines[last - 2] !== FENCE_CLOSE ||
      lines[last - 1] !== '' ||
      lines[last] !== NATIVE_CLOSE
    )
      return { unreadable: `the ${producer} record for ${candidate} carries no trailing native json frame` }
    json += fragment
  }
  try {
    return { record: JSON.parse(json), parts: latest.parts }
  } catch (error) {
    return { unreadable: `the ${producer} record for ${candidate} is not JSON: ${errorMessage(error)}` }
  }
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

/** The inputs a Semctx record must bind to, re-derived from Git and the PR. */
export type SemctxExpected = {
  repository: string
  pr: number
  candidate: string
  base: string
  mergeBase: string
  contracts: string[]
  changeFiles: string[]
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
  if (!LANDABLE[lifecycle]) {
    return refuse('semctx', 'verdict', `${name} is ${lifecycle}; only an active, partial or verified change lands`)
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
/** Approval publication time and the retained exact line-3 read binding are separate constraints. */
export type Target = {
  pr: number
  candidate: string
  base: string | undefined
  baseTip: string
  reviewedAt: string | null
  reviewInput: string | null
}
export type Deps = { gh: Gh; git: Git; comments: Comments }
type Read = { me: string; comments: PrComment[]; repository: string }
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

/** Exact observed bytes and native publication identities, not an authenticity certificate. */
export function hashReviewInput(
  repository: string,
  target: Pick<Target, 'pr' | 'candidate'>,
  body: PrBody,
  semctx: PrComment[] | null,
  assertledger: PrComment[] | null,
): string {
  const parts = (run: PrComment[] | null) =>
    run?.map((part) => [part.id, part.body, part.createdAt, part.updatedAt]) ?? null
  const bytes = JSON.stringify([
    'omp-build:review-input/1',
    repository,
    target.pr,
    target.candidate,
    [body.body, body.lastEditedAt],
    parts(semctx),
    parts(assertledger),
  ])
  const digest = createHash('sha256').update(bytes, 'utf8').digest('hex')
  return `<!-- omp-build:review-input v=1 sha256=${digest} -->`
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

/**
 * The Semctx inputs admission and acquisition derive the same way from Git and
 * the facts. The candidate must add a change contract of its own; contracts it
 * modifies are verified beside it but never stand in for it.
 */
export async function semctxInputs(
  facts: CandidateFacts,
  git: Git,
): Promise<Pick<SemctxExpected, 'base' | 'mergeBase' | 'contracts' | 'config'> | Refusal> {
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
      `candidate ${facts.candidate} adds no ${CHANGES_DIR}<id>.sem since ${mergeBase}${modified.length ? ` (it only modifies ${modified.join(', ')}, which cannot stand in for this ticket's own)` : ''}: open the change contract for this ticket (feature §6.0)`,
    )
  }
  const contracts = changed.map((contract) => contract.path)
  const config = { source: facts.config.source, sha256: facts.config.sha256 }
  return { base: facts.base, mergeBase, contracts, config }
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
        `proof part ${index + 1}/${parts.length} was revised after publication; acquire a new producer record, then review the head (feature §6.4)`,
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
      `the review of candidate ${target.candidate} has no readable native creation time: re-review the head (feature §6.4)`,
    )
  for (const [index, part] of parts.entries()) {
    const created = nativeInstant(part.createdAt)
    if (created === null || created >= approved) {
      return refuse(
        producer,
        'unjustified',
        `proof part ${index + 1}/${parts.length} was published at ${part.createdAt}, not before approving review ${target.reviewedAt}: re-review the same head (feature §6.4), reuse the unmodified record without a producer`,
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
      `the PR #${target.pr} body that justifies the PARTIAL gaps was edited at ${edited}, not before the review record that approved ${target.candidate} (${target.reviewedAt ?? 'no time'}): that review never judged it — re-review the head (feature §6.4)`,
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
 * declares an adapter (`assertledger.config.json` with an `adapter`, or the
 * kit's vitest adapter) and the selected PR is a fix (`fixKind`: its head
 * branch, or the title, labels or org issue type of a closing issue or of the
 * ticket the head branch names), all read from their sources. GitHub links
 * closing keywords only for a PR into the default branch, so the named ticket
 * is read even when nothing closes it. An unreadable declaration refuses, an
 * unreadable closing list or named ticket throws, and a PR whose type nothing
 * establishes refuses.
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
    if (entry.path !== ASSERTLEDGER_CONFIG) continue
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

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/**
 * The landing admission for the selected PR's current candidate. Reads only;
 * a refusal names what must be produced outside admission. Transport failures
 * (`gh`) throw: an unreadable source authorizes nothing. Semctx absence makes
 * only Semctx non-applicable; the assertledger requirement is decided apart.
 */
export async function captureReviewInput(
  cwd: string,
  target: Pick<Target, 'pr' | 'candidate' | 'base' | 'baseTip'>,
  deps: Deps,
): Promise<ReviewSnapshot | Refusal> {
  const facts = await candidateFacts(cwd, target.candidate, target.base, target.baseTip, deps.git)
  if ('ok' in facts) return facts
  const absent = (): ReviewSnapshot => ({
    ok: true,
    input: null,
    body: null,
    facts,
    read: null,
    semctx: null,
    assertledger: null,
  })
  if (facts.semctx === 'absent' && !facts.adapters.length) return absent()
  const repository = await repositoryOf(deps.gh, cwd)
  const ledger = await assertledgerApplies(cwd, facts, target, deps, repository)
  if (typeof ledger === 'object') return ledger
  if (facts.semctx === 'absent' && !ledger) return absent()
  const { me, comments } = await deps.comments()
  const read = { me, comments, repository }
  const select = (producer: Producer): SelectedRecord | Refusal => {
    const found = findRecord(comments, me, producer, target.candidate)
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
      return refuse(producer, 'unreadable', 'the selected producer publication has no readable native comment identity')
    return found
  }
  const semctx = facts.semctx === 'configured' ? select('semctx') : null
  if (semctx && 'ok' in semctx) return semctx
  const assertledger = ledger ? select('assertledger') : null
  if (assertledger && 'ok' in assertledger) return assertledger
  const body = await readPrBody(cwd, target.pr, deps.gh, repository)
  return {
    ok: true,
    input: hashReviewInput(repository, target, body, semctx?.parts ?? null, assertledger?.parts ?? null),
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
  const next = `re-read the exact body and selected producer parts and re-review the same head (feature §6.4)`
  if (!read || !body) {
    // No producer applies now. An approval that bound producer evidence was judged
    // under inputs that no longer hold (ticket/branch reclassified, adapter or
    // ignored Semctx config gone): the reviewed binding is not silently dropped.
    if (target.reviewInput === null) return { ok: true, proof: { semctx: 'absent', assertledger: 'not-applicable' } }
    return refuse(
      'candidate',
      'unbound',
      `the approval's line-3 review-input binding names producer evidence, but no producer applies to this landing: applicability changed after review — ${next}`,
    )
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
    return refuse('candidate', 'missing', `the approval has no line-3 review-input binding — ${next}`)
  if (!/^<!-- omp-build:review-input v=1 sha256=[0-9a-f]{64} -->$/.test(target.reviewInput))
    return refuse(
      'candidate',
      'unreadable',
      `the approval's line-3 review-input binding is malformed or unsupported — ${next}`,
    )
  if (target.reviewInput !== snapshot.input)
    return refuse(
      'candidate',
      'unbound',
      `the current PR body or selected producer publication is not the exact input that was reviewed — ${next}`,
    )
  return { ok: true, proof: { semctx, assertledger: snapshot.assertledger ? 'detection' : 'not-applicable' } }
}
