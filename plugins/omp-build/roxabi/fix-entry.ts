import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import {
  type CanonicalRecord,
  type DecodedHistory,
  decodeHistory,
  type GitHubOptions,
  githubScope,
  type Json,
  readGitHubHistory,
  validateReviewDecisionBindings,
} from '../dist/contracts.js'
import { validateReviewInput } from '../skills/feature/workflow.js'
import {
  buildConfirmedFixOnlyMandate,
  confirmFixContinuation,
  confirmPublishedMandate,
  type DefaultFixRequest,
  decideFixAuthority,
  type FixActionResult,
  type FixIdentity,
  type FixMandateView,
  type FixRecord,
  type FixTarget,
  type FixWorkflowRuntime,
  loadFixOnlyDraft,
  type NativePort,
  type PreparedFix,
  type PublishBinding,
  prepareReviewBoundFix,
  type RecordPublisher,
  type ReviewAuthority,
  runAdmittedCiCorrection,
  runDefaultFixWorkflow,
  runReviewBoundFixWorkflow,
  type TargetResolver,
} from './fix'
import type { DebtEvidence, FixPolicy } from './fix-domain'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher'

const execFileAsync = promisify(execFile)
type Gh = (cwd: string, args: string[]) => Promise<string>

export type DefaultFixEntry = {
  cwd: string
  args?: string
  reference?: string
  scope?: string
  rawOperatorRequest?: Json
  reviewId?: string
  contextWindow?: number
  debtEvidence?: DebtEvidence
  native: NativePort
  workflow: ReviewAuthority
  github?: GitHubOptions
  gh?: Gh
}

export type FixStart =
  | { status: 'accepted'; runId: string; operationId: string }
  | { status: 'terminal'; result: FixActionResult<FixRecord> }

export type FixTerminal =
  | { status: 'complete'; recordId: string; kind: 'fix-result' }
  | { status: 'stopped'; diagnostics: string[] }

export type FixRun = {
  runId: string
  operationId: string
  started: Promise<FixStart>
  completion: Promise<FixActionResult<FixRecord>>
  terminal: Promise<FixTerminal>
  stop(reason: string): Promise<void>
}

function fail<T>(...diagnostics: string[]): FixActionResult<T> {
  return { ok: false, diagnostics }
}

function createIdentity(runId = `fix-${randomUUID()}`, operationId = `fix-operation-${randomUUID()}`): FixIdentity {
  let sequence = 0
  return {
    runId,
    operationId,
    nextRecordId(kind) {
      sequence += 1
      return `${runId}-${kind}-${sequence}`
    },
  }
}

function defaultGh(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) =>
    String(stdout).trim(),
  )
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function sha(value: string): string | null {
  const candidate = value.trim()
  return /^[0-9a-f]{40}$/.test(candidate) ? candidate : null
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return String(stdout).trim()
}

async function gitResult(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const out = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { code: 0, stdout: String(out.stdout), stderr: String(out.stderr) }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
    }
  }
}

async function targetEditedAt(cwd: string, gh: Gh, target: FixTarget): Promise<string | null> {
  const command = target.kind === 'pull-request' ? 'pr' : 'issue'
  try {
    const item = object(JSON.parse(await gh(cwd, [command, 'view', String(target.number), '--json', 'updatedAt'])))
    return item !== null && typeof item.updatedAt === 'string' && item.updatedAt.length > 0 ? item.updatedAt : null
  } catch {
    return null
  }
}

async function resolvePublishBinding(
  cwd: string,
  gh: Gh,
  repository: string,
  target: FixTarget,
): Promise<FixActionResult<PublishBinding>> {
  try {
    const repo = object(
      JSON.parse(await gh(cwd, ['repo', 'view', repository, '--json', 'nameWithOwner,defaultBranchRef'])),
    )
    const defaultBranch = object(repo?.defaultBranchRef)
    const defaultBranchName = defaultBranch?.name
    if (
      repo === null ||
      repo.nameWithOwner !== repository ||
      typeof defaultBranchName !== 'string' ||
      defaultBranchName.length === 0
    ) {
      return fail('fix-publish-default-branch-unreadable')
    }
    let localRef: string
    try {
      localRef = await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])
    } catch {
      return fail('fix-publish-branch-detached')
    }
    if (!localRef.startsWith('refs/heads/') || localRef === 'refs/heads/') return fail('fix-publish-branch-detached')
    const localBranch = localRef.slice('refs/heads/'.length)
    const localHead = sha(await git(cwd, ['rev-parse', '--verify', 'HEAD']))
    if (localHead === null || localHead !== target.candidateGitSHA) return fail('fix-publish-local-head-mismatch')
    const pushUrl = await git(cwd, ['remote', 'get-url', '--push', 'origin'])
    const remote = object(
      JSON.parse(await gh(cwd, ['repo', 'view', pushUrl, '--json', 'nameWithOwner,defaultBranchRef'])),
    )
    const remoteRepository = remote?.nameWithOwner
    const remoteDefault = object(remote?.defaultBranchRef)?.name
    if (typeof remoteRepository !== 'string' || typeof remoteDefault !== 'string' || remoteDefault.length === 0) {
      return fail('fix-publish-remote-repository-mismatch')
    }
    let destinationRef = localRef
    let expectedRemoteRepository = repository
    let prFacts: Json = null
    if (target.kind === 'pull-request') {
      const pr = object(
        JSON.parse(
          await gh(cwd, [
            'pr',
            'view',
            String(target.number),
            '--json',
            'state,headRefOid,headRefName,headRepository,baseRefName',
          ]),
        ),
      )
      const headRepository = object(pr?.headRepository)
      const headRepositoryName = headRepository?.nameWithOwner
      const headRefOid = pr?.headRefOid
      const headRefName = pr?.headRefName
      const baseRefName = pr?.baseRefName
      if (
        pr === null ||
        pr.state !== 'OPEN' ||
        typeof headRefOid !== 'string' ||
        headRefOid !== localHead ||
        typeof headRefName !== 'string' ||
        `refs/heads/${headRefName}` !== localRef ||
        typeof headRepositoryName !== 'string' ||
        typeof baseRefName !== 'string' ||
        baseRefName.length === 0
      ) {
        return fail('fix-publish-pr-binding-mismatch')
      }
      expectedRemoteRepository = headRepositoryName
      destinationRef = `refs/heads/${headRefName}`
      prFacts = { headRefOid, headRefName, headRepository: headRepositoryName, baseRefName }
    }
    if (remoteRepository !== expectedRemoteRepository) return fail('fix-publish-remote-repository-mismatch')
    if (localBranch === remoteDefault) return fail('fix-publish-default-branch-refused')
    const remoteLine = await git(cwd, ['ls-remote', '--refs', pushUrl, destinationRef])
    const remoteFields = remoteLine === '' ? [] : remoteLine.split(/\s+/)
    const expectedRemoteSHA =
      remoteFields.length === 0
        ? null
        : remoteFields.length === 2 && remoteFields[1] === destinationRef
          ? sha(remoteFields[0] ?? '')
          : null
    if (remoteLine !== '' && expectedRemoteSHA === null) return fail('fix-publish-remote-ref-unreadable')
    return {
      ok: true,
      value: {
        pushUrl,
        publicationRepository: expectedRemoteRepository,
        localBranch,
        destinationRef,
        localHead,
        expectedRemoteSHA,
        defaultBranch: remoteDefault,
        observed: {
          target: target.target,
          baseRepository: repository,
          baseDefaultBranch: defaultBranchName,
          localRef,
          localHead,
          pushUrl,
          remoteRepository,
          remoteDefaultBranch: remoteDefault,
          remoteLine,
          pr: prFacts,
        },
      },
    }
  } catch (error) {
    return fail(`fix-publish-binding-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseInvocation(
  args: string | undefined,
  reference: string | undefined,
): { reference: string | undefined; request: string; malformed: boolean } {
  if (reference !== undefined) return { reference, request: args?.trim() ?? '', malformed: false }
  const text = args?.trim() ?? ''
  const [first, ...rest] = text.split(/\s+/)
  if (!first) return { reference: undefined, request: '', malformed: false }
  if (/^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#?[1-9][0-9]*$/.test(first))
    return { reference: first, request: rest.join(' '), malformed: false }
  return { reference: undefined, request: text, malformed: first.startsWith('#') || first.includes('#') }
}

function targetFromPr(repository: string, number: number, details: unknown): FixTarget | null {
  const item = object(details)
  if (
    item === null ||
    item.state !== 'OPEN' ||
    typeof item.headRefOid !== 'string' ||
    !/^[0-9a-f]{40}$/.test(item.headRefOid)
  )
    return null
  return {
    repository,
    target: `${repository}#${number}`,
    number,
    kind: 'pull-request',
    state: 'open',
    candidateGitSHA: item.headRefOid,
  }
}

async function targetFromIssue(
  cwd: string,
  repository: string,
  number: number,
  details: unknown,
): Promise<FixTarget | null> {
  const item = object(details)
  if (item === null || item.state !== 'OPEN') return null
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
    const candidateGitSHA = String(stdout).trim()
    if (!/^[0-9a-f]{40}$/.test(candidateGitSHA)) return null
    return { repository, target: `${repository}#${number}`, number, kind: 'issue', state: 'open', candidateGitSHA }
  } catch {
    return null
  }
}

function createResolver(cwd: string, gh: Gh, repository: string): TargetResolver {
  const explicit = async (reference: string): Promise<FixTarget | null> => {
    const trimmed = reference.trim()
    const foreignRepository = /^([^#]+)#/.exec(trimmed)?.[1]
    if (foreignRepository !== undefined && foreignRepository !== repository) return null
    const match = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#?([1-9][0-9]*)$/.exec(trimmed)
    if (!match) return null
    const number = Number(match[1])
    try {
      return targetFromPr(
        repository,
        number,
        JSON.parse(await gh(cwd, ['pr', 'view', String(number), '--json', 'state,headRefOid'])),
      )
    } catch {
      try {
        return await targetFromIssue(
          cwd,
          repository,
          number,
          JSON.parse(await gh(cwd, ['issue', 'view', String(number), '--json', 'state'])),
        )
      } catch {
        return null
      }
    }
  }
  return {
    resolveExplicit: explicit,
    resolveContext: async () => {
      try {
        const value = object(JSON.parse(await gh(cwd, ['pr', 'view', '--json', 'number,state,headRefOid'])))
        return value !== null && typeof value.number === 'number' ? targetFromPr(repository, value.number, value) : null
      } catch {
        return null
      }
    },
  }
}

function confirmedRecord(
  history: DecodedHistory,
  recordId: string,
  kind: CanonicalRecord['kind'],
): CanonicalRecord | null {
  const operation = history.operations.find(
    (entry) => entry.status === 'complete' && entry.recordId === recordId && entry.kind === kind,
  )
  return operation?.record ?? null
}

function boundDecision(
  history: DecodedHistory,
  reviewId: string,
  candidate: string,
): Extract<CanonicalRecord, { kind: 'decision' }> | null {
  const review = confirmedRecord(history, reviewId, 'review')
  if (review?.kind !== 'review' || review.payload.candidateGitSHA !== candidate) return null
  const decision = confirmedRecord(history, review.payload.decisionId, 'decision')
  return decision?.kind === 'decision' ? decision : null
}

async function executeBoundDecision(
  prepared: PreparedFix,
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  input: DefaultFixEntry,
  publisher: RecordPublisher,
  id: FixIdentity,
  runtime: FixWorkflowRuntime,
  readHistory: () => Promise<DecodedHistory>,
): Promise<FixActionResult<FixRecord>> {
  return runReviewBoundFixWorkflow(
    prepared,
    decision as Extract<FixRecord, { kind: 'decision' }>,
    { native: input.native, publisher, runtime, readHistory },
    id,
    input.debtEvidence,
  )
}

/** Actual `/fix` ingress: fresh GH target/history binding, then standalone or review-bound correction. */
async function runDefaultFix(
  input: DefaultFixEntry,
  id: FixIdentity,
  runtime: FixWorkflowRuntime,
): Promise<FixActionResult<FixRecord>> {
  const gh = input.gh ?? defaultGh
  let repository: string
  try {
    const repo = object(JSON.parse(await gh(input.cwd, ['repo', 'view', '--json', 'nameWithOwner'])))
    if (repo === null || typeof repo.nameWithOwner !== 'string') return fail('fix-repository-unreadable')
    repository = repo.nameWithOwner
  } catch (error) {
    return fail(`fix-repository-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  const invocation = parseInvocation(input.args, input.reference)
  if (invocation.malformed) return fail('fix-reference-malformed')
  const reference = invocation.reference
  const resolver = createResolver(input.cwd, gh, repository)
  const target = reference === undefined ? await resolver.resolveContext() : await resolver.resolveExplicit(reference)
  if (target === null) return fail('fix-target-required')
  const publishBinding = await resolvePublishBinding(input.cwd, gh, repository, target)
  if (!publishBinding.ok) return publishBinding
  const github = withRoxabiGitHubPolicy(input.github ?? { cwd: input.cwd, gh })
  const scope = githubScope(repository, target.number)
  const rawPublisher = createGitHubRecordPublisher(scope, github, null)
  const publisher: RecordPublisher = {
    publish: async (record) => {
      const saved = await rawPublisher.publish(record)
      return saved.ok ? { ok: true, value: undefined } : saved
    },
  }
  const identity = id
  if (input.reviewId === undefined && invocation.request.length === 0 && input.rawOperatorRequest === undefined)
    return fail('fix-request-required')
  const correctionScope = input.scope ?? invocation.request
  const readHistory = async () => decodeHistory(await readGitHubHistory(scope, github))
  const authority = await decideFixAuthority({
    target,
    options: github,
    readHistory,
    branch: publishBinding.value.localBranch,
    base: publishBinding.value.defaultBranch,
    correctionScope,
  })
  if (!authority.ok) return authority
  let boundRecordId: string
  let sameScope = false
  if (authority.value.status === 'reuse') {
    boundRecordId = authority.value.mandate.recordId
    sameScope = authority.value.sameScope
  } else {
    const editedAt = await targetEditedAt(input.cwd, gh, target)
    const commit = target.candidateGitSHA
    if (editedAt === null || commit === null || correctionScope.length === 0) return fail('fix-only-scope-unreadable')
    const antecedent =
      authority.value.status === 'successor'
        ? {
            scope: { repository: authority.value.antecedent.repository, target: authority.value.antecedent.target },
            recordId: authority.value.antecedent.recordId,
            kind: 'mandate',
          }
        : null
    const parent: FixMandateView['parent'] =
      authority.value.status === 'successor' ? authority.value.antecedent.parent : null
    const draft = await loadFixOnlyDraft({
      cwd: input.cwd,
      commit,
      git: gitResult,
      scope: { repository: target.repository, target: target.target },
      recordId: `${identity.runId}-mandate-1`,
      runId: identity.runId,
      operationId: `${identity.operationId}-mandate`,
      branch: publishBinding.value.localBranch,
      base: publishBinding.value.defaultBranch,
      candidateGitSHA: commit,
      work: { reference: target.target, body: correctionScope, lastEditedAt: editedAt },
      parent,
      antecedent,
    })
    if (!draft.ok) return draft
    const built = await buildConfirmedFixOnlyMandate(draft.value)
    if (!built.ok) return built
    const saved = await rawPublisher.publish(built.value)
    if (!saved.ok) return saved
    const confirmed = confirmPublishedMandate(await readHistory(), built.value.recordId)
    if (!confirmed.ok) return confirmed
    boundRecordId = confirmed.value.recordId
    sameScope = true
  }
  runtime.bindContinuation?.(() =>
    confirmFixContinuation({
      target,
      options: github,
      readHistory,
      branch: publishBinding.value.localBranch,
      base: publishBinding.value.defaultBranch,
      correctionScope,
      boundRecordId,
    }),
  )
  const request = {
    cwd: input.cwd,
    reference,
    contextTarget: target,
    rawOperatorRequest: input.rawOperatorRequest ?? { request: invocation.request },
    scope: correctionScope,
    identity,
    debtEvidence: input.debtEvidence,
    publishBinding: publishBinding.value,
    authorityInputs: sameScope ? [boundRecordId] : undefined,
  }
  if (input.reviewId === undefined) {
    return runDefaultFixWorkflow(
      {
        resolver,
        publisher,
        readHistory,
        workflow: input.workflow,
        native: input.native,
        runtime,
      },
      request satisfies DefaultFixRequest,
    )
  }
  if (target.kind !== 'pull-request') return fail('review-fix-requires-pull-request')
  try {
    const history = decodeHistory(await readGitHubHistory(scope, github))
    if (!history.source.complete || target.candidateGitSHA === null) return fail('review-history-or-head-incomplete')
    const decision = boundDecision(history, input.reviewId, target.candidateGitSHA)
    if (decision === null) return fail('review-decision-unconfirmed-or-stale')
    const reviewRecord = confirmedRecord(history, input.reviewId, 'review')
    if (reviewRecord?.kind !== 'review') return fail('review-decision-unconfirmed-or-stale')
    const decisionBindings = validateReviewDecisionBindings(reviewRecord, history)
    if (!decisionBindings.ok) return fail('review-decision-bindings-invalid')
    const freshInput = await validateReviewInput(
      input.cwd,
      target.number,
      target.candidateGitSHA,
      reviewRecord.payload.input,
    )
    if (!freshInput.ok) return fail(`review-input-stale:${freshInput.reason}`)
    const policy: FixPolicy = decision.payload.judgment.policy
    const prepared = await prepareReviewBoundFix(
      {
        ...request,
        reviewId: input.reviewId,
        candidateGitSHA: target.candidateGitSHA,
        policy,
        nativeTasks: [],
      },
      resolver,
      publisher,
      input.workflow,
      runtime.signal,
    )
    if (!prepared.ok) return prepared
    return executeBoundDecision(prepared.value, decision, input, publisher, id, runtime, async () =>
      decodeHistory(await readGitHubHistory(scope, github)),
    )
  } catch (error) {
    return fail(`review-bound-fix-read-failed:${error instanceof Error ? error.message : String(error)}`)
  }
}

export function startDefaultFix(input: DefaultFixEntry): FixRun {
  const identity = createIdentity()
  const started = Promise.withResolvers<FixStart>()
  const completed = Promise.withResolvers<FixActionResult<FixRecord>>()
  const controller = new AbortController()
  let inhibit: 'pause' | null = null
  let continueBound: (() => Promise<FixActionResult<void>>) | null = null
  let stopped = false
  let startSettled = false
  let completionSettled = false
  let activeBatch: Parameters<NativePort['announce']>[0] | null = null
  const settleStarted = (value: FixStart) => {
    if (!startSettled) {
      startSettled = true
      started.resolve(value)
    }
  }
  const settleCompletion = (value: FixActionResult<FixRecord>) => {
    if (!completionSettled) {
      completionSettled = true
      completed.resolve(value)
    }
  }
  const runtime: FixWorkflowRuntime = {
    signal: controller.signal,
    onBatch(batch) {
      activeBatch = batch
    },
    onStarted() {
      if (!stopped) settleStarted({ status: 'accepted', runId: identity.runId, operationId: identity.operationId })
    },
    async beforeContinuation() {
      if (inhibit !== null || controller.signal.aborted) return fail('fix-mandate-refused:unconfirmed')
      if (continueBound === null) return fail('fix-mandate-authority-unavailable')
      const allowed = await continueBound()
      return inhibit !== null || controller.signal.aborted ? fail('fix-mandate-refused:unconfirmed') : allowed
    },
    bindContinuation(check) {
      continueBound = check
    },
  }
  void runDefaultFix(input, identity, runtime)
    .then((result) => {
      if (stopped) return
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
    .catch((error) => {
      if (stopped) return
      const result = fail<FixRecord>(`fix-run-failed:${error instanceof Error ? error.message : String(error)}`)
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
  return {
    runId: identity.runId,
    operationId: identity.operationId,
    started: started.promise,
    completion: completed.promise,
    terminal: completed.promise.then((result) =>
      result.ok && result.value.kind === 'fix-result'
        ? { status: 'complete', recordId: result.value.recordId, kind: 'fix-result' }
        : { status: 'stopped', diagnostics: result.ok ? ['fix-terminal-not-result'] : result.diagnostics },
    ),
    async stop(reason) {
      if (stopped) return
      inhibit = 'pause'
      stopped = true
      let archival: Promise<void> | null = null
      try {
        if (activeBatch !== null) archival = input.native.stopOwned(activeBatch, reason)
      } finally {
        controller.abort()
        const result = fail<FixRecord>(`fix-run-interrupted-cleanup-unproven:${reason}`)
        settleStarted({ status: 'terminal', result })
        settleCompletion(result)
      }
      if (archival !== null) await archival
    },
  }
}

/** Host payload for a correction that already has a confirmed CI attribution record. */
export type AdmittedCiCorrectionEntry = {
  cwd: string
  reference: string
  attributionRecordId: string
  scope: string
  native: NativePort
  workflow: ReviewAuthority
  github?: GitHubOptions
  gh?: Gh
  debtEvidence?: DebtEvidence
}

async function runAdmittedCiCorrectionEntry(
  input: AdmittedCiCorrectionEntry,
  identity: FixIdentity,
  runtime: FixWorkflowRuntime,
): Promise<FixActionResult<FixRecord>> {
  if (input.reference.trim().length === 0) return fail('fix-target-required')
  if (input.attributionRecordId.trim().length === 0) return fail('ci-correction-evidence-missing')
  if (input.scope.trim().length === 0) return fail('fix-scope-invalid')
  const gh = input.gh ?? defaultGh
  const repository = await gitResult(input.cwd, ['remote', 'get-url', 'origin'])
  if (repository.code !== 0) return fail(`fix-repository-unreadable:${repository.stderr.trim()}`)
  let canonicalRepository: string
  try {
    const repo = object(JSON.parse(await gh(input.cwd, ['repo', 'view', '--json', 'nameWithOwner'])))
    if (repo === null || typeof repo.nameWithOwner !== 'string' || repo.nameWithOwner.length === 0)
      return fail('fix-repository-unreadable')
    canonicalRepository = repo.nameWithOwner
  } catch (error) {
    return fail(`fix-repository-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  const resolver = createResolver(input.cwd, gh, canonicalRepository)
  const target = await resolver.resolveExplicit(input.reference)
  if (target === null) return fail('fix-target-required')
  const publishBinding = await resolvePublishBinding(input.cwd, gh, target.repository, target)
  if (!publishBinding.ok) return publishBinding
  const github = withRoxabiGitHubPolicy(input.github ?? { cwd: input.cwd, gh })
  const scope = githubScope(target.repository, target.number)
  const rawPublisher = createGitHubRecordPublisher(scope, github, null)
  const publisher: RecordPublisher = {
    publish: async (record) => {
      const saved = await rawPublisher.publish(record)
      return saved.ok ? { ok: true, value: undefined } : saved
    },
  }
  const readHistory = () => readGitHubHistory(scope, github).then(decodeHistory)
  return runAdmittedCiCorrection(
    {
      cwd: input.cwd,
      target,
      scope: input.scope,
      branch: publishBinding.value.localBranch,
      base: publishBinding.value.defaultBranch,
      attributionRecordId: input.attributionRecordId,
      workflow: input.workflow,
      options: github,
      readHistory,
      signal: runtime.signal,
    },
    {
      resolver,
      publisher,
      readHistory,
      workflow: input.workflow,
      native: input.native,
      runtime,
      identity,
      publishBinding: publishBinding.value,
      debtEvidence: input.debtEvidence,
    },
  )
}

/**
 * Starts the admitted CI correction path. Does not call admitReviewFix, so a ci-failed
 * workflow step cannot be smuggled through the generic /fix refusal.
 */
export function startAdmittedCiCorrection(input: AdmittedCiCorrectionEntry): FixRun {
  const identity = createIdentity()
  const started = Promise.withResolvers<FixStart>()
  const completed = Promise.withResolvers<FixActionResult<FixRecord>>()
  const controller = new AbortController()
  let inhibit: 'pause' | null = null
  let continueBound: (() => Promise<FixActionResult<void>>) | null = null
  let stopped = false
  let startSettled = false
  let completionSettled = false
  let activeBatch: Parameters<NativePort['announce']>[0] | null = null
  const settleStarted = (value: FixStart) => {
    if (!startSettled) {
      startSettled = true
      started.resolve(value)
    }
  }
  const settleCompletion = (value: FixActionResult<FixRecord>) => {
    if (!completionSettled) {
      completionSettled = true
      completed.resolve(value)
    }
  }
  const runtime: FixWorkflowRuntime = {
    signal: controller.signal,
    onBatch(batch) {
      activeBatch = batch
    },
    onStarted() {
      if (!stopped) settleStarted({ status: 'accepted', runId: identity.runId, operationId: identity.operationId })
    },
    async beforeContinuation() {
      if (inhibit !== null || controller.signal.aborted) return fail('fix-mandate-refused:unconfirmed')
      if (continueBound === null) return fail('fix-mandate-authority-unavailable')
      const allowed = await continueBound()
      return inhibit !== null || controller.signal.aborted ? fail('fix-mandate-refused:unconfirmed') : allowed
    },
    bindContinuation(check) {
      continueBound = check
    },
  }
  void runAdmittedCiCorrectionEntry(input, identity, runtime)
    .then((result) => {
      if (stopped) return
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
    .catch((error) => {
      if (stopped) return
      const result = fail<FixRecord>(`fix-run-failed:${error instanceof Error ? error.message : String(error)}`)
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
  return {
    runId: identity.runId,
    operationId: identity.operationId,
    started: started.promise,
    completion: completed.promise,
    terminal: completed.promise.then((result) =>
      result.ok && result.value.kind === 'fix-result'
        ? { status: 'complete', recordId: result.value.recordId, kind: 'fix-result' }
        : { status: 'stopped', diagnostics: result.ok ? ['fix-terminal-not-result'] : result.diagnostics },
    ),
    async stop(reason) {
      if (stopped) return
      inhibit = 'pause'
      stopped = true
      let archival: Promise<void> | null = null
      try {
        if (activeBatch !== null) archival = input.native.stopOwned(activeBatch, reason)
      } finally {
        controller.abort()
        const result = fail<FixRecord>(`fix-run-interrupted-cleanup-unproven:${reason}`)
        settleStarted({ status: 'terminal', result })
        settleCompletion(result)
      }
      if (archival !== null) await archival
    },
  }
}
