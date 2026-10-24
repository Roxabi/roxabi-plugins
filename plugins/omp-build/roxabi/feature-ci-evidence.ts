import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Gh } from '../adapters/github/types.ts'
import type { FailedCheckFailure } from '../engine/record-digests.ts'
import type { Scope } from '../engine/record-values.ts'

export type NativeCiEvidence =
  | {
      ok: true
      failedChecks: string[]
      failures: FailedCheckFailure[]
      evidenceDigest: string
      /** Full supplied rollup nodes retained for the model; not hashed as wall-clock. */
      supplied: unknown
    }
  | { ok: false; reason: string }

type FailedCheckEvidenceDigest = (input: {
  candidateGitSHA: string
  scope: Scope
  failures: readonly FailedCheckFailure[]
}) => string | null

type Contracts = { failedCheckEvidenceDigest: FailedCheckEvidenceDigest }

const execFileAsync = promisify(execFile)
const CHECK_RUN_SOURCE = 'github-check-run'
const STATUS_CONTEXT_SOURCE = 'github-status-context'
const CHECK_STATUS = new Set(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'])
const CHECK_CONCLUSION = new Set([
  'action_required',
  'timed_out',
  'cancelled',
  'failure',
  'success',
  'neutral',
  'skipped',
  'startup_failure',
  'stale',
])
const RED_CI = new Set(['failure', 'timed_out', 'startup_failure'])
const STATUS_STATE = new Set(['expected', 'error', 'failure', 'pending', 'success'])
const RED_STATUS = new Set(['error', 'failure'])
const CI_PAGE = 100
const CI_PAGE_BOUND = 50
const ROLLUP_QUERY = `query($owner: String!, $name: String!, $sha: GitObjectID!, $after: String = null) {
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: ${CI_PAGE}, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun { id name status conclusion }
              ... on StatusContext { id context state }
            }
          }
        }
      }
    }
  }
}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasFailedCheckEvidenceDigest(value: unknown): value is Contracts {
  return isRecord(value) && typeof value.failedCheckEvidenceDigest === 'function'
}

async function loadContracts(): Promise<Contracts | { missing: string }> {
  // Only the installed package's generated contracts are available at this runtime boundary.
  const imported: unknown = await import('../dist/contracts.js')
  return hasFailedCheckEvidenceDigest(imported) ? imported : { missing: 'failedCheckEvidenceDigest' }
}

function defaultGh(): Gh {
  return async (cwd, args) => {
    const out = await execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return out.stdout
  }
}

type EvidenceRead<T> = { ok: true; value: T } | { ok: false; reason: string }
type CiPage = { nodes: unknown[]; hasNextPage: boolean; cursor: string | null }

async function resolveEvidenceDigest(
  provided: Contracts['failedCheckEvidenceDigest'] | undefined,
): Promise<EvidenceRead<Contracts['failedCheckEvidenceDigest']>> {
  if (provided !== undefined) return { ok: true, value: provided }
  const loaded = await loadContracts()
  return 'missing' in loaded
    ? { ok: false, reason: `engine-unavailable:${loaded.missing}` }
    : { ok: true, value: loaded.failedCheckEvidenceDigest }
}

function ciPage(value: unknown): EvidenceRead<CiPage> {
  if (!isRecord(value) || !isRecord(value.data) || (Array.isArray(value.errors) && value.errors.length > 0)) {
    return { ok: false, reason: 'ci-evidence-unreadable' }
  }
  const repository = value.data.repository
  const object = isRecord(repository) ? repository.object : null
  const rollup = isRecord(object) ? object.statusCheckRollup : null
  const contexts = isRecord(rollup) ? rollup.contexts : null
  const nodes = isRecord(contexts) && Array.isArray(contexts.nodes) ? contexts.nodes : null
  if (nodes === null) return { ok: false, reason: 'ci-evidence-unreadable' }
  const pageInfo = isRecord(contexts) && isRecord(contexts.pageInfo) ? contexts.pageInfo : null
  if (pageInfo === null || typeof pageInfo.hasNextPage !== 'boolean') {
    return { ok: false, reason: 'ci-evidence-incomplete' }
  }
  const cursor = typeof pageInfo.endCursor === 'string' && pageInfo.endCursor.length > 0 ? pageInfo.endCursor : null
  return { ok: true, value: { nodes, hasNextPage: pageInfo.hasNextPage, cursor } }
}

async function readRollupNodes(
  gh: Gh,
  cwd: string,
  owner: string,
  name: string,
  candidateGitSHA: string,
): Promise<EvidenceRead<unknown[]>> {
  const nodes: unknown[] = []
  let after: string | null = null
  for (let page = 0; page < CI_PAGE_BOUND; page += 1) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${ROLLUP_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-f',
      `sha=${candidateGitSHA}`,
    ]
    if (after !== null) args.push('-f', `after=${after}`)
    let parsed: unknown
    try {
      parsed = JSON.parse(await gh(cwd, args))
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'ci-evidence-unreadable' }
    }
    const current = ciPage(parsed)
    if (!current.ok) return current
    nodes.push(...current.value.nodes)
    if (!current.value.hasNextPage) break
    if (current.value.cursor === null || current.value.cursor === after || page === CI_PAGE_BOUND - 1) {
      return { ok: false, reason: 'ci-evidence-incomplete' }
    }
    after = current.value.cursor
  }
  return { ok: true, value: nodes }
}

function statusFailure(node: Record<string, unknown>): EvidenceRead<FailedCheckFailure | null> {
  const state = typeof node.state === 'string' ? node.state.toLowerCase() : ''
  if (!STATUS_STATE.has(state)) return { ok: false, reason: 'ci-native-state-unknown' }
  if (!RED_STATUS.has(state)) return { ok: true, value: null }
  const name = typeof node.context === 'string' && node.context.length > 0 ? node.context : null
  const observationId = typeof node.id === 'string' && node.id.length > 0 ? node.id : null
  return name === null || observationId === null
    ? { ok: false, reason: 'ci-native-identity-unknown' }
    : { ok: true, value: { name, source: STATUS_CONTEXT_SOURCE, observationId, conclusion: state } }
}

function checkRunFailure(node: Record<string, unknown>): EvidenceRead<FailedCheckFailure | null> {
  const status = typeof node.status === 'string' ? node.status.toLowerCase() : ''
  if (!CHECK_STATUS.has(status)) return { ok: false, reason: 'ci-native-state-unknown' }
  const conclusion = typeof node.conclusion === 'string' ? node.conclusion.toLowerCase() : ''
  if ((conclusion.length > 0 || status === 'completed') && !CHECK_CONCLUSION.has(conclusion)) {
    return { ok: false, reason: 'ci-native-state-unknown' }
  }
  if (status !== 'completed' || !RED_CI.has(conclusion)) return { ok: true, value: null }
  const name = typeof node.name === 'string' && node.name.length > 0 ? node.name : null
  const observationId = typeof node.id === 'string' && node.id.length > 0 ? node.id : null
  return name === null || observationId === null
    ? { ok: false, reason: 'ci-native-identity-unknown' }
    : { ok: true, value: { name, source: CHECK_RUN_SOURCE, observationId, conclusion } }
}

function classifyFailure(node: unknown): EvidenceRead<FailedCheckFailure | null> {
  if (!isRecord(node)) return { ok: false, reason: 'ci-native-identity-unknown' }
  if (node.__typename === 'StatusContext') return statusFailure(node)
  return node.__typename === 'CheckRun' ? checkRunFailure(node) : { ok: false, reason: 'ci-native-identity-unknown' }
}

function collectFailures(nodes: unknown[]): EvidenceRead<FailedCheckFailure[]> {
  const failures: FailedCheckFailure[] = []
  for (const node of nodes) {
    const classified = classifyFailure(node)
    if (!classified.ok) return classified
    if (classified.value !== null) failures.push(classified.value)
  }
  return { ok: true, value: failures }
}

function uniqueFailures(failures: FailedCheckFailure[]): boolean {
  const seen = new Set<string>()
  for (const failure of failures) {
    const key = `${failure.source}\0${failure.observationId}`
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/**
 * GraphQL statusCheckRollup → engine FailedCheckFailure identity.
 * source is the frozen constant, never a suite id or context string.
 * CheckRun: source = github-check-run, observationId = CheckRun.id, name = check name.
 * StatusContext: source = github-status-context, observationId = StatusContext.id, name = context.
 * Unknown native state or conclusion refuses. Missing or malformed pageInfo, including a
 * non-boolean hasNextPage, is ci-evidence-incomplete and authorizes nothing.
 */
export async function readNativeCiFailureEvidence(
  cwd: string,
  repository: string,
  candidateGitSHA: string,
  scope: Scope,
  options?: { gh?: Gh; failedCheckEvidenceDigest?: Contracts['failedCheckEvidenceDigest'] },
): Promise<NativeCiEvidence> {
  const digest = await resolveEvidenceDigest(options?.failedCheckEvidenceDigest)
  if (!digest.ok) return digest
  const [owner, name] = repository.split('/')
  if (!owner || !name || !/^[0-9a-f]{40}$/.test(candidateGitSHA)) {
    return { ok: false, reason: 'ci-evidence-target-unreadable' }
  }
  const rollup = await readRollupNodes(options?.gh ?? defaultGh(), cwd, owner, name, candidateGitSHA)
  if (!rollup.ok) return rollup
  const classified = collectFailures(rollup.value)
  if (!classified.ok) return classified
  const failures = classified.value
  if (!uniqueFailures(failures) || failures.length === 0) {
    return {
      ok: false,
      reason: failures.length === 0 ? 'ci-attribution-evidence-missing' : 'ci-native-identity-unknown',
    }
  }
  const evidenceDigest = digest.value({ candidateGitSHA, scope, failures })
  if (evidenceDigest === null) return { ok: false, reason: 'ci-native-identity-unknown' }
  return {
    ok: true,
    failedChecks: [...new Set(failures.map((item) => item.name))],
    failures,
    evidenceDigest,
    supplied: rollup.value,
  }
}
