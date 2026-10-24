import {
  type AcceptedSpecRef,
  type ExternalRecordRef,
  type Result,
  readWorkflowBinding,
  resolveBoundWork,
  type Scope,
  specDigest,
} from '../dist/contracts.js'
import { withRoxabiGitHubPolicy } from './github-policy'

export type Gh = (cwd: string, args: string[]) => Promise<string>

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
        chain: readonly AcceptedSpecRef[]
        sourceRefs: readonly ExternalRecordRef[]
      }
      currentSpec: ReviewIssueSpec
      effectiveConfig: { productVersion: string; version: string; digest: string; serialized: string }
      additionalRequirements: readonly string[]
    }

export type ResolveReviewSemanticContextInput = {
  cwd: string
  repository: string
  pr: number
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
  return match !== null && scope.target === `${scope.repository}#${match[1]}` ? Number(match[1]) : null
}
async function readIssue(cwd: string, repository: string, number: number, gh: Gh): Promise<Result<ReviewIssueSpec>> {
  try {
    const raw: unknown = JSON.parse(
      await gh(cwd, ['issue', 'view', String(number), '--repo', repository, '--json', 'body,updatedAt,state,labels']),
    )
    if (
      !isObject(raw) ||
      (raw.state !== 'OPEN' && raw.state !== 'CLOSED') ||
      typeof raw.body !== 'string' ||
      (raw.updatedAt !== null && typeof raw.updatedAt !== 'string') ||
      !Array.isArray(raw.labels)
    )
      return failed('tracker-issue-unreadable', `tracker issue #${number} is unreadable`)
    return {
      ok: true,
      value: {
        reference: `#${number}`,
        number,
        body: raw.body,
        digest: specDigest(raw.body),
        lastEditedAt: raw.updatedAt as string | null,
        labels: raw.labels.flatMap((label) => (isObject(label) && typeof label.name === 'string' ? [label.name] : [])),
      },
    }
  } catch (error) {
    return failed('tracker-issue-unreadable', error instanceof Error ? error.message : String(error))
  }
}

function standaloneContext(currentSpec: ReviewIssueSpec | null): Result<ReviewSemanticContext> {
  return {
    ok: true,
    value: {
      mode: 'standalone',
      binding: null,
      acceptedSpec: null,
      currentSpec,
      effectiveConfig: null,
      additionalRequirements: [],
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

async function readPullRequestBody(input: ResolveReviewSemanticContextInput): Promise<Result<string>> {
  if (input.body !== undefined) return { ok: true, value: input.body }
  try {
    const raw: unknown = JSON.parse(await input.gh(input.cwd, ['pr', 'view', String(input.pr), '--json', 'body']))
    if (!isObject(raw) || typeof raw.body !== 'string') {
      return failed('review-target-unreadable', 'PR body is unreadable')
    }
    return { ok: true, value: raw.body }
  } catch (error) {
    return failed('review-target-unreadable', error instanceof Error ? error.message : String(error))
  }
}

async function resolveStandaloneContext(
  input: ResolveReviewSemanticContextInput,
): Promise<Result<ReviewSemanticContext>> {
  const body = await readPullRequestBody(input)
  if (!body.ok) return body
  let number: number | null
  try {
    number = trackerReference(body.value, input.branch)
  } catch (error) {
    return failed('tracker-reference-ambiguous', error instanceof Error ? error.message : String(error))
  }
  if (number === null) return standaloneContext(null)
  const current = await readIssue(input.cwd, input.repository, number, input.gh)
  return current.ok ? standaloneContext(current.value) : current
}

/** PR body/branch discovery is only available when confirmed workflow binding is absent. */
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
    return binding.status === 'absent'
      ? resolveStandaloneContext(input)
      : { ok: false, diagnostics: binding.diagnostics }
  }
  const linkedScopes = binding.value.linkedIssueBodies.map(({ scope }) => scope)
  if (linkedScopes.length !== 1) {
    return failed('workflow-binding-incomplete', 'bound review requires exactly one linked tracker issue')
  }
  const scope = linkedScopes[0]
  const number = issueNumber(scope)
  if (number === null) return failed('workflow-binding-incomplete', 'bound tracker issue has an invalid scope')
  const current = await readIssue(input.cwd, scope.repository, number, input.gh)
  if (!current.ok) return current
  const resolved = resolveBoundWork({
    use: 'review',
    explicitSelection: true,
    pullRequest,
    histories: binding.value.histories,
    native: { branch: input.branch, base: input.base },
    currentSpec: { body: current.value.body, digest: current.value.digest },
  })
  if (resolved.status === 'standalone') {
    return failed('workflow-binding-incomplete', 'confirmed workflow binding became absent during semantic preparation')
  }
  if (resolved.status === 'refused') return { ok: false, diagnostics: resolved.evidence }
  if (resolved.drift !== 'settled') {
    return failed('workflow-spec-drift', 'current tracker Spec differs from the accepted mandate Spec')
  }
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
