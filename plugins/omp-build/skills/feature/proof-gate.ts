import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type VerifyStatus = 'VERIFIED' | 'PARTIAL' | 'BLOCKED'
export type AssertledgerVerdict = 'detection' | 'WEAK_ORACLE' | 'miss' | null

/** dev-review step 5's NO TEST enum: the only reasons a PARTIAL gap may carry. */
export const NO_TEST_REASONS = ['infra-not-wired', 'prompt-logic-only', 'ui-manual-only', 'out-of-scope'] as const

/** An agent browser check (dev-review 5a): what was done, where, and what was seen. */
export type UiCheck = { steps: string; url: string; observed: string }

/** The proof `/feature` builds for a PR: what `semctx_change_verify` and the NO TEST rows said, bound to a commit. */
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
const VERIFY: readonly unknown[] = ['VERIFIED', 'PARTIAL', 'BLOCKED']
const ASSERTLEDGER: readonly unknown[] = ['detection', 'WEAK_ORACLE', 'miss', null]
const COMMIT_SHA = /^[0-9a-f]{40}$/
/** An absolute URL or a site path: the place the check was made. */
const URL_OR_PATH = /^(?:https?:\/\/\S+|\/\S*)$/

type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** The proof's shape, before any rule reads it. Never throws, never passes a doubtful value on. */
function shape(input: unknown): Guard {
  const bad = (what: string): Guard => ({ ok: false, reason: `malformed proof: ${what}` })
  if (!isDict(input)) return bad('not an object')
  for (const key of Object.keys(input)) if (!PROOF_KEYS.includes(key)) return bad(`unknown key ${JSON.stringify(key)}`)
  if (typeof input.head !== 'string' || !COMMIT_SHA.test(input.head)) return bad('head is not a 40-hex commit sha')
  if (!VERIFY.includes(input.verify)) return bad('verify is not VERIFIED, PARTIAL or BLOCKED')
  if (!Array.isArray(input.gaps) || !input.gaps.every(isText)) return bad('gaps is not a list of names')
  if (!isDict(input.noTest) || !Object.values(input.noTest).every((reason) => typeof reason === 'string')) {
    return bad('noTest is not a map of gap to reason')
  }
  if (input.uiChecks !== undefined) {
    if (!isDict(input.uiChecks)) return bad('uiChecks is not a map of gap to check')
    for (const [gap, check] of Object.entries(input.uiChecks)) {
      if (!isDict(check)) return bad(`uiChecks.${gap} is not an object`)
      for (const key of Object.keys(check)) {
        if (!UI_CHECK_KEYS.includes(key)) return bad(`uiChecks.${gap} has unknown key ${JSON.stringify(key)}`)
      }
      for (const key of UI_CHECK_KEYS) {
        if (typeof check[key] !== 'string') return bad(`uiChecks.${gap}.${key} is missing`)
      }
    }
  }
  if (!ASSERTLEDGER.includes(input.assertledger as AssertledgerVerdict)) return bad('assertledger is not a verdict')
  if (typeof input.hasAdapter !== 'boolean') return bad('hasAdapter is not a boolean')
  if (typeof input.typeFix !== 'boolean') return bad('typeFix is not a boolean')
  return { ok: true, proof: input as unknown as Proof }
}

const has = (map: object, key: string) => Object.hasOwn(map, key)

/** Why a recorded browser check does not stand, or `null` when it does. */
function uiCheckFault(gap: string, check: UiCheck | undefined): string | null {
  if (!check) return `ui-manual-only gap ${gap} has no uiChecks entry`
  if (!isText(check.steps)) return `uiChecks.${gap}.steps is empty`
  if (!isText(check.observed)) return `uiChecks.${gap}.observed is empty`
  if (!URL_OR_PATH.test(check.url.trim())) return `uiChecks.${gap}.url is not a URL or a path`
  return null
}

/**
 * The proof, judged. `e2e` is whether `.dev/stack.yml` declares `commands.test_e2e`: then
 * the e2e command is the UI proof and `ui-manual-only` is refused. The gate has no diff, so
 * this is stricter than dev-review 5a, which only fires when the diff touches the frontend.
 */
export function proofGate(input: unknown, { e2e = false }: { e2e?: boolean } = {}): GateResult {
  const guard = shape(input)
  if (!guard.ok) return { pass: false, reason: guard.reason }
  const { proof } = guard
  if (proof.verify === 'BLOCKED') return { pass: false, reason: 'BLOCKED' }
  if (proof.verify === 'PARTIAL') {
    if (proof.gaps.length === 0) return { pass: false, reason: 'PARTIAL names no gap' }
    const reasonOf = (gap: string) => (has(proof.noTest, gap) ? proof.noTest[gap] : '')
    const unjustified = proof.gaps.filter((gap) => !(NO_TEST_REASONS as readonly string[]).includes(reasonOf(gap)))
    if (unjustified.length) return { pass: false, reason: `unjustified PARTIAL: ${unjustified.join(', ')}` }
    for (const gap of proof.gaps.filter((name) => reasonOf(name) === 'ui-manual-only')) {
      if (e2e) return { pass: false, reason: `ui-manual-only refused for ${gap}: commands.test_e2e is declared` }
      const fault = uiCheckFault(gap, proof.uiChecks && has(proof.uiChecks, gap) ? proof.uiChecks[gap] : undefined)
      if (fault) return { pass: false, reason: fault }
    }
  }
  if (proof.typeFix && proof.hasAdapter && proof.assertledger !== 'detection') {
    return { pass: false, reason: proof.assertledger ?? 'assertledger-missing' }
  }
  return { pass: true }
}

// ── Change contracts: the real semctx grammar ─────────────────────────────────

export type ChangeContract = { id: string; lifecycle: string | null; tags: string[]; file: string }

const BLOCK_HEADER = /^(goal|invariant|decision|assumption|unknown|change|evidence|relation) (\S+)\s*$/
const FIELD = /^ {2}(status|tag):[ \t]*(.*?)\s*$/

/**
 * The change contracts of `<root>/.semctx/semantic/changes/*.sem`. A block opens on a
 * column-0 `<kind> <id>` line and runs to the next column-0 non-blank line; its fields are
 * indented two spaces. Only `change` blocks are contracts, and a contract's lifecycle is its
 * own `status:` — `invariant` and `evidence` blocks carry other vocabularies there. A
 * contract with no `status:` has `lifecycle: null`. No `changes/` directory: no contracts.
 */
export function readChangeContracts(root: string): ChangeContract[] {
  const dir = join(root, '.semctx', 'semantic', 'changes')
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sem'))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return []
    }
    throw error
  }
  const out: ChangeContract[] = []
  for (const file of entries) {
    let open: ChangeContract | null = null
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const text = line.endsWith('\r') ? line.slice(0, -1) : line
      if (text.trim() === '') continue
      if (!text.startsWith(' ') && !text.startsWith('\t')) {
        const header = BLOCK_HEADER.exec(text)
        open = header?.[1] === 'change' ? { id: header[2] as string, lifecycle: null, tags: [], file } : null
        if (open) out.push(open)
        continue
      }
      const field = open ? FIELD.exec(text) : null
      if (!open || !field) continue
      if (field[1] === 'tag') {
        if (field[2]) open.tags.push(field[2])
      } else if (open.lifecycle === null && field[2]) {
        open.lifecycle = field[2]
      }
    }
  }
  return out
}

// ── `.dev/stack.yml` ──────────────────────────────────────────────────────────

export type ParseYaml = (text: string) => unknown

function bunYaml(text: string): unknown {
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
    throw new Error('.dev/stack.yml: reading it needs bun >= 1.2.21 (Bun.YAML)')
  }
  return Bun.YAML.parse(text)
}

/**
 * The parsed `<root>/.dev/stack.yml` document, or `null` when the file is absent or blank.
 * Throws when it is not valid YAML. `readLanding` and `proofCheck` both read it here.
 */
export function readStack(root: string, parseYaml: ParseYaml = bunYaml): unknown {
  let text: string
  try {
    text = readFileSync(join(root, '.dev', 'stack.yml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!text.trim()) return null
  try {
    return parseYaml(text)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('.dev/stack.yml')) throw error
    throw new Error(`.dev/stack.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
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

// ── The gate, applied to a repository ─────────────────────────────────────────

/** `git` run in `cwd`, resolving to its trimmed stdout and rejecting on a non-zero exit. */
export type GitFn = (cwd: string, args: string[]) => Promise<string>

export type ProofCheck =
  | { applies: false }
  | { applies: true; pass: true }
  | { applies: true; pass: false; reason: string }

type EntryKind = 'absent' | 'dir' | 'file' | 'symlink' | 'other'

/** What `path` is, without following a symlink. */
function entryKind(path: string): EntryKind {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'dir'
    if (stat.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}

/** Why `<root>/.semctx` cannot be trusted as a tree of plain directories and files, or `null`. */
function semctxFault(root: string): string | null {
  const semantic = join(root, '.semctx', 'semantic')
  const levels: [string, string][] = [
    [join(root, '.semctx'), '.semctx'],
    [semantic, '.semctx/semantic'],
    [join(semantic, 'changes'), '.semctx/semantic/changes'],
  ]
  for (const [path, name] of levels) {
    const kind = entryKind(path)
    if (kind === 'absent') return null
    if (kind !== 'dir') return `${name} ${kind === 'symlink' ? 'is a symlink' : 'is not a directory'}`
  }
  const changes = join(semantic, 'changes')
  for (const name of readdirSync(changes).filter((entry) => entry.endsWith('.sem'))) {
    const kind = entryKind(join(changes, name))
    if (kind !== 'file') return `.semctx/semantic/changes/${name} is ${kind === 'symlink' ? 'a symlink' : 'not a file'}`
  }
  return null
}

/** The first worktree `git worktree list --porcelain` names: the principal checkout. */
function principalOf(porcelain: string): string | null {
  const first = porcelain.split('\n').find((line) => line.startsWith('worktree '))
  return first ? first.slice('worktree '.length) : null
}

/**
 * The proof gate on a working tree. It applies when the repository (this worktree or its
 * principal) has a `.semctx`; otherwise the repository does not use semctx and nothing is
 * checked. Once it applies, anything unreadable or doubtful is a refusal, never a pass.
 *
 * The ticket's contracts are the `change` blocks tagged `issue-<issue>`: each is
 * `superseded` or at the lifecycle the proof claims (VERIFIED → `verified`, PARTIAL →
 * `partial`), and at least one is. Other contracts are not the ticket's and are ignored.
 * `body`, when given, is the PR body: it must carry every recorded browser check.
 */
export async function proofCheck(
  cwd: string,
  {
    proof,
    issue,
    body,
    git,
    parseYaml,
  }: { proof?: unknown; issue: number | string | null; body?: string; git: GitFn; parseYaml?: ParseYaml },
): Promise<ProofCheck> {
  const refuse = (reason: string): ProofCheck => ({ applies: true, pass: false, reason })
  let root: string
  try {
    root = await git(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    return refuse('no-repo-root')
  }
  let principal: string
  try {
    principal = principalOf(await git(root, ['worktree', 'list', '--porcelain'])) ?? root
  } catch {
    return refuse('principal-unreadable')
  }
  if (entryKind(join(root, '.semctx')) === 'absent' && entryKind(join(principal, '.semctx')) === 'absent') {
    return { applies: false }
  }

  const fault = semctxFault(root)
  if (fault) return refuse(fault)
  if (proof === undefined || proof === null) return refuse('no proof supplied')

  let e2e: boolean
  try {
    e2e = declaresE2e(readStack(root, parseYaml))
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  const verdict = proofGate(proof, { e2e })
  if (!verdict.pass) return refuse(verdict.reason)
  const checked = proof as Proof

  let head: string
  let dirty: string
  try {
    head = await git(root, ['rev-parse', 'HEAD'])
    dirty = await git(root, ['status', '--porcelain', '--untracked-files=no', '--', '.semctx'])
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  if (checked.head !== head) return refuse(`proof head ${checked.head.slice(0, 7)} is not HEAD ${head.slice(0, 7)}`)
  if (dirty) return refuse('tracked files under .semctx are modified; commit the contract change first')

  const ticket = Number(issue)
  if (!Number.isInteger(ticket) || ticket <= 0) return refuse('no ticket number')
  const tag = `issue-${ticket}`
  const contracts = readChangeContracts(root).filter((contract) => contract.tags.includes(tag))
  if (contracts.length === 0) return refuse(`no change contract tagged ${tag}`)
  const want = checked.verify === 'VERIFIED' ? 'verified' : 'partial'
  const stale = contracts.find((contract) => contract.lifecycle !== 'superseded' && contract.lifecycle !== want)
  if (stale) {
    return refuse(
      `change contract ${stale.id} is ${stale.lifecycle ?? 'unset'}; a ${checked.verify} proof needs ${want}`,
    )
  }
  if (!contracts.some((contract) => contract.lifecycle === want)) {
    return refuse(`no change contract tagged ${tag} is ${want}; a ${checked.verify} proof needs one`)
  }

  if (body !== undefined) {
    for (const [gap, check] of Object.entries(checked.uiChecks ?? {})) {
      if (!body.includes(check.url) || !body.includes(check.observed)) {
        return refuse(`the PR body does not record the browser check for ${gap} (its url and observed result)`)
      }
    }
  }
  return { applies: true, pass: true }
}
