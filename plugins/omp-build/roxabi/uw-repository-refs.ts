import type { Gh } from '../adapters/github/types.ts'
import type { Result } from '../engine/result.ts'
import { repoRelativePathSchema } from '../engine/schema-primitives.ts'
import { PROJECT_CONTRACT_FILES } from '../hooks/lib/contract-paths.cjs'
import type { PinnedFileRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'
import { changedPaths, checkoutRepository, gitTreePaths, readGitFileBytes } from './uw-git-bytes.ts'

const ENTRY = ['AGENTS.md', 'CLAUDE.md', 'GLOSSARY.md'] as const

function citationRaw(trimmed: string): { raw: string; literal: boolean } | null {
  const quoted = /^(?:glossary|glossaire)\s*:\s*`([^`]+)`/i.exec(trimmed)
  if (quoted?.[1] !== undefined) return { raw: quoted[1], literal: true }
  const linked = /^(?:glossary|glossaire)\s*:.*\]\(([^)\s]+)/i.exec(trimmed)
  if (linked?.[1] !== undefined) return { raw: linked[1], literal: false }
  const declared = /^(?:glossary|glossaire)\s*:\s*(\S+)/i.exec(trimmed)
  if (declared?.[1] === undefined) return null
  return { raw: declared[1], literal: true }
}

function pinnedCitation(raw: string, literal: boolean): string | null {
  const path = (literal ? raw : (raw.split('#')[0] ?? '')).replace(/^\.\//, '')
  const segments = path.split('/')
  if (!repoRelativePathSchema.safeParse(path).success) return null
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null
  return path
}

function documentedReferences(bytes: Uint8Array): Result<readonly string[]> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return actionFailure('action-input-missing', 'Documented repository reference is unreadable')
  }
  const found = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!/^(?:glossary|glossaire)\s*:/i.test(trimmed)) continue
    const cited = citationRaw(trimmed)
    if (cited === null) continue
    const path = pinnedCitation(cited.raw, cited.literal)
    if (path === null)
      return actionFailure('action-input-missing', `Documented repository reference is not a pinned path: ${cited.raw}`)
    found.add(path)
  }
  return { ok: true, value: [...found] }
}

function instructionFile(path: string): boolean {
  return path === 'AGENTS.md' || path.endsWith('/AGENTS.md') || path === 'CLAUDE.md' || path.endsWith('/CLAUDE.md')
}

function addTouchedEntries(names: Set<string>, changed: readonly string[]): void {
  for (const path of changed) {
    const parts = path.split('/')
    parts.pop()
    for (let index = parts.length; index >= 0; index -= 1) {
      const prefix = parts.slice(0, index).join('/')
      for (const name of ENTRY) names.add(prefix.length === 0 ? name : `${prefix}/${name}`)
    }
  }
}

async function readPinned(
  cwd: string,
  repository: string,
  commit: string,
  path: string,
  gh: Gh,
): Promise<Result<Uint8Array>> {
  const bytes = await readGitFileBytes({ repository, commit, path, cwd, gh })
  if (!bytes.ok) return actionFailure('action-input-missing', `Required repository reference is unreadable: ${path}`)
  return bytes
}

async function exists(
  cwd: string,
  repository: string,
  commit: string,
  path: string,
  gh: Gh,
  trees: Map<string, ReadonlySet<string> | null>,
): Promise<Result<boolean>> {
  if (!trees.has(commit)) {
    const tree = await gitTreePaths(cwd, commit)
    trees.set(commit, tree.ok ? new Set(tree.value) : null)
  }
  const paths = trees.get(commit)
  if (paths != null) return { ok: true, value: paths.has(path) }
  const blob = await readGitFileBytes({ repository, commit, path, cwd, gh })
  if (blob.ok) return { ok: true, value: true }
  if (blob.diagnostics.some((item) => item.code === 'pinned-file-incomplete')) return { ok: true, value: false }
  return blob
}

function pinnedRefs(
  repository: string,
  commit: string,
  bytesOf: ReadonlyMap<string, Uint8Array>,
): Result<PinnedFileRef[]> {
  const refs: PinnedFileRef[] = []
  for (const path of [...bytesOf.keys()].sort()) {
    const bytes = bytesOf.get(path)
    if (bytes === undefined)
      return actionFailure('action-input-missing', `Required repository reference is unreadable: ${path}`)
    refs.push({ source: 'git-file', repository, commit, path, digest: sha256Bytes(bytes) })
  }
  return { ok: true, value: refs }
}

async function collectSeeds(
  input: { cwd: string; gh: Gh },
  code: UwActionRequest['code'],
  names: ReadonlySet<string>,
  trees: Map<string, ReadonlySet<string> | null>,
): Promise<Result<{ bytesOf: Map<string, Uint8Array>; required: Set<string> }>> {
  const bytesOf = new Map<string, Uint8Array>()
  const required = new Set<string>()
  for (const path of [...names].sort()) {
    const present = await exists(input.cwd, code.repository, code.referenceCommit, path, input.gh, trees)
    if (!present.ok) return present
    if (!present.value) continue
    const bytes = await readPinned(input.cwd, code.repository, code.referenceCommit, path, input.gh)
    if (!bytes.ok) return bytes
    bytesOf.set(path, bytes.value)
    if (!instructionFile(path)) continue
    const cited = documentedReferences(bytes.value)
    if (!cited.ok) return cited
    for (const item of cited.value) required.add(item)
  }
  return { ok: true, value: { bytesOf, required } }
}

async function collectRequired(
  input: { cwd: string; gh: Gh },
  code: UwActionRequest['code'],
  bytesOf: Map<string, Uint8Array>,
  required: ReadonlySet<string>,
): Promise<Result<true>> {
  for (const path of [...required].sort()) {
    if (bytesOf.has(path)) continue
    const bytes = await readPinned(input.cwd, code.repository, code.referenceCommit, path, input.gh)
    if (!bytes.ok) return bytes
    bytesOf.set(path, bytes.value)
  }
  return { ok: true, value: true }
}

async function collectHeadBlobs(
  input: { cwd: string; gh: Gh },
  code: UwActionRequest['code'],
  changed: readonly string[],
  existing: ReadonlyMap<string, Uint8Array>,
  trees: Map<string, ReadonlySet<string> | null>,
): Promise<Result<Map<string, Uint8Array>>> {
  const extra = new Map<string, Uint8Array>()
  for (const path of [...changed].sort()) {
    const present = await exists(input.cwd, code.repository, code.head, path, input.gh, trees)
    if (!present.ok) return present
    if (!present.value) continue
    const bytes = await readPinned(input.cwd, code.repository, code.head, path, input.gh)
    if (!bytes.ok) return bytes
    const prior = existing.get(path)
    if (code.head === code.referenceCommit && prior !== undefined) {
      if (Buffer.compare(Buffer.from(prior), Buffer.from(bytes.value)) !== 0) {
        return actionFailure('action-input-stale', 'Changed HEAD bytes disagree with the pinned reference: ' + path)
      }
      continue
    }
    extra.set(path, bytes.value)
  }
  return { ok: true, value: extra }
}

export async function discoverRepositoryReferences(input: {
  request: UwActionRequest
  cwd: string
  gh: Gh
}): Promise<Result<PinnedFileRef[]>> {
  const code = input.request.code
  if ((await checkoutRepository(input.cwd)) !== code.repository) {
    return actionFailure(
      'git-objects-missing',
      `Repository references require local Git objects for ${code.repository}`,
    )
  }
  const names = new Set<string>([...ENTRY, ...PROJECT_CONTRACT_FILES])
  const changed = await changedPaths(input.cwd, code.base, code.head)
  if (!changed.ok) return changed
  addTouchedEntries(names, changed.value)
  const trees = new Map<string, ReadonlySet<string> | null>()
  const seeds = await collectSeeds(input, code, names, trees)
  if (!seeds.ok) return seeds
  const stored = await collectRequired(input, code, seeds.value.bytesOf, seeds.value.required)
  if (!stored.ok) return stored
  const head = await collectHeadBlobs(input, code, changed.value, seeds.value.bytesOf, trees)
  if (!head.ok) return head
  const base = pinnedRefs(code.repository, code.referenceCommit, seeds.value.bytesOf)
  if (!base.ok) return base
  const added = pinnedRefs(code.repository, code.head, head.value)
  if (!added.ok) return added
  return { ok: true, value: [...base.value, ...added.value] }
}
