import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import type { Context } from './sim-command-context.ts'
import { writeStdout } from './sim-invocation.ts'
import { statePath } from './sim-state.ts'
import { fail } from './sim-types.ts'

declare const OMP_SIM_PHYSICAL_TOOLING_ROOT: string | undefined
const PLUGIN =
  typeof OMP_SIM_PHYSICAL_TOOLING_ROOT === 'string'
    ? OMP_SIM_PHYSICAL_TOOLING_ROOT
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const PREFIX = 'plugins/omp-build/'
const VARIABLE = 'OMP_BUILD_TOOLING_SHA'
const REPOSITORY = 'Roxabi/roxabi-plugins'
const BLOB = /^\/?repos\/Roxabi\/roxabi-plugins\/git\/blobs\/([0-9a-f]{40})$/
const COMMIT = /^\/?repos\/Roxabi\/roxabi-plugins\/git\/commits\/([0-9a-f]{40})$/
const SHA = /^[0-9a-f]{40}$/
const SKIP: Record<string, true> = { node_modules: true, dist: true, coverage: true, '.git': true }

const gitEnv = { ...process.env }
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
  delete gitEnv[key]
}
gitEnv.GIT_AUTHOR_NAME = 'fixture'
gitEnv.GIT_AUTHOR_EMAIL = 'fixture@example.invalid'
gitEnv.GIT_COMMITTER_NAME = 'fixture'
gitEnv.GIT_COMMITTER_EMAIL = 'fixture@example.invalid'
gitEnv.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z'
gitEnv.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z'

function git(repo: string, args: string[], encoding: 'utf8'): string
function git(repo: string, args: string[], encoding: 'buffer'): Buffer
function git(repo: string, args: string[], encoding: 'utf8' | 'buffer'): string | Buffer {
  return execFileSync('git', ['-C', repo, ...args], { encoding, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] })
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP[entry.name] || entry.isSymbolicLink()) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else if (entry.isFile()) copyFileSync(source, target)
  }
}

function toolingRepo(): string {
  return join(dirname(statePath()), 'omp-tooling.git')
}

/** One temp commit of the installed plugin tree. Not the product repository and not HEAD. */
function toolingCommit(): string {
  const repo = toolingRepo()
  const packagePath = 'plugins/omp-build/package.json'
  try {
    const head = git(repo, ['rev-parse', 'HEAD'], 'utf8').trim()
    const pinned = git(repo, ['rev-parse', `HEAD:${packagePath}`], 'utf8').trim()
    const installed = git(repo, ['hash-object', join(PLUGIN, 'package.json')], 'utf8').trim()
    if (SHA.test(head) && pinned === installed) return head
  } catch {
    // Recreate when the temp commit is missing or its package blob drifted.
  }
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'], 'utf8')
  copyTree(PLUGIN, join(repo, PREFIX))
  git(repo, ['add', '-A'], 'utf8')
  git(repo, ['commit', '-qm', 'fixture: immutable tooling pin'], 'utf8')
  const head = git(repo, ['rev-parse', 'HEAD'], 'utf8').trim()
  if (!SHA.test(head)) fail('gh: tooling fixture commit is not a Git object')
  return head
}

/** Read loose fixture Git objects directly; packed or unavailable objects fall back to Git. */
function looseObject(oid: string, type: string): Buffer {
  if (!SHA.test(oid)) throw new Error('invalid object id')
  const raw = inflateSync(readFileSync(join(toolingRepo(), '.git', 'objects', oid.slice(0, 2), oid.slice(2))))
  const split = raw.indexOf(0)
  const body = raw.subarray(split + 1)
  if (
    split < 0 ||
    raw.subarray(0, split).toString() !== `${type} ${body.length}` ||
    createHash('sha1').update(raw).digest('hex') !== oid
  )
    throw new Error('invalid loose object')
  return body
}

function looseHead(): string {
  const gitDir = join(toolingRepo(), '.git')
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  const value =
    head === 'ref: refs/heads/main' ? readFileSync(join(gitDir, 'refs', 'heads', 'main'), 'utf8').trim() : head
  if (!SHA.test(value)) throw new Error('invalid fixture HEAD')
  return value
}

function looseTreeEntry(tree: string, part: string): { mode: string; oid: string } {
  const bytes = looseObject(tree, 'tree')
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset)
    const nul = bytes.indexOf(0, space + 1)
    if (space < 0 || nul < 0 || nul + 21 > bytes.length) throw new Error('invalid tree')
    if (bytes.subarray(space + 1, nul).toString('utf8') === part) {
      return {
        mode: bytes.subarray(offset, space).toString(),
        oid: bytes.subarray(nul + 1, nul + 21).toString('hex'),
      }
    }
    offset = nul + 21
  }
  throw new Error('missing path')
}

function loosePath(commit: string, path: string): string {
  const header = looseObject(commit, 'commit')
    .toString('utf8')
    .match(/^tree ([0-9a-f]{40})\n/)
  if (header === null) throw new Error('invalid commit tree')
  let tree = header[1]
  if (tree === undefined) throw new Error('missing commit tree')
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('invalid path')
  for (const [index, part] of parts.entries()) {
    const match = looseTreeEntry(tree, part)
    if (index < parts.length - 1 && match.mode !== '40000') throw new Error('missing path')
    tree = match.oid
  }
  return tree
}

function blobBytes(oid: string): Buffer | null {
  try {
    return looseObject(oid, 'blob')
  } catch {
    try {
      return git(toolingRepo(), ['cat-file', 'blob', oid], 'buffer')
    } catch {
      return null
    }
  }
}

function commitExists(oid: string): boolean {
  try {
    looseObject(oid, 'commit')
    return true
  } catch {
    try {
      return git(toolingRepo(), ['cat-file', '-t', oid], 'utf8').trim() === 'commit'
    } catch {
      return false
    }
  }
}

function blobObject(oid: string): Record<string, unknown> {
  const bytes = blobBytes(oid)
  if (bytes === null) return {}
  let text: string | null = null
  try {
    if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    // Non-UTF-8 content uses the raw blob route.
  }
  const isTruncated = bytes.byteLength > 1_000_000
  return { oid, byteSize: bytes.byteLength, isBinary: text === null, isTruncated, text: isTruncated ? null : text }
}

export function toolingVariable(context: Context): boolean {
  if (context.cmd !== 'variable' || context.sub !== 'get' || context.positionals[2] !== VARIABLE) return false
  if (context.flag.get('--repo')?.at(-1) !== REPOSITORY) return false
  writeStdout(`${toolingCommit()}\n`)
  return true
}

function toolingObject(expression: string): { oid: string } | null {
  if (!SHA.test(expression.slice(0, 40)) || expression[40] !== ':') return null
  try {
    const commit = expression.slice(0, 40)
    try {
      if (looseHead() !== commit) return null
      return { oid: loosePath(commit, expression.slice(41)) }
    } catch {
      // Packed objects and nonstandard fixture repositories retain Git's exact semantics.
      const [head, oid] = git(toolingRepo(), ['rev-parse', 'HEAD', expression], 'utf8').trim().split('\n')
      if (head !== commit || oid === undefined || !SHA.test(oid)) return null
      return { oid }
    }
  } catch {
    return null
  }
}

export function toolingGraphql(query: string, vars: Record<string, string>): unknown | undefined {
  if (vars.owner !== 'Roxabi' || vars.name !== 'roxabi-plugins') return undefined
  const fields = [...query.matchAll(/(?:(\w+)\s*:\s*)?\bobject\s*\(\s*expression\s*:\s*\$(\w+)\s*\)/g)]
  if (fields.length === 0) return undefined
  const includesBlobText = /\bbyteSize\b/.test(query)
  const repository: Record<string, Record<string, unknown> | null> = {}
  for (const field of fields) {
    const object = toolingObject(vars[field[2] ?? ''] ?? '')
    repository[field[1] ?? 'object'] = object !== null && includesBlobText ? blobObject(object.oid) : object
  }
  return { data: { repository } }
}

export function toolingBlobRoute(context: Context): boolean {
  const method = context.flag.get('--method')?.at(-1)
  if (method !== undefined && method !== 'GET') return false
  const commit = context.sub?.match(COMMIT)?.[1]
  if (commit !== undefined) {
    if (!commitExists(commit)) fail(`gh: tooling commit ${commit} is not in the fixture repository`)
    writeStdout(`${JSON.stringify({ sha: commit })}\n`)
    return true
  }
  const oid = context.sub?.match(BLOB)?.[1]
  if (oid === undefined) return false
  const bytes = blobBytes(oid)
  if (bytes === null) fail(`gh: tooling blob ${oid} is not in the fixture commit`)
  writeStdout(
    `${JSON.stringify({ encoding: 'base64', content: bytes.toString('base64'), sha: oid, size: bytes.byteLength })}\n`,
  )
  return true
}
