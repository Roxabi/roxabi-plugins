import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import {
  composeChantier,
  failedCheckEvidenceDigest,
  reconstructWorkflow,
  shippedProductVersion,
} from '../dist/contracts.js'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { type AttributedCiCorrectionInput, diagnosticCodes, objectValue } from './fix-mandate-types.ts'
import { defaultGit } from './workflow-checkout.ts'
import { readEffectiveFixConfig } from './workflow-config.ts'
import { SUPPORTED_CONFIG_VERSIONS } from './workflow-graph.ts'
import { readProofConfigPins } from './workflow-pins.ts'

const execFileAsync = promisify(execFile)

export async function githubText(options: GitHubOptions, cwd: string, args: string[]): Promise<string> {
  if (options.gh) return options.gh(cwd, args)
  const out = await execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return String(out.stdout).trim()
}

export type NativeCheckFailure = {
  name: string
  source: string
  observationId: string
  conclusion: string
}

export type LiveCiEvidence = {
  failedChecks: string[]
  evidenceDigest: string
  failures: NativeCheckFailure[]
}

export function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function evidenceDigestOf(
  candidateGitSHA: string,
  scope: Scope,
  failures: readonly NativeCheckFailure[],
): FixActionResult<string> {
  const digest = failedCheckEvidenceDigest({ candidateGitSHA, scope, failures })
  if (digest === null || !/^[0-9a-f]{64}$/.test(digest)) return failure('ci-native-identity-unknown')
  return { ok: true, value: digest }
}

export function receiptFailures(value: unknown): NativeCheckFailure[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const failures: NativeCheckFailure[] = []
  for (const item of value) {
    const record = objectValue(item)
    const name = nonempty(record?.name)
    const source = nonempty(record?.source)
    const observationId = nonempty(record?.observationId)
    const conclusion = nonempty(record?.conclusion)
    if (record === null || name === null || source === null || observationId === null || conclusion === null)
      return null
    failures.push({ name, source, observationId, conclusion })
  }
  return failures
}

/** Current head, pull-request scope, and native CheckRun identity. The receipt is not an input. */
export async function readLiveCiEvidence(
  input: Pick<AttributedCiCorrectionInput, 'cwd' | 'target' | 'options'>,
  head: string,
): Promise<FixActionResult<LiveCiEvidence>> {
  const scope = { repository: input.target.repository, target: input.target.target }
  let headRaw: string
  try {
    headRaw = await githubText(input.options, input.cwd, [
      'pr',
      'view',
      String(input.target.number),
      '--repo',
      input.target.repository,
      '--json',
      'headRefOid',
    ])
  } catch (error) {
    return failure(`ci-checks-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  let headParsed: unknown
  try {
    headParsed = JSON.parse(headRaw)
  } catch {
    return failure('ci-checks-unreadable')
  }
  const headBody = objectValue(headParsed)
  if (headBody === null || typeof headBody.headRefOid !== 'string') return failure('ci-checks-unreadable')
  if (headBody.headRefOid !== head) return failure('ci-correction-head-moved')
  const read = await readNativeCiFailureEvidence(input.cwd, input.target.repository, head, scope, {
    gh: (cwd, args) => githubText(input.options, cwd, args),
    failedCheckEvidenceDigest,
  })
  if (!read.ok) return failure(read.reason)
  return {
    ok: true,
    value: {
      failedChecks: read.failedChecks,
      evidenceDigest: read.evidenceDigest,
      failures: read.failures,
    },
  }
}

export async function authorizeFixAction(
  input: Pick<AttributedCiCorrectionInput, 'cwd' | 'target' | 'branch' | 'base' | 'options'>,
  history: DecodedHistory,
  linked: DecodedHistory | null,
  parents: readonly DecodedHistory[],
  reviewStep: 'fix' | 'review' | 'land' | 'stop',
  liveEvidence: LiveCiEvidence,
  acceptedSpec: { body: string; digest: string },
): Promise<FixActionResult<readonly string[]>> {
  if (input.target.state !== 'open') return failure('fix-target-closed')
  if (input.target.kind === 'pull-request' && (input.base === null || input.target.candidateGitSHA === null)) {
    return failure('fix-workflow-refused:unknown-binding')
  }
  const commit = input.target.candidateGitSHA
  if (commit === null || !/^[0-9a-f]{40}$/.test(commit)) return failure('fix-config-unreadable')
  return reconstructAuthorizedFix(input, history, linked, parents, reviewStep, liveEvidence, acceptedSpec, commit)
}

type ReconstructedWorkflowDecision = {
  status: string
  action?: string
  reason?: string
  evidence: unknown
}

function reconstructedFixOutcome(
  decision: ReconstructedWorkflowDecision,
  failedChecks: readonly string[],
): FixActionResult<readonly string[]> {
  if (decision.status === 'action' && decision.action === 'fix') return { ok: true, value: failedChecks }
  const reason =
    decision.status === 'blocked' || decision.status === 'terminal'
      ? decision.reason
      : decision.status === 'action'
        ? decision.action
        : decision.status
  return failure(`fix-workflow-refused:${reason}`, ...diagnosticCodes(decision.evidence))
}

async function reconstructAuthorizedFix(
  input: Pick<AttributedCiCorrectionInput, 'cwd' | 'target' | 'branch' | 'base' | 'options'>,
  history: DecodedHistory,
  linked: DecodedHistory | null,
  parents: readonly DecodedHistory[],
  reviewStep: 'fix' | 'review' | 'land' | 'stop',
  liveEvidence: LiveCiEvidence,
  acceptedSpec: { body: string; digest: string },
  commit: string,
): Promise<FixActionResult<readonly string[]>> {
  const failedChecks = liveEvidence.failedChecks
  const git = defaultGit()
  const config = await readEffectiveFixConfig({ cwd: input.cwd, commit, git })
  if (!config.ok) return failure(`fix-config-${config.reason}`, ...config.diagnostics.map((item) => item.code))
  let proofPins: { sourceCommit: string; path: string; blob: string | null }[]
  try {
    proofPins = await readProofConfigPins(git, input.cwd, commit)
  } catch (error) {
    return failure(`fix-proof-pins-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  let productVersion: string
  try {
    productVersion = shippedProductVersion()
  } catch {
    return failure('fix-product-version-unreadable')
  }
  const issue = linked ?? history
  const pullRequest = linked !== null && input.target.kind === 'pull-request' ? history : null
  const composed = composeChantier({ issue, pullRequest, parents })
  if (!composed.ok) return failure('fix-history-incomplete', ...diagnosticCodes(composed.diagnostics))
  const pullRequestFacts =
    input.target.kind === 'pull-request' && input.base !== null
      ? {
          scope: { repository: input.target.repository, target: input.target.target },
          head: commit,
          base: input.base,
          associatedIssue: linked?.source.scope ?? null,
        }
      : null
  const decision = reconstructWorkflow({
    evidence: composed.value,
    facts: {
      specDigest: acceptedSpec.digest,
      specBody: acceptedSpec.body,
      branch: input.branch,
      base: input.base,
      candidateGitSHA: commit,
      pullRequest: pullRequestFacts,
      failedChecks,
      evidenceDigest: liveEvidence.evidenceDigest,
      merged: false,
      sessionCwd: input.cwd,
      preparedWorktree: input.cwd,
      productVersion,
      configVersion: config.version,
      configDigest: config.digest,
      supportedConfigVersions: [...SUPPORTED_CONFIG_VERSIONS],
      proofPins,
      explicitSelection: true,
      explicitResume: false,
      successorAntecedent: null,
      endObligationsMet: false,
      localInhibit: null,
    },
    decisions: {
      reviewStep,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: 'red',
      publish: { status: 'not-applicable', evidence: [] },
      landing: { status: 'not-applicable', evidence: [] },
      watch: { status: 'not-applicable', evidence: [] },
      proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'not-applicable', evidence: [] },
    },
  })
  return reconstructedFixOutcome(decision, failedChecks)
}
