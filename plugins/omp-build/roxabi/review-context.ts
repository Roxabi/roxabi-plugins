import {
  type AcceptedSpecRef,
  type ExternalRecordRef,
  type Gh,
  type Result,
  readWorkflowBinding,
  resolveBoundWork,
  type Scope,
  specDigest,
} from '../dist/contracts.js'
import type { NativeTask } from '../omp/review-runtime'
import { type AllocateReviewInput, type AllocateReviewResult, allocateReview } from '../skills/dev-review/roster'
import { withRoxabiGitHubPolicy } from './github-policy'
import { nativePanelProfileByRole } from './native-review-profiles'
import type { ReviewConfig } from './review-config'

export type ReviewIssueSpec = {
  reference: string
  number: number
  body: string
  digest: string
  lastEditedAt: string | null
  labels: readonly string[]
}

export type ReviewSemanticContext =
  | {
      mode: 'standalone'
      binding: null
      acceptedSpec: null
      currentSpec: ReviewIssueSpec | null
      effectiveConfig: null
      additionalRequirements: readonly string[]
    }
  | {
      mode: 'bound'
      binding: { recordId: string; scope: Scope }
      acceptedSpec: {
        reference: string
        body: string
        digest: string
        lastEditedAt: string | null
        /** Ordered mandate/editorial/material acceptance provenance; excludes pauses and resumes. */
        chain: readonly AcceptedSpecRef[]
        sourceRefs: readonly ExternalRecordRef[]
      }
      currentSpec: ReviewIssueSpec
      effectiveConfig: {
        productVersion: string
        version: string
        digest: string
        serialized: string
      }
      additionalRequirements: readonly string[]
    }

export type ResolveReviewSemanticContextInput = {
  cwd: string
  repository: string
  pr: number
  /** Passed by preparation to avoid a second PR read; the hash entry may omit it. */
  body?: string
  branch: string
  base: string
  automationLogin?: string
  gh: Gh
}

function failed<T>(code: string, message: string): Result<T> {
  return { ok: false, diagnostics: [{ code, message }] }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issueNumber(scope: Scope): number | null {
  const match = scope.target.match(/#([1-9]\d*)$/)
  if (match === null || scope.target !== `${scope.repository}#${match[1]}`) return null
  return Number(match[1])
}

async function readIssue(cwd: string, repository: string, number: number, gh: Gh): Promise<Result<ReviewIssueSpec>> {
  let raw: unknown
  try {
    raw = JSON.parse(
      await gh(cwd, ['issue', 'view', String(number), '--repo', repository, '--json', 'body,updatedAt,state,labels']),
    )
  } catch (error) {
    return failed('tracker-issue-unreadable', error instanceof Error ? error.message : String(error))
  }
  if (
    !isObject(raw) ||
    (raw.state !== 'OPEN' && raw.state !== 'CLOSED') ||
    typeof raw.body !== 'string' ||
    (raw.updatedAt !== null && typeof raw.updatedAt !== 'string') ||
    !Array.isArray(raw.labels)
  )
    return failed('tracker-issue-unreadable', `tracker issue #${number} is unreadable`)
  const labels = raw.labels.flatMap((label) => (isObject(label) && typeof label.name === 'string' ? [label.name] : []))
  return {
    ok: true,
    value: {
      reference: `#${number}`,
      number,
      body: raw.body,
      digest: specDigest(raw.body),
      lastEditedAt: raw.updatedAt as string | null,
      labels,
    },
  }
}

/** PR body and branch conventions locate standalone tracker context only; they never establish authority. */
export function trackerReference(body: string, branch: string): number | null {
  const refs = [...body.matchAll(/\b(?:fixes|closes|resolves)\s+#(\d+)\b/gi)].map((match) => Number(match[1]))
  const unique = refs.filter((value, index) => refs.indexOf(value) === index)
  if (unique.length > 1) throw new Error('PR body contains multiple linked tracker issues')
  if (unique.length === 1) return unique[0]
  const match = branch.match(/^[^/]+\/(\d+)-/)
  return match?.[1] === undefined ? null : Number(match[1])
}
async function readPullRequestBody(cwd: string, pr: number, gh: Gh): Promise<Result<string>> {
  try {
    const raw: unknown = JSON.parse(await gh(cwd, ['pr', 'view', String(pr), '--json', 'body']))
    if (!isObject(raw) || typeof raw.body !== 'string')
      return failed('review-target-unreadable', 'PR body is unreadable')
    return { ok: true, value: raw.body }
  } catch (error) {
    return failed('review-target-unreadable', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Reads the confirmed binding before choosing any semantic source. Present but
 * invalid bindings are refusals; only an absent binding may use explicit
 * standalone tracker discovery.
 */
export async function resolveReviewSemanticContext(
  input: ResolveReviewSemanticContextInput,
): Promise<Result<ReviewSemanticContext>> {
  const pullRequest: Scope = { repository: input.repository, target: `${input.repository}#${input.pr}` }
  const github = withRoxabiGitHubPolicy(
    input.automationLogin === undefined
      ? { cwd: input.cwd, gh: input.gh }
      : { cwd: input.cwd, automationLogin: input.automationLogin, gh: input.gh },
  )
  const binding = await readWorkflowBinding(pullRequest, github)
  if (!binding.ok) {
    if (binding.status !== 'absent') return { ok: false, diagnostics: binding.diagnostics }
    const body: Result<string> =
      input.body === undefined
        ? await readPullRequestBody(input.cwd, input.pr, input.gh)
        : { ok: true, value: input.body }
    if (!body.ok) return body
    let number: number | null
    try {
      number = trackerReference(body.value, input.branch)
    } catch (error) {
      return failed('tracker-reference-ambiguous', error instanceof Error ? error.message : String(error))
    }
    if (number === null)
      return {
        ok: true,
        value: {
          mode: 'standalone',
          binding: null,
          acceptedSpec: null,
          currentSpec: null,
          effectiveConfig: null,
          additionalRequirements: [],
        },
      }
    const current = await readIssue(input.cwd, input.repository, number, input.gh)
    if (!current.ok) return current
    return {
      ok: true,
      value: {
        mode: 'standalone',
        binding: null,
        acceptedSpec: null,
        currentSpec: current.value,
        effectiveConfig: null,
        additionalRequirements: [],
      },
    }
  }
  const linkedScopes = binding.value.linkedIssueBodies.map(({ scope }) => scope)
  if (linkedScopes.length !== 1)
    return failed('workflow-binding-incomplete', 'bound review requires exactly one linked tracker issue')
  const number = issueNumber(linkedScopes[0])
  if (number === null) return failed('workflow-binding-incomplete', 'bound tracker issue has an invalid scope')
  const current = await readIssue(input.cwd, linkedScopes[0].repository, number, input.gh)
  if (!current.ok) return current
  const resolved = resolveBoundWork({
    use: 'review',
    explicitSelection: true,
    pullRequest,
    histories: binding.value.histories,
    native: { branch: input.branch, base: input.base },
    currentSpec: { body: current.value.body, digest: current.value.digest },
  })
  if (resolved.status === 'standalone')
    return failed('workflow-binding-incomplete', 'confirmed workflow binding became absent during semantic preparation')
  if (resolved.status === 'refused') return { ok: false, diagnostics: resolved.evidence }
  if (resolved.drift !== 'settled')
    return failed('workflow-spec-drift', 'current tracker Spec differs from the accepted mandate Spec')
  return {
    ok: true,
    value: {
      mode: 'bound',
      binding: { recordId: binding.value.binding.recordId, scope: resolved.scope },
      acceptedSpec: { ...resolved.acceptedSpec, sourceRefs: resolved.acceptedSpec.sourceRefs },
      currentSpec: current.value,
      effectiveConfig: {
        productVersion: resolved.configIdentity.productVersion,
        version: resolved.configIdentity.version,
        digest: resolved.configIdentity.digest,
        serialized: resolved.configIdentity.serialized,
      },
      additionalRequirements: resolved.configIdentity.additionalRequirements,
    },
  }
}

export type ReviewChunk = {
  index: number
  delta: string[]
  /** Complete chunk hunk text from chunker.py, never recreated from delta labels. */
  diff: string
  files: readonly { path: string; text: string | null; deleted: boolean; binary?: boolean }[]
  /** Produced by skills/dev-review/digest.py; never reconstructed from prose. */
  digest: string
}

export type ReviewPanelInput = {
  chunks: readonly ReviewChunk[]
  roster: AllocateReviewInput['shared']
  config: ReviewConfig
  commonContext: string
}

export type RecallTaskInput = {
  classId: string
  chunks: readonly number[]
  callsites: readonly { file: string; line: number }[]
  sourceFindingIds: readonly string[]
  canonicalClasses: readonly string[]
  /** Stage instructions supplied by the host; immutable evidence arrives in batch context. */
  context: string
  sourceEvidence: string
}

/** A dedicated blocking read-only profile makes native task results complete under async mode. */
export function createRecallTask(input: RecallTaskInput): NativeTask {
  if (input.chunks.length < 2 || input.callsites.length < 3) throw new Error('recall threshold was not met')
  if (!input.canonicalClasses.includes(input.classId)) throw new Error('recall class is not canonical')
  return {
    name: `recall-${input.classId}`,
    agent: 'R-review-recall',
    solutionSpace: 'verify one canonical cross-chunk review class from retained reports and callsites',
    task: [
      input.context,
      `Canonical class: ${input.classId}`,
      `Chunks: ${input.chunks.join(', ')}`,
      `Callsites: ${input.callsites.map((site) => `${site.file}:${site.line}`).join(', ')}`,
      `Source findings: ${input.sourceFindingIds.join(', ')}`,
      `Confirmed source evidence:\n${input.sourceEvidence}`,
    ].join('\n\n'),
  }
}

export type ReviewPanel = {
  allocation: AllocateReviewResult
  tasks: NativeTask[]
}

/**
 * Builds the panel from chunker.py/digest.py outputs and the canonical roster
 * oracle. It does not collapse chunks or select/drop roles itself.
 */
export function allocateReviewPanel(input: ReviewPanelInput): ReviewPanel {
  if (input.chunks.length === 0) throw new Error('review requires chunker output')
  if (input.chunks.some((chunk, index) => chunk.index !== index || chunk.digest.length === 0)) {
    throw new Error('review chunks require ordered chunker/digest outputs')
  }
  const allocation = allocateReview({
    chunkDeltas: input.chunks.map((chunk) => [...chunk.delta]),
    shared: { ...input.roster, chunks: input.chunks.length },
  })
  if (allocation.global.review_halt) throw new Error('roster halted review dispatch')
  const tasks = input.chunks.flatMap((chunk) =>
    allocation.chunk_agents[chunk.index].map((role) => {
      const agent = nativePanelProfileByRole[role]
      if (!agent) throw new Error(`roster selected unsupported native role ${role}`)
      return {
        name: `panel-${chunk.index}-${role}`,
        agent,
        solutionSpace: 'review this assigned chunk and report only structured findings',
        task: [
          input.commonContext,
          `Logical roster role: ${role}`,
          `Assigned chunk ${chunk.index} full diff from chunker.py:\n${chunk.diff}`,
          `Candidate file snapshots:\n${chunk.files.map((file) => `${file.deleted ? 'deleted' : file.binary ? 'binary' : 'present'} ${file.path}\n${file.text ?? ''}`).join('\n\n')}`,
          `All ordered boundary digests from digest.py:\n${input.chunks.map((other) => `Chunk ${other.index}:\n${other.digest}`).join('\n\n')}`,
          `Canonical classes: ${input.config.canonicalClasses.join(', ')}`,
        ].join('\n\n'),
      }
    }),
  )
  return { allocation, tasks }
}
