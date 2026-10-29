import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { fixtureUwOperations } from '../testing/action-input-fixtures.ts'
import type { Git, PreparedReviewInputs } from './review-input-contract.ts'
import { prepareReviewInputs } from './review-pr-inputs.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'
import { actionOperationMethods } from './uw-action-operations.ts'
import { sha256Bytes } from './uw-action-result.ts'
import type { UwOperations } from './uw-contract.ts'
import { createProductionActionPorts } from './uw-input-readers.ts'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const PIN = execFileSync('git', ['-C', PLUGIN, 'rev-parse', 'HEAD^{commit}'], { encoding: 'utf8' }).trim()
const CONTEXT_WINDOW = 200_000
const REPOSITORY = 'acme/app'
const VIEWER_HOST = 'assigned-dossier.invalid'
const trustedPin = { repository: 'Roxabi/roxabi-plugins', commit: PIN, installedRoot: PLUGIN }
const roots: string[] = []

type OracleChunk = { index: number; delta: string[]; diff: string; digest: string }
type Candidate = { root: string; cwd: string; base: string; head: string; bare: string }

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgSign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim()
}

function runGit(cwd: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  try {
    return {
      code: 0,
      stdout: execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
      stderr: '',
    }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
    const stdout = failed.stdout === undefined ? '' : String(failed.stdout)
    const stderr = failed.stderr === undefined ? '' : String(failed.stderr)
    return { code: typeof failed.status === 'number' ? failed.status : 1, stdout, stderr }
  }
}

function reviewingGit(bare: string): Git {
  const origin = `https://github.com/${REPOSITORY}.git`
  return async (cwd, args) => {
    const commanded = args[0] === 'fetch' ? args.map((arg) => (arg === origin ? bare : arg)) : args
    return runGit(cwd, commanded)
  }
}

function source(sentinel: string, binding: string, value: number): string {
  return `${sentinel}\npad-1\npad-2\npad-3\npad-4\npad-5\npad-6\nexport const ${binding} = ${value}\n`
}

function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

function pluginBlob(gitPath: string): Buffer | null {
  const prefix = 'plugins/omp-build/'
  if (!gitPath.startsWith(prefix)) return null
  const relative = gitPath.slice(prefix.length)
  if (relative.length === 0 || relative.split('/').includes('..')) return null
  try {
    return readFileSync(join(PLUGIN, relative))
  } catch {
    return null
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function form(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function candidateRepo(): Candidate {
  const root = mkdtempSync(join(tmpdir(), 'omp-assigned-dossier-'))
  roots.push(root)
  const cwd = join(root, 'candidate')
  const origin = join(root, 'origin.git')
  mkdirSync(cwd)
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['config', 'core.autocrlf', 'false'])
  mkdirSync(join(cwd, 'alpha'))
  mkdirSync(join(cwd, 'beta'))
  writeFileSync(join(cwd, 'alpha/kept.ts'), source('UNCHANGED_SENTINEL_ALPHA', 'alpha', 1))
  writeFileSync(join(cwd, 'beta/kept.ts'), source('UNCHANGED_SENTINEL_BETA', 'beta', 1))
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-qm', 'base'])
  const base = git(cwd, ['rev-parse', 'HEAD'])
  git(root, ['clone', '-q', '--bare', cwd, origin])
  git(cwd, ['remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`])
  writeFileSync(join(cwd, 'alpha/kept.ts'), source('UNCHANGED_SENTINEL_ALPHA', 'alpha', 2))
  writeFileSync(join(cwd, 'beta/kept.ts'), source('UNCHANGED_SENTINEL_BETA', 'beta', 2))
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-qm', 'candidate'])
  return { root, cwd, base, head: git(cwd, ['rev-parse', 'HEAD']), bare: origin }
}

function chunkOracle(cwd: string, base: string, head: string): OracleChunk[] {
  const rawDiff = execFileSync('git', ['-C', cwd, 'diff', '--no-ext-diff', '--binary', base, head], {
    encoding: 'utf8',
  })
  const helper = join(PLUGIN, 'skills/dev-review/prepare_context.py')
  const stdout = execFileSync('python3', [helper], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ rawDiff, contextWindow: CONTEXT_WINDOW }),
    maxBuffer: 64 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as { ok?: boolean; chunks?: OracleChunk[] }
  if (parsed.ok !== true || !Array.isArray(parsed.chunks)) {
    throw new Error('prepare_context.py refused the candidate diff')
  }
  return parsed.chunks
}

function requireTwoChunks(oracle: readonly OracleChunk[]): void {
  const first = oracle[0]
  const second = oracle[1]
  if (oracle.length !== 2 || first === undefined || second === undefined) {
    throw new Error(`chunker did not emit two chunks: ${oracle.length}`)
  }
  if (first.delta[0] === undefined || first.delta[0] === second.delta[0]) {
    throw new Error('chunker did not assign the two chunks different paths')
  }
  // prepare_context.py keeps hunk text only. The diff --git header, which carries the path, is dropped.
  if (first.diff === second.diff) throw new Error('chunk hunks collided; assigned diffs cannot be told apart')
  if (first.diff.includes('UNCHANGED_SENTINEL_ALPHA') || second.diff.includes('UNCHANGED_SENTINEL_BETA')) {
    throw new Error('unchanged sentinel leaked into a chunk diff')
  }
}

function pullRequestView(argv: readonly string[], candidate: Candidate): string {
  const fields = flag(argv, '--json')
  if (argv[2] !== '7' || fields === undefined) throw new Error(`unexpected gh argv: ${JSON.stringify(argv)}`)
  const viewed: Record<string, unknown> = {
    number: 7,
    state: 'OPEN',
    mergeCommit: null,
    headRefOid: candidate.head,
    headRefName: 'feat/two-chunks',
    baseRefName: 'main',
    baseRefOid: candidate.base,
    author: { login: 'automation' },
    body: 'Ship two chunks\n',
  }
  const picked: Record<string, unknown> = {}
  for (const field of fields.split(',')) {
    if (!Object.hasOwn(viewed, field)) throw new Error(`unexpected pr field ${field}`)
    picked[field] = viewed[field]
  }
  return JSON.stringify(picked)
}

function pluginObject(expression: string, blobs: Map<string, Buffer>) {
  if (!expression.startsWith(`${PIN}:`)) return null
  const bytes = pluginBlob(expression.slice(expression.indexOf(':') + 1))
  if (bytes === null) return null
  const oid = gitBlobSha(bytes)
  blobs.set(oid, bytes)
  const text = bytes.toString('utf8')
  const isBinary = bytes.includes(0) || !Buffer.from(text).equals(bytes)
  return { oid, byteSize: bytes.byteLength, isBinary, isTruncated: false, text: isBinary ? null : text }
}

function graphqlAnswer(argv: readonly string[], blobs: Map<string, Buffer>): string {
  const query = form(argv, 'query') ?? ''
  const fields = [...query.matchAll(/(?:(\w+)\s*:\s*)?\bobject\s*\(\s*expression\s*:\s*\$(\w+)\s*\)/g)]
  if (fields.length > 0) {
    const repository: Record<string, unknown> = {}
    for (const field of fields) {
      repository[field[1] ?? 'object'] = pluginObject(form(argv, field[2] ?? '') ?? '', blobs)
    }
    return JSON.stringify({ data: { repository } })
  }
  if (query.includes('lastEditedAt')) {
    return JSON.stringify({
      data: { repository: { pullRequest: { body: 'Ship two chunks\n', lastEditedAt: '2026-10-21T00:00:00Z' } } },
    })
  }
  throw new Error(`unexpected graphql: ${query.slice(0, 180)}`)
}

function blobAnswer(argv: readonly string[], blobs: ReadonlyMap<string, Buffer>): string | null {
  const blob = argv.find((arg) => arg.startsWith('repos/Roxabi/roxabi-plugins/git/blobs/'))
  if (argv[0] !== 'api' || blob === undefined) return null
  const oid = blob.slice(blob.lastIndexOf('/') + 1)
  const bytes = blobs.get(oid)
  if (bytes === undefined) throw new Error(`unknown plugin blob ${oid}`)
  return JSON.stringify({ sha: oid, size: bytes.byteLength, encoding: 'base64', content: bytes.toString('base64') })
}

function commitAnswer(argv: readonly string[]): string | null {
  const route = argv.find((arg) => /^repos\/Roxabi\/roxabi-plugins\/git\/commits\/[0-9a-f]{40}$/.test(arg))
  if (argv[0] !== 'api' || route === undefined) return null
  const oid = route.slice(route.lastIndexOf('/') + 1)
  const sha = execFileSync('git', ['-C', PLUGIN, 'rev-parse', `${oid}^{commit}`], { encoding: 'utf8' }).trim()
  return JSON.stringify({ sha })
}

function unexpected(argv: readonly string[]): never {
  throw new Error(`unexpected gh argv: ${JSON.stringify(argv)}`)
}

function basicGithubAnswer(argv: readonly string[], candidate: Candidate): string | null {
  if (argv[0] === 'api' && argv[1] === 'user') return 'automation\n'
  if (argv[0] === 'variable' && argv[1] === 'get' && argv[2] === 'OMP_BUILD_TOOLING_SHA') return `${PIN}\n`
  if (argv[0] === 'repo' && argv[1] === 'view' && argv.at(-1) === 'nameWithOwner') {
    return JSON.stringify({ nameWithOwner: REPOSITORY })
  }
  if (argv[0] === 'pr' && argv[1] === 'view') return pullRequestView(argv, candidate)
  return null
}

function githubIngress(candidate: Candidate): (cwd: string, argv: string[]) => Promise<string> {
  const blobs = new Map<string, Buffer>()
  return async (_cwd, argv) => {
    const basic = basicGithubAnswer(argv, candidate)
    if (basic !== null) return basic
    if (argv[0] === 'api' && argv.some((arg) => arg.startsWith(`repos/${REPOSITORY}/issues/7/comments`))) return '[]'
    if (argv[0] === 'api' && argv[1] === 'graphql') return graphqlAnswer(argv, blobs)
    return blobAnswer(argv, blobs) ?? commitAnswer(argv) ?? unexpected(argv)
  }
}

function reviewOperations(candidate: Candidate, gh: (cwd: string, argv: string[]) => Promise<string>): UwOperations {
  return {
    ...fixtureUwOperations(),
    ...actionOperationMethods({
      actions: createProductionActionPorts({
        cwd: candidate.cwd,
        gh,
        readAuthor: 'automation',
        artifactsDir: join(candidate.root, 'artifacts'),
        pluginPin: trustedPin,
      }),
    }),
  }
}

function sealedFiles(indexPath: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name)
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`
      if (lstatSync(absolute).isDirectory()) walk(absolute, relative)
      else files.set(relative, readFileSync(absolute))
    }
  }
  walk(dirname(indexPath), '')
  return files
}

function pathWithBytes(files: ReadonlyMap<string, Buffer>, bytes: Buffer): string | undefined {
  for (const [path, value] of files) if (value.equals(bytes)) return path
  return undefined
}

function namesAssignedChunk(text: string, chunk: number): boolean {
  return new RegExp(`assigned[^\\n]{0,40}\\b${chunk}\\b`, 'i').test(text)
}

function panel(actions: PreparedReviewInputs['actions'], chunk: number): PreparedUwAction {
  const found = Object.entries(actions).find(([name]) => name.startsWith(`panel-${chunk}-`))
  if (found === undefined) throw new Error(`panel-${chunk} missing: ${Object.keys(actions).join(',')}`)
  return found[1]
}

function dossierOmissions(
  action: PreparedUwAction,
  chunk: OracleChunk,
  oracle: readonly OracleChunk[],
  head: string,
  cwd: string,
): string[] {
  const files = sealedFiles(action.snapshot.indexPath)
  const assignment = [...files.entries()]
    .filter(([path]) => path === 'index.md' || path.endsWith('assignment.json'))
    .map(([, bytes]) => bytes.toString('utf8'))
    .join('\n')
  const missing: string[] = []
  if (!namesAssignedChunk(assignment, chunk.index)) {
    missing.push(`panel ${chunk.index} index does not name its assigned chunk`)
  }
  const diffPath = pathWithBytes(files, Buffer.from(chunk.diff, 'utf8'))
  if (diffPath === undefined || diffPath === 'diff.patch') {
    missing.push(`panel ${chunk.index} has no assigned chunk diff`)
  }
  for (const item of oracle) {
    if (pathWithBytes(files, Buffer.from(item.digest, 'utf8')) === undefined) {
      missing.push(`panel ${chunk.index} omitted digest ${item.index}`)
    }
  }
  const path = chunk.delta[0]
  if (path === undefined) throw new Error(`chunk ${chunk.index} has no path`)
  const pinned = execFileSync('git', ['-C', cwd, 'cat-file', 'blob', `${head}:${path}`])
  const sentinel = path.startsWith('alpha/') ? 'UNCHANGED_SENTINEL_ALPHA' : 'UNCHANGED_SENTINEL_BETA'
  if (!pinned.includes(Buffer.from(sentinel))) throw new Error(`pinned ${path} lost its unchanged sentinel`)
  if (pathWithBytes(files, pinned) === undefined) missing.push(`panel ${chunk.index} omitted full pinned source`)
  if (diffPath !== undefined && files.get(diffPath)?.includes(Buffer.from(sentinel))) {
    missing.push(`panel ${chunk.index} assigned diff contains an unchanged sentinel`)
  }
  return missing
}

function missingHeadSourceRefs(prepared: PreparedReviewInputs, cwd: string, base: string, head: string): string[] {
  const changed = execFileSync('git', ['-C', cwd, 'diff', '--name-only', '-z', base, head])
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0)
  const missing: string[] = []
  if (changed.length === 0) missing.push('no changed HEAD source')
  for (const action of Object.values(prepared.actions)) {
    const code = action.inputs.manifest.code
    for (const path of changed) {
      const bytes = execFileSync('git', ['-C', cwd, 'cat-file', 'blob', `${head}:${path}`])
      const digest = sha256Bytes(bytes)
      const pinned = action.inputs.manifest.repositoryReferences.some(
        (ref) =>
          ref.repository === code.repository && ref.commit === code.head && ref.path === path && ref.digest === digest,
      )
      if (!pinned || code.head !== head) missing.push(`${action.snapshot.actionId} ${path}`)
    }
  }
  return missing
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('sealed panel dossiers keep the assigned chunk diff, both digests, and full source', async () => {
  const previousHost = process.env.GH_HOST
  process.env.GH_HOST = VIEWER_HOST
  try {
    const candidate = candidateRepo()
    const oracle = chunkOracle(candidate.cwd, candidate.base, candidate.head)
    requireTwoChunks(oracle)
    const gh = githubIngress(candidate)
    const operations = reviewOperations(candidate, gh)
    const prepared = await prepareReviewInputs({
      cwd: candidate.cwd,
      pr: 7,
      contextWindow: CONTEXT_WINDOW,
      gh,
      git: reviewingGit(candidate.bare),
      operations,
      pluginPin: trustedPin,
    })
    if (!prepared.ok) throw new Error(prepared.diagnostics.map((item) => `${item.code}: ${item.message}`).join('\n'))
    const fingerprints = Object.values(prepared.value.actions).map((action) => action.inputs.fingerprint)
    expect(new Set(fingerprints).size).toBe(1)
    const missing = oracle.flatMap((chunk) =>
      dossierOmissions(panel(prepared.value.actions, chunk.index), chunk, oracle, candidate.head, candidate.cwd),
    )
    expect(missing).toEqual([])
    expect(missingHeadSourceRefs(prepared.value, candidate.cwd, candidate.base, candidate.head)).toEqual([])
    const first = panel(prepared.value.actions, 0)
    chmodSync(first.snapshot.indexPath, 0o644)
    writeFileSync(first.snapshot.indexPath, 'tampered\n')
    expect((await operations.verifyAction(first.snapshot)).ok).toBe(false)
  } finally {
    if (previousHost === undefined) delete process.env.GH_HOST
    else process.env.GH_HOST = previousHost
  }
})
