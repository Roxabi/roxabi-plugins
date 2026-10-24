/**
 * The landing admission's readers (#768) on the records the real producers
 * conserved (`__fixtures__/proof/records.json`, see `capture.ts`) and on an
 * injected Git. Each refusal is paired with the admitted counterpart it varies;
 * `proof.integration.test.ts` drives the same readers through the real `landPr`.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

export { SEMCTX_CONFIG } from './__fixtures__/proof/sandbox-semctx-base'

import type { Git, GitResult } from './proof-base'

export type Capture = { sha: Record<string, string>; records: Record<string, { data?: unknown }> }
export type Producer = 'semctx' | 'assertledger'
export const RECORDS: Record<Producer, Capture> = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '__fixtures__/proof/records.json'), 'utf8'),
)
export const ME = 'operator'
export const REPOSITORY = 'acme/app'
export const CONTRACT = '.semctx/semantic/changes/change.fx.add.sem'
export const GAP = 'proof.fx.add-test'
export const C = '1111111111111111111111111111111111111111'
export const OTHER = '2222222222222222222222222222222222222222'
export const BASE_TIP = '3333333333333333333333333333333333333333'

export function shaOf(producer: Producer, branch: string): string {
  const sha = RECORDS[producer].sha[branch]
  if (!sha) throw new Error(`records.json holds no ${producer} commit for ${branch}`)
  return sha
}

/** A fresh copy of byte-for-byte retained native proof data. */
export function conserved<Shape>(producer: Producer, name: string, _candidate: string): Shape {
  const data = RECORDS[producer].records[name]?.data
  if (data === undefined) throw new Error(`records.json holds no ${producer} ${name} native data`)
  return JSON.parse(JSON.stringify(data))
}

const temps: string[] = []
export const temp = (name = 'proof-') => {
  const dir = mkdtempSync(path.join(tmpdir(), name))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// candidateFacts on an injected Git
// ---------------------------------------------------------------------------

export type Entry = { mode?: string; type?: string; oid?: string; path: string }
export type Repo = {
  toplevel: string
  principal?: string | null
  tip?: { code: number; stdout: string; stderr: string }
  tree?: Entry[]
  /** `origin/main`'s tree; the candidate's when omitted (a PR that changes no declaration). */
  baseTree?: Entry[]
  blobs?: Record<string, string>
}

const gitSuccess = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' })

function staticRepoResponse(repo: Repo, list: string, key: string): GitResult | null {
  if (key === 'rev-parse --show-toplevel') return gitSuccess(`${repo.toplevel}\n`)
  if (key === 'rev-parse --verify HEAD^{commit}') return repo.tip ?? gitSuccess(`${C}\n`)
  return key === 'worktree list --porcelain -z' ? gitSuccess(list) : null
}

function treeResponse(repo: Repo, listing: (entries: Entry[]) => string, args: string[]): GitResult | null {
  if (args[0] !== 'ls-tree') return null
  if (args[4] === `${BASE_TIP}^{commit}`) return gitSuccess(listing(repo.baseTree ?? repo.tree ?? []))
  return args[4] === `${C}^{commit}` ? gitSuccess(listing(repo.tree ?? [])) : null
}

function blobResponse(repo: Repo, args: string[]): GitResult | null {
  if (args[0] !== 'cat-file' || args[2] === undefined) return null
  const blob = repo.blobs?.[args[2]]
  return blob === undefined ? null : gitSuccess(blob)
}

export function repoGit(repo: Repo): Git {
  const list =
    repo.principal === null
      ? `worktree /srv/app.git\0bare\0\0worktree ${repo.toplevel}\0HEAD ${C}\0detached\0\0`
      : `worktree ${repo.principal ?? repo.toplevel}\0HEAD ${C}\0branch refs/heads/main\0\0`
  const listing = (entries: Entry[]) =>
    entries
      .map(
        (entry) => `${entry.mode ?? '100644'} ${entry.type ?? 'blob'} ${entry.oid ?? 'e'.repeat(40)}\t${entry.path}\0`,
      )
      .join('')
  return async (_cwd, args) => {
    const key = args.join(' ')
    return (
      staticRepoResponse(repo, list, key) ??
      treeResponse(repo, listing, args) ??
      blobResponse(repo, args) ?? { code: 128, stdout: '', stderr: `fatal: no answer for ${key}` }
    )
  }
}

export const CONFIG_OID = 'c'.repeat(40)
export const configured = (text = '{"include":["src/**/*.ts"]}', mode = '100644'): Pick<Repo, 'tree' | 'blobs'> => ({
  tree: [{ path: '.semctx/config.json', oid: CONFIG_OID, mode }],
  blobs: { [CONFIG_OID]: text },
})

export const ASSERTLEDGER_CONFIG = '{"adapter":{}}'
export const assertledgerConfig = (oid = 'a'.repeat(40)): Pick<Repo, 'tree' | 'blobs'> => ({
  tree: [{ path: 'assertledger.config.json', oid }],
  blobs: { [oid]: ASSERTLEDGER_CONFIG },
})

export type Native = { argv: string[]; exit: number; stdout: string }
export type LedgerShape = { invocation: Record<string, unknown>; native: { manifest: string; replay: Native } }
export type Manifest = {
  decision: { status: string; selectedCandidateIds: string[] }
  candidates: { id: string; status: string }[]
  evidenceContext: { worlds: { id: string; provenance: string }[] }
}

export const DETECTED = shaOf('assertledger', 'fix/2-detection')

export function detection(edit: (record: LedgerShape, manifest: Manifest) => void = () => {}): LedgerShape {
  const record = conserved<LedgerShape>('assertledger', 'detection', DETECTED)
  const manifest: Manifest = JSON.parse(record.native.manifest)
  edit(record, manifest)
  record.native.manifest = JSON.stringify(manifest)
  return record
}

/** The reference world assertledger derived from Git for the capture. */
export function reference(manifest: Manifest): { provenance: string } {
  const world = manifest.evidenceContext.worlds.find((candidate) => candidate.id === 'fixed')
  if (!world) throw new Error('the conserved manifest has no reference world')
  return world
}

export function treeOf(record: LedgerShape): string {
  const provenance: { tree: string } = JSON.parse(reference(JSON.parse(record.native.manifest)).provenance)
  return provenance.tree
}

export const ledgerExpected = { repository: REPOSITORY, pr: 20, candidate: DETECTED, tree: treeOf(detection()) }
