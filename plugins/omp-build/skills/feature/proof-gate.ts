import { lstatSync } from 'node:fs'
import { join } from 'node:path'

export type VerifyStatus = 'VERIFIED' | 'PARTIAL' | 'BLOCKED'
export type AssertledgerVerdict = 'detection' | 'WEAK_ORACLE' | 'miss' | null

/** dev-review step 5's NO TEST enum. Callers cannot widen it. */
export const NO_TEST_REASONS = ['infra-not-wired', 'prompt-logic-only', 'ui-manual-only', 'out-of-scope'] as const

/** An agent browser check (dev-review 5a): what was done, where, and what was seen. */
export type UiCheck = { steps: string; url: string; observed: string }

/**
 * The proof the caller builds for one commit. The committed contract stores no
 * verification commit: freshness is not observable here, so the caller re-verifies
 * and sets `head` to that commit before open and before land.
 */
export type Proof = {
  head: string
  verify: VerifyStatus
  gaps: string[]
  noTest: Record<string, string>
  uiChecks?: Record<string, UiCheck>
  assertledger: AssertledgerVerdict
  hasAdapter: boolean
  typeFix: boolean
}

export type GateResult = { pass: true } | { pass: false; reason: string }

type Guard = { ok: true; proof: Proof } | { ok: false; reason: string }

const PROOF_KEYS = ['head', 'verify', 'gaps', 'noTest', 'uiChecks', 'assertledger', 'hasAdapter', 'typeFix']
const UI_CHECK_KEYS = ['steps', 'url', 'observed']
const COMMIT_SHA = /^[0-9a-f]{40}$/
/** An absolute URL or a site path. No minimum length, no new body schema. */
const URL_OR_PATH = /^(?:https?:\/\/\S+|\/\S*)$/

type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** The proof's shape. Never throws, never passes a doubtful value on. */
function shape(input: unknown): Guard {
  const bad = (what: string): Guard => ({ ok: false, reason: `malformed proof: ${what}` })
  if (!isDict(input)) return bad('not an object')
  for (const key of Object.keys(input)) if (!PROOF_KEYS.includes(key)) return bad(`unknown key ${JSON.stringify(key)}`)
  const head = input.head
  const verify = input.verify
  const gaps = input.gaps
  const noTestInput = input.noTest
  const assertledger = input.assertledger
  const hasAdapter = input.hasAdapter
  const typeFix = input.typeFix
  if (typeof head !== 'string' || !COMMIT_SHA.test(head)) return bad('head is not a 40-hex commit sha')
  if (verify !== 'VERIFIED' && verify !== 'PARTIAL' && verify !== 'BLOCKED') {
    return bad('verify is not VERIFIED, PARTIAL or BLOCKED')
  }
  if (!Array.isArray(gaps) || !gaps.every(isText)) return bad('gaps is not a list of names')
  if (verify === 'VERIFIED' && gaps.length !== 0) return bad('VERIFIED names unresolved gaps')
  if (!isDict(noTestInput)) return bad('noTest is not a map of gap to reason')
  const noTest: Record<string, string> = {}
  for (const [key, reason] of Object.entries(noTestInput)) {
    if (typeof reason !== 'string') return bad('noTest is not a map of gap to reason')
    noTest[key] = reason
  }
  let uiChecks: Record<string, UiCheck> | undefined
  if (input.uiChecks !== undefined) {
    if (!isDict(input.uiChecks)) return bad('uiChecks is not a map of gap to check')
    uiChecks = {}
    for (const [gap, check] of Object.entries(input.uiChecks)) {
      if (!isDict(check)) return bad(`uiChecks.${gap} is not an object`)
      for (const key of Object.keys(check)) {
        if (!UI_CHECK_KEYS.includes(key)) return bad(`uiChecks.${gap} has unknown key ${JSON.stringify(key)}`)
      }
      const steps = check.steps
      const url = check.url
      const observed = check.observed
      if (typeof steps !== 'string' || typeof url !== 'string' || typeof observed !== 'string') {
        return bad(`uiChecks.${gap} is missing steps, url or observed`)
      }
      uiChecks[gap] = { steps, url, observed }
    }
  }
  if (
    assertledger !== 'detection' &&
    assertledger !== 'WEAK_ORACLE' &&
    assertledger !== 'miss' &&
    assertledger !== null
  ) {
    return bad('assertledger is not a verdict')
  }
  if (typeof hasAdapter !== 'boolean') return bad('hasAdapter is not a boolean')
  if (typeof typeFix !== 'boolean') return bad('typeFix is not a boolean')
  return {
    ok: true,
    proof: { head, verify, gaps, noTest, ...(uiChecks ? { uiChecks } : {}), assertledger, hasAdapter, typeFix },
  }
}

function uiCheckFault(gap: string, check: UiCheck | undefined): string | null {
  if (!check) return `ui-manual-only gap ${gap} has no uiChecks entry`
  if (!isText(check.steps)) return `uiChecks.${gap}.steps is empty`
  if (!isText(check.observed)) return `uiChecks.${gap}.observed is empty`
  if (!URL_OR_PATH.test(check.url.trim())) return `uiChecks.${gap}.url is not a URL or a path`
  return null
}

/**
 * The proof, judged. `e2e` is whether the bound commit's `.dev/stack.yml` declares
 * `commands.test_e2e`: then that command is the UI proof and `ui-manual-only` is refused.
 * Stricter than dev-review 5a, which only fires when the diff touches the frontend.
 * `typeFix` and `hasAdapter` stay caller-declared.
 */
export function proofGate(input: unknown, { e2e = false }: { e2e?: boolean } = {}): GateResult {
  const guard = shape(input)
  if (!guard.ok) return { pass: false, reason: guard.reason }
  const { proof } = guard
  if (proof.verify === 'BLOCKED') return { pass: false, reason: 'BLOCKED' }
  if (proof.verify === 'PARTIAL') {
    if (proof.gaps.length === 0) return { pass: false, reason: 'PARTIAL names no gap' }
    const reasonOf = (gap: string) => (Object.hasOwn(proof.noTest, gap) ? proof.noTest[gap] : '')
    const unjustified = proof.gaps.filter((gap) => !(NO_TEST_REASONS as readonly string[]).includes(reasonOf(gap)))
    if (unjustified.length) return { pass: false, reason: `unjustified PARTIAL: ${unjustified.join(', ')}` }
    for (const gap of proof.gaps.filter((name) => reasonOf(name) === 'ui-manual-only')) {
      if (e2e) return { pass: false, reason: `ui-manual-only refused for ${gap}: commands.test_e2e is declared` }
      const fault = uiCheckFault(
        gap,
        proof.uiChecks && Object.hasOwn(proof.uiChecks, gap) ? proof.uiChecks[gap] : undefined,
      )
      if (fault) return { pass: false, reason: fault }
    }
  }
  if (proof.typeFix && proof.hasAdapter && proof.assertledger !== 'detection') {
    return { pass: false, reason: proof.assertledger ?? 'assertledger-missing' }
  }
  return { pass: true }
}

// ── Change contracts: column-0 `change <id>`, indented status and tag ────────

export type ChangeContract = { id: string; lifecycle: string | null; tags: string[]; file: string }

const BLOCK_HEADER = /^(goal|invariant|decision|assumption|unknown|change|evidence|relation) (\S+)\s*$/
const FIELD = /^ {2}(status|tag):[ \t]*(.*?)\s*$/

/**
 * The change contracts of one `.sem` text. A block opens on a column-0 `<kind> <id>` line
 * and runs to the next column-0 non-blank line; its fields are indented two spaces. Only
 * `change` blocks are contracts. A contract's lifecycle is its own first `status:`.
 */
export function parseChangeContracts(text: string, file: string): ChangeContract[] {
  const out: ChangeContract[] = []
  let open: ChangeContract | null = null
  for (const line of text.split('\n')) {
    const row = line.endsWith('\r') ? line.slice(0, -1) : line
    if (row.trim() === '') continue
    if (!row.startsWith(' ') && !row.startsWith('\t')) {
      const header = BLOCK_HEADER.exec(row)
      const id = header?.[2]
      open = header?.[1] === 'change' && id ? { id, lifecycle: null, tags: [], file } : null
      if (open) out.push(open)
      continue
    }
    const field = open ? FIELD.exec(row) : null
    if (!open || !field) continue
    if (field[1] === 'tag') {
      if (field[2]) open.tags.push(field[2])
    } else if (open.lifecycle === null && field[2]) {
      open.lifecycle = field[2]
    }
  }
  return out
}

/**
 * Every issue-tagged contract is `superseded` or the claimed lifecycle, and at least
 * one is that lifecycle. An active or blocked sibling beside a verified contract refuses.
 * PARTIAL maps to `partial`; it is not reported as terminal closure.
 */
export function assessContracts(
  contracts: ChangeContract[],
  issue: number,
  verify: 'VERIFIED' | 'PARTIAL',
): GateResult {
  const tag = `issue-${issue}`
  const matched = contracts.filter((contract) => contract.tags.includes(tag))
  if (matched.length === 0)
    return { pass: false, reason: `no change contract tagged ${tag} is committed at the bound commit` }
  const want = verify === 'VERIFIED' ? 'verified' : 'partial'
  const stale = matched.find((contract) => contract.lifecycle !== 'superseded' && contract.lifecycle !== want)
  if (stale) {
    return {
      pass: false,
      reason: `change contract ${stale.id} is ${stale.lifecycle ?? 'unset'} at the bound commit; a ${verify} proof needs ${want}`,
    }
  }
  if (!matched.some((contract) => contract.lifecycle === want)) {
    return {
      pass: false,
      reason: `no change contract tagged ${tag} is ${want} at the bound commit; a ${verify} proof needs one`,
    }
  }
  return { pass: true }
}

// ── Git object reads at one explicit oid ─────────────────────────────────────

/** `git` in `cwd`: trimmed stdout, reject on a non-zero exit. Production attaches `exitCode`. */
export type GitFn = (cwd: string, args: string[]) => Promise<string>

export type ParseYaml = (text: string) => unknown

const CHANGES_DIR = '.semctx/semantic/changes'
const STACK_FILE = '.dev/stack.yml'

type TreeEntry = { mode: string; type: string; object: string; path: string }

function exitCodeOf(error: unknown): number | null {
  if (error === null || typeof error !== 'object' || !('exitCode' in error)) return null
  const code = error.exitCode
  return typeof code === 'number' && Number.isInteger(code) ? code : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function gitText(git: GitFn, cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).trim()
}

/** Root-relative `git ls-tree` at the bound oid, regardless of caller cwd. Missing objects reject. */
async function treeAt(cwd: string, git: GitFn, oid: string, path: string): Promise<TreeEntry[]> {
  const listing = await gitText(git, cwd, ['ls-tree', '--full-tree', '-z', oid, path])
  return listing
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t')
      const [mode = '', type = '', object = ''] = entry.slice(0, tab).split(' ')
      return { mode, type, object, path: entry.slice(tab + 1) }
    })
}

const isRegularBlob = (entry: TreeEntry) =>
  entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755') && entry.object !== ''

async function committedContracts(cwd: string, git: GitFn, oid: string): Promise<ChangeContract[] | string> {
  const out: ChangeContract[] = []
  for (const entry of await treeAt(cwd, git, oid, `${CHANGES_DIR}/`)) {
    const file = entry.path.slice(CHANGES_DIR.length + 1)
    if (!file.endsWith('.sem')) continue
    if (!isRegularBlob(entry)) return `${entry.path} is not a regular file at ${oid}`
    out.push(...parseChangeContracts(await gitText(git, cwd, ['cat-file', 'blob', entry.object]), file))
  }
  return out
}

function bunYaml(text: string): unknown {
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
    throw new Error('.dev/stack.yml: reading it needs bun >= 1.2.21 (Bun.YAML)')
  }
  return Bun.YAML.parse(text)
}

function parseStack(text: string, parseYaml: ParseYaml): unknown {
  if (!text.trim()) return null
  try {
    return parseYaml(text)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(STACK_FILE)) throw error
    throw new Error(`${STACK_FILE} is not valid YAML: ${errorText(error)}`)
  }
}

/** `commands.test_e2e` is a non-empty string, or a map with a non-empty `run` and no `skip: true`. */
function declaresE2e(doc: unknown): boolean {
  if (doc === null || doc === undefined) return false
  if (!isDict(doc)) throw new Error('.dev/stack.yml: the document is not a map')
  const commands = doc.commands
  if (commands === null || commands === undefined) return false
  if (!isDict(commands)) throw new Error('.dev/stack.yml: commands is not a map')
  const e2e = commands.test_e2e
  if (typeof e2e === 'string') return e2e.trim() !== ''
  return isDict(e2e) && isText(e2e.run) && e2e.skip !== true
}

async function committedE2e(cwd: string, git: GitFn, oid: string, parseYaml: ParseYaml): Promise<boolean> {
  const [entry] = await treeAt(cwd, git, oid, STACK_FILE)
  if (!entry) return false
  if (!isRegularBlob(entry)) throw new Error(`${STACK_FILE} is not a regular file at ${oid}`)
  return declaresE2e(parseStack(await gitText(git, cwd, ['cat-file', 'blob', entry.object]), parseYaml))
}

// ── Applicability: one oid, or a true unborn branch ──────────────────────────

export type Applicability =
  | { applies: false; oid: string | null }
  | { applies: true; oid: string }
  | { applies: true; pass: false; reason: string }

type DiskProbe = { present: boolean; error?: string }

/** ENOENT is absence. A symlink, directory or file is presence. Any other error refuses. */
function probeSemctx(dir: string): DiskProbe {
  try {
    lstatSync(join(dir, '.semctx'))
    return { present: true }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { present: false }
    return { present: false, error: errorText(error) }
  }
}

type Rooted = { root: string; disk: DiskProbe } | { reason: string }

async function rooted(cwd: string, git: GitFn): Promise<Rooted> {
  let root: string
  try {
    root = await gitText(git, cwd, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    return { reason: `no-repo-root: ${errorText(error)}` }
  }
  let principal: string
  try {
    const porcelain = await gitText(git, root, ['worktree', 'list', '--porcelain'])
    const first = porcelain.split('\n').find((line) => line.startsWith('worktree '))
    principal = (first ? first.slice('worktree '.length).trim() : '') || root
  } catch (error) {
    return { reason: `principal-unreadable: ${errorText(error)}` }
  }
  const here = probeSemctx(root)
  if (here.error) return { reason: here.error }
  const there = root === principal ? here : probeSemctx(principal)
  if (there.error) return { reason: there.error }
  return { root, disk: { present: here.present || there.present } }
}

/**
 * True unborn: symbolic-ref names the branch being opened, and `show-ref --verify --quiet`
 * of that branch exits 1. A corrupt missing-object ref exits 128 and is not unborn.
 * `rev-parse HEAD^{commit}` exiting 1 is not enough: corrupt refs do that too.
 */
async function classifyUnborn(
  root: string,
  branch: string,
  git: GitFn,
): Promise<{ unborn: true } | { reason: string }> {
  let symbolic: string
  try {
    symbolic = await gitText(git, root, ['symbolic-ref', '--quiet', 'HEAD'])
  } catch (error) {
    return { reason: errorText(error) }
  }
  if (symbolic !== `refs/heads/${branch}`) {
    return { reason: `HEAD is ${symbolic || 'detached'}, not refs/heads/${branch}` }
  }
  try {
    await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return { reason: `refs/heads/${branch} exists but HEAD is not a commit` }
  } catch (error) {
    if (exitCodeOf(error) === 1) return { unborn: true }
    return { reason: errorText(error) }
  }
}

async function commitHasSemctx(
  root: string,
  git: GitFn,
  oid: string,
): Promise<{ present: boolean } | { reason: string }> {
  try {
    const listing = await gitText(git, root, ['ls-tree', '-z', oid, '.semctx'])
    return { present: listing.length > 0 }
  } catch (error) {
    return { reason: errorText(error) }
  }
}

function decide(disk: DiskProbe, committed: { present: boolean } | { reason: string }, oid: string): Applicability {
  if ('reason' in committed) return { applies: true, pass: false, reason: committed.reason }
  if (!committed.present && !disk.present) return { applies: false, oid }
  return { applies: true, oid }
}

/**
 * Applicability of an open, at the checkout's one commit. A true unborn branch with no
 * on-disk `.semctx` is the only exemption that has no oid. Disk Semctx on an unborn
 * repository refuses. A missing object refuses and never exempts.
 */
export async function openApplicability(cwd: string, branch: string, git: GitFn): Promise<Applicability> {
  const base = await rooted(cwd, git)
  if ('reason' in base) return { applies: true, pass: false, reason: base.reason }
  try {
    const oid = await gitText(git, base.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    if (!COMMIT_SHA.test(oid)) return { applies: true, pass: false, reason: `HEAD is not a commit: ${oid}` }
    return decide(base.disk, await commitHasSemctx(base.root, git, oid), oid)
  } catch {
    const unborn = await classifyUnborn(base.root, branch, git)
    if ('reason' in unborn) return { applies: true, pass: false, reason: unborn.reason }
    if (base.disk.present) return { applies: true, pass: false, reason: 'unborn repository has .semctx on disk' }
    return { applies: false, oid: null }
  }
}

/** Applicability of a land, at the already-approved oid. Never symbolic HEAD. */
export async function landApplicability(cwd: string, oid: string, git: GitFn): Promise<Applicability> {
  const base = await rooted(cwd, git)
  if ('reason' in base) return { applies: true, pass: false, reason: base.reason }
  if (!COMMIT_SHA.test(oid)) return { applies: true, pass: false, reason: `approved head is not a commit: ${oid}` }
  return decide(base.disk, await commitHasSemctx(base.root, git, oid), oid)
}

export type ProofFacts = { pass: true; proof: Proof } | { pass: false; reason: string }

/**
 * Body-independent proof at one bound oid: shape, committed stack, committed contracts,
 * and `proof.head === oid`. Does not read a PR body. Expected git and YAML failures are
 * reasons, not throws. The contract stores no verification commit.
 */
export async function proofFacts(
  cwd: string,
  {
    proof,
    issue,
    oid,
    git,
    parseYaml = bunYaml,
    headMismatch,
  }: {
    proof?: unknown
    issue: number
    oid: string
    git: GitFn
    parseYaml?: ParseYaml
    /** Land's phrase when the proof head is not the approved PR head. */
    headMismatch?: string
  },
): Promise<ProofFacts> {
  const refuse = (reason: string): ProofFacts => ({ pass: false, reason })
  const guard = shape(proof)
  if (!guard.ok) return refuse(guard.reason)
  if (guard.proof.head !== oid)
    return refuse(headMismatch ?? `proof head ${guard.proof.head.slice(0, 7)} is not HEAD ${oid.slice(0, 7)}`)
  let e2e = false
  try {
    e2e = await committedE2e(cwd, git, oid, parseYaml)
  } catch (error) {
    return refuse(errorText(error))
  }
  const verdict = proofGate(guard.proof, { e2e })
  if (!verdict.pass) return refuse(verdict.reason)
  if (guard.proof.verify === 'BLOCKED') return refuse('BLOCKED')
  let committed: ChangeContract[] | string
  try {
    committed = await committedContracts(cwd, git, oid)
  } catch (error) {
    return refuse(errorText(error))
  }
  if (typeof committed === 'string') return refuse(committed)
  const lifecycle = assessContracts(committed, issue, guard.proof.verify)
  if (!lifecycle.pass) return refuse(lifecycle.reason)
  return { pass: true, proof: guard.proof }
}

/**
 * The selected artifact body must literally contain each ui-manual-only check's
 * steps, url and observed. Callers pass the body they selected; a missing body
 * is their refusal, not a pass through here.
 */
export function proofBody(proof: Proof, body: string): GateResult {
  for (const gap of proof.gaps) {
    if (proof.noTest[gap] !== 'ui-manual-only') continue
    const check = proof.uiChecks?.[gap]
    if (!check) return { pass: false, reason: `ui-manual-only gap ${gap} has no uiChecks entry` }
    for (const field of ['steps', 'url', 'observed'] as const) {
      if (!body.includes(check[field])) {
        return { pass: false, reason: `the PR body does not record the browser check for ${gap} (${field})` }
      }
    }
  }
  return { pass: true }
}
