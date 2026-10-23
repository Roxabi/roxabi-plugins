import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { decodeHistory, encodeRecord } from '../adapters/github.ts'
import { buildRecord } from '../engine/core.ts'
import type {
  CanonicalRecord,
  Contribution,
  DecodedHistory,
  ExternalRecordRef,
  History,
  Json,
  PlanReviewSlot,
  ProofConfigPin,
  Scope,
} from '../engine/schemas.ts'
import { planDigest, specDigest } from '../engine/schemas.ts'
import {
  configPinDigest,
  effectiveWorkflowConfig,
  installedProductVersion,
  WORKFLOW_CONFIG_VERSION,
  workflowConfigDigest,
} from '../roxabi/workflow-config.ts'

const HEAD = '1111111111111111111111111111111111111111'
const PIN_COMMIT = '2222222222222222222222222222222222222222'
const CATALOGUE = new URL('../skills/dev-review/review-classes.yml', import.meta.url)
const PACKAGE = new URL('../package.json', import.meta.url)

/** Host-side package metadata. The pure engine does not read this file. */
export function hostProductVersion(): string {
  const raw = JSON.parse(readFileSync(PACKAGE, 'utf8')) as { name?: string; version?: string }
  if (raw.name !== 'omp-build' || raw.version === undefined || raw.version.length === 0) {
    throw new Error('omp-build package metadata has no version')
  }
  return raw.version
}

export function shippedConfigPin(): { version: string; digest: string } {
  const text = readFileSync(CATALOGUE, 'utf8')
  const version = text.match(/^version:\s*"([^"]+)"/m)?.[1]
  if (version === undefined) throw new Error('review catalogue has no version')
  return { version, digest: createHash('sha256').update(text, 'utf8').digest('hex') }
}

export function catalogueProofPin(blob: string | null = null): ProofConfigPin {
  return {
    sourceCommit: PIN_COMMIT,
    path: 'plugins/omp-build/skills/dev-review/review-classes.yml',
    blob,
  }
}

/** Shipped effective config, including compatibility and graph digest. */
export function serializedGraph(productVersion = installedProductVersion()): Json {
  return effectiveWorkflowConfig(productVersion, [])
}

export type ApprovedChild = { scope: Scope; specDigest: string; specBody: string }

const SPEC_BODY = '## Acceptance\n- [ ] Save keeps the selected region'
const EDITED_AT = '2026-10-21T12:00:00Z'

function mustRecord(draft: Parameters<typeof buildRecord>[0]): CanonicalRecord {
  const built = buildRecord(draft)
  if (!built.ok) {
    throw new Error(built.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '))
  }
  return built.value
}

/**
 * Shipped lifecycle config pins the full effective descriptor; graph digest
 * remains inside that descriptor for graph validation only.
 */
export function shippedMandateConfig(productVersion = installedProductVersion()) {
  const effective = effectiveWorkflowConfig(productVersion, [])
  return {
    productVersion,
    version: WORKFLOW_CONFIG_VERSION,
    digest: configPinDigest(effective),
    effective,
  }
}

function graphConfigVersion(graph: Json): string {
  if (
    graph !== null &&
    typeof graph === 'object' &&
    !Array.isArray(graph) &&
    'configVersion' in graph &&
    typeof graph.configVersion === 'string' &&
    graph.configVersion.length > 0
  ) {
    return graph.configVersion
  }
  return WORKFLOW_CONFIG_VERSION
}

/**
 * Mandate config for fixtures. Default is the whole shipped descriptor.
 * A graph override is for synthetic decision-reconstruction only and keeps
 * version/digest tied to that graph's configVersion — never a catalogue pin
 * over a shipped effective graph.
 */
function config(productVersion = installedProductVersion(), graph?: Json) {
  if (graph === undefined) return shippedMandateConfig(productVersion)
  const configVersion = graphConfigVersion(graph)
  return {
    productVersion,
    version: configVersion,
    digest: configVersion === WORKFLOW_CONFIG_VERSION ? workflowConfigDigest() : shippedConfigPin().digest,
    effective: { graph },
  }
}

function spec(body: string, reference: string) {
  return { reference, body, bodySha256: specDigest(body), lastEditedAt: EDITED_AT }
}

export function childSnapshot(scope: Scope, specBody: string): ApprovedChild {
  return { scope, specBody, specDigest: specDigest(specBody) }
}

export function featureMandate(
  scope: Scope,
  overrides: {
    recordId?: string
    operationId?: string
    runId?: string
    branch?: string | null
    base?: string
    lineageHead?: string | null
    body?: string
    productVersion?: string
    proofPins?: ProofConfigPin[]
    parent?: ExternalRecordRef | null
    antecedent?: ExternalRecordRef | null
    graph?: Json
  } = {},
): CanonicalRecord {
  const body = overrides.body ?? SPEC_BODY
  return mustRecord({
    version: 1,
    recordId: overrides.recordId ?? 'mandate-feature-1',
    runId: overrides.runId ?? 'run00001',
    operationId: overrides.operationId ?? 'op-mandate-feature-1',
    repository: scope.repository,
    target: scope.target,
    kind: 'mandate',
    payload: {
      role: 'feature',
      run: null,
      children: null,
      branch: overrides.branch === undefined ? 'feat/42-save' : overrides.branch,
      base: overrides.base ?? 'main',
      lineageHead: overrides.lineageHead === undefined ? HEAD : overrides.lineageHead,
      config: config(overrides.productVersion, overrides.graph),
      proofPins: overrides.proofPins ?? [catalogueProofPin()],
      parent: overrides.parent ?? null,
      antecedent: overrides.antecedent ?? null,
      spec: spec(body, scope.target),
      permissions: { landing: true, correct: true },
    },
  })
}

export function epicMandate(
  scope: Scope,
  children: ApprovedChild[],
  overrides: {
    recordId?: string
    operationId?: string
    runId?: string
    run?: string
    base?: string
    body?: string
    productVersion?: string
  } = {},
): CanonicalRecord {
  const body = overrides.body ?? '## Acceptance\n- [ ] Deliver the epic'
  const productVersion = overrides.productVersion ?? installedProductVersion()
  return mustRecord({
    version: 1,
    recordId: overrides.recordId ?? 'mandate-epic-1',
    runId: overrides.runId ?? 'run00001',
    operationId: overrides.operationId ?? 'op-mandate-epic-1',
    repository: scope.repository,
    target: scope.target,
    kind: 'mandate',
    payload: {
      role: 'epic',
      run: overrides.run ?? 'run00001',
      children,
      branch: null,
      base: overrides.base ?? 'main',
      lineageHead: null,
      config: shippedMandateConfig(productVersion),
      proofPins: [catalogueProofPin()],
      parent: null,
      antecedent: null,
      spec: spec(body, scope.target),
      permissions: { landing: true, correct: true },
    },
  })
}

export function fixOnlyMandate(
  scope: Scope,
  overrides: { recordId?: string; operationId?: string; body?: string; productVersion?: string; graph?: Json } = {},
): CanonicalRecord {
  const body = overrides.body ?? SPEC_BODY
  return mustRecord({
    version: 1,
    recordId: overrides.recordId ?? 'mandate-fix-1',
    runId: 'run00001',
    operationId: overrides.operationId ?? 'op-mandate-fix-1',
    repository: scope.repository,
    target: scope.target,
    kind: 'mandate',
    payload: {
      role: 'fix-only',
      run: null,
      children: null,
      branch: 'fix/42-save',
      base: 'main',
      lineageHead: HEAD,
      config: config(overrides.productVersion, overrides.graph),
      proofPins: [catalogueProofPin()],
      parent: null,
      antecedent: null,
      spec: spec(body, scope.target),
      permissions: { landing: false, correct: true },
    },
  })
}

export function mandateRef(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}

/** One complete PR binding. Closing text is not a substitute. */
export function workflowBinding(
  pullRequest: Scope,
  mandate: CanonicalRecord,
  branch: string,
  base: string,
): CanonicalRecord {
  const recordId = `workflow-binding:${pullRequest.target}:${mandate.recordId}`
  return mustRecord({
    version: 1,
    recordId,
    runId: recordId,
    operationId: recordId,
    repository: pullRequest.repository,
    target: pullRequest.target,
    kind: 'workflow-binding',
    payload: {
      mandate: {
        scope: { repository: mandate.repository, target: mandate.target },
        recordId: mandate.recordId,
        kind: 'mandate',
      },
      branch,
      base,
    },
  })
}

export function pauseRequested(mandate: CanonicalRecord, controlId = 'control-pause-1'): CanonicalRecord {
  return mustRecord({
    version: 1,
    recordId: `${controlId}-requested`,
    runId: mandate.runId,
    operationId: `op-${controlId}-requested`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'operator-control',
    payload: {
      control: 'pause-requested',
      predecessor: null,
      controlId,
      mandate: mandateRef(mandate),
    },
  })
}

export function pauseConfirmed(
  mandate: CanonicalRecord,
  request: CanonicalRecord,
  controlId = 'control-pause-1',
): CanonicalRecord {
  return mustRecord({
    version: 1,
    recordId: `${controlId}-confirmed`,
    runId: mandate.runId,
    operationId: `op-${controlId}-confirmed`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'operator-control',
    payload: {
      control: 'pause-confirmed',
      predecessor: mandateRef(request),
      controlId,
      mandate: mandateRef(mandate),
      disarm: { observed: true, evidence: { pr: 20, disabled: true } },
    },
  })
}

export function implementStart(mandate: CanonicalRecord, actionId = 'act-implement-1'): CanonicalRecord {
  return mustRecord({
    version: 1,
    recordId: `${actionId}-start`,
    runId: mandate.runId,
    operationId: `op-${actionId}-start`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'start',
      action: 'implement',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs: { mandateId: mandate.recordId, planActionId: 'act-plan-1' },
    },
  })
}

const PLAN_OUTPUT = {
  steps: [
    {
      id: 'step-1',
      change: 'persist the selected region',
      doneWhen: 'the region survives a reload',
      criterion: 'save',
      evidence: 'the save test passes',
      paths: ['src/save.ts'],
    },
  ],
  resolutions: [],
}
const PLAN_SLOTS: PlanReviewSlot[] = [
  { slotId: 'slot-architect', specialist: 'R-workflow-plan-architect' },
  { slotId: 'slot-adversarial', specialist: 'R-workflow-plan-adversarial' },
]
const NATIVE_OK = { completion: 'completed' as const, strict: 'valid' as const, raw: null }

function specSha(mandate: CanonicalRecord): string {
  if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
  return mandate.payload.spec.bodySha256
}

function planContribution(slotId: string, specialist: string, structured: Json): Contribution {
  return {
    content: 'findings',
    inventoryId: null,
    host: { origin: 'native', phase: null, role: specialist, slotId, chunk: 0, childId: slotId },
    rawAttempts: [],
    native: NATIVE_OK,
    structured,
    findings: null,
  }
}

export function planDraftRecords(mandate: CanonicalRecord, actionId = 'act-plan-1'): CanonicalRecord[] {
  const start = mustRecord({
    version: 1,
    recordId: `${actionId}-start`,
    runId: mandate.runId,
    operationId: `op-${actionId}-start`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'start',
      action: 'plan',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest: specSha(mandate),
        amendsReviewActionId: null,
        requiredBlockers: [],
      },
    },
  })
  const result = mustRecord({
    version: 1,
    recordId: `${actionId}-result`,
    runId: mandate.runId,
    operationId: `op-${actionId}-result`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'result',
      action: 'plan',
      actionId,
      mandate: mandateRef(mandate),
      start: mandateRef(start),
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest: specSha(mandate),
        amendsReviewActionId: null,
        requiredBlockers: [],
      },
      native: NATIVE_OK,
      structured: PLAN_OUTPUT,
      admission: null,
      diagnostics: [],
    },
  })
  return [start, result]
}
export function planReviewStart(
  mandate: CanonicalRecord,
  draftActionId: string,
  digest: string,
  actionId = 'act-plan-review-1',
): CanonicalRecord {
  return mustRecord({
    version: 1,
    recordId: `${actionId}-start`,
    runId: mandate.runId,
    operationId: `op-${actionId}-start`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'start',
      action: 'plan-review',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs: { mandateId: mandate.recordId, specDigest: specSha(mandate), planDigest: digest, draftActionId },
      slots: PLAN_SLOTS,
    },
  })
}

export function planReviewRecord(
  mandate: CanonicalRecord,
  draftActionId: string,
  digest: string,
  contributions: Contribution[],
  actionId = 'act-plan-review-1',
): CanonicalRecord {
  const start = mustRecord({
    version: 1,
    recordId: `${actionId}-start`,
    runId: mandate.runId,
    operationId: `op-${actionId}-start`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'start',
      action: 'plan-review',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs: { mandateId: mandate.recordId, specDigest: specSha(mandate), planDigest: digest, draftActionId },
      slots: PLAN_SLOTS,
    },
  })
  return mustRecord({
    version: 1,
    recordId: `${actionId}-result`,
    runId: mandate.runId,
    operationId: `op-${actionId}-result`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'result',
      action: 'plan-review',
      actionId,
      mandate: mandateRef(mandate),
      start: mandateRef(start),
      exactInputs: { mandateId: mandate.recordId, specDigest: specSha(mandate), planDigest: digest, draftActionId },
      slots: PLAN_SLOTS,
      contributions,
      native: NATIVE_OK,
      structured: null,
      admission: null,
      diagnostics: [],
    },
  })
}

export function clearPlanContribution(slotId: string, specialist: string): Contribution {
  return planContribution(slotId, specialist, { outcome: 'clear', blockers: [] })
}

export function blockingPlanContribution(slotId: string, specialist: string, blockerId: string): Contribution {
  return planContribution(slotId, specialist, {
    outcome: 'blocking',
    blockers: [{ id: blockerId, criterion: 'save', gap: 'the mapping omits the stale-region path' }],
  })
}

export function planAmendmentRecords(
  mandate: CanonicalRecord,
  reviewActionId: string,
  requiredBlockers: { sourceId: string; slotId: string; blockerId: string }[],
  resolutions: {
    blocker: { sourceId: string; slotId: string; blockerId: string }
    stepIds: string[]
    reason: string
  }[],
  actionId = 'act-plan-2',
): CanonicalRecord[] {
  const start = mustRecord({
    version: 1,
    recordId: `${actionId}-start`,
    runId: mandate.runId,
    operationId: `op-${actionId}-start`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'start',
      action: 'plan',
      actionId,
      mandate: mandateRef(mandate),
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest: specSha(mandate),
        amendsReviewActionId: reviewActionId,
        requiredBlockers,
      },
    },
  })
  const result = mustRecord({
    version: 1,
    recordId: `${actionId}-result`,
    runId: mandate.runId,
    operationId: `op-${actionId}-result`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'result',
      action: 'plan',
      actionId,
      mandate: mandateRef(mandate),
      start: mandateRef(start),
      exactInputs: {
        mandateId: mandate.recordId,
        specDigest: specSha(mandate),
        amendsReviewActionId: reviewActionId,
        requiredBlockers,
      },
      native: NATIVE_OK,
      structured: { ...PLAN_OUTPUT, resolutions },
      admission: null,
      diagnostics: [],
    },
  })
  return [start, result]
}

export function publishedPlanDigest(): string {
  return planDigest(PLAN_OUTPUT)
}

export function rejectedImplementResult(mandate: CanonicalRecord, actionId = 'act-implement-1'): CanonicalRecord {
  const start = implementStart(mandate, actionId)
  return mustRecord({
    version: 1,
    recordId: `${actionId}-result`,
    runId: mandate.runId,
    operationId: `op-${actionId}-result`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'action-receipt',
    payload: {
      phase: 'result',
      action: 'implement',
      actionId,
      mandate: mandateRef(mandate),
      start: mandateRef(start),
      exactInputs: { mandateId: mandate.recordId, planActionId: 'act-plan-1' },
      native: NATIVE_OK,
      structured: {
        outcome: 'implemented',
        commitSHAs: [HEAD],
        commands: [{ toolCallId: 'call-1', command: 'git status', exitCode: 0 }],
        proofToolCallId: 'proof-1',
        proofUnavailableReason: null,
        reason: 'model claims implemented',
      },
      admission: {
        admitted: false,
        commits: [],
        paths: [],
        commands: [{ toolCallId: 'call-1', command: 'git status', exitCode: 0, cwd: '/tmp/worktree' }],
        remoteBranch: null,
        remoteTip: null,
        published: false,
        reason: 'remote tip unreachable',
      },
      diagnostics: [],
    },
  })
}

function emptyHistory(scope: Scope, author: string): History {
  return {
    scope,
    expectedAuthor: author,
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  }
}

/** Canonical comment bodies. Authority is the framed record, not the projection. */
export function framedBodies(
  records: readonly CanonicalRecord[],
  author: string,
  externalHistories: readonly DecodedHistory[] = [],
): string[] {
  const comments: string[] = []
  for (const record of records) {
    const scope = { repository: record.repository, target: record.target }
    const history = emptyHistory(scope, author)
    history.comments = comments.map((body, index) => ({
      locator: `${scope.target}:comment:${index + 1}`,
      nativeId: String(index + 1),
      body,
      author,
      createdAt: EDITED_AT,
      updatedAt: EDITED_AT,
    }))
    const encoded = encodeRecord(record, history, null, externalHistories)
    if (!encoded.ok) {
      throw new Error(encoded.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '))
    }
    comments.push(...encoded.value)
  }
  return comments
}

/** A complete history whose only authority is the framed comments. No loose record array. */
export function historyFrom(
  records: readonly CanonicalRecord[],
  author = 'operator',
  expectedAuthor = author,
  externalHistories: readonly DecodedHistory[] = [],
): DecodedHistory {
  const first = records[0]
  if (first === undefined) throw new Error('a history needs at least one record')
  const scope = { repository: first.repository, target: first.target }
  const bodies = framedBodies(records, author, externalHistories)
  return decodeHistory({
    ...emptyHistory(scope, expectedAuthor),
    comments: bodies.map((body, index) => ({
      locator: `${scope.target}:comment:${index + 1}`,
      nativeId: String(index + 1),
      body,
      author,
      createdAt: EDITED_AT,
      updatedAt: EDITED_AT,
    })),
  })
}

/** Linked landing authority: issue mandate + PR workflow-binding with separate histories. */
export type LinkedLandingAuthority = {
  mandate: CanonicalRecord
  binding: CanonicalRecord
  issueScope: Scope
  pullRequest: Scope
  issueBodies: string[]
  bindingBodies: string[]
  issueHistory: DecodedHistory
}

export function linkedLandingAuthority(input: {
  repository: string
  issueNumber: number
  prNumber: number
  branch: string
  base: string
  issueBody: string
  proofPins: readonly ProofConfigPin[]
  lineageHead?: string | null
  author?: string
}): LinkedLandingAuthority {
  const author = input.author ?? 'operator'
  const issueScope = { repository: input.repository, target: `${input.repository}#${input.issueNumber}` }
  const pullRequest = { repository: input.repository, target: `${input.repository}#${input.prNumber}` }
  const mandate = featureMandate(issueScope, {
    body: input.issueBody,
    branch: input.branch,
    base: input.base,
    lineageHead: input.lineageHead === undefined ? null : input.lineageHead,
    proofPins: [...input.proofPins],
  })
  const binding = workflowBinding(pullRequest, mandate, input.branch, input.base)
  // Shared GH number namespace (Closes #N on PR #N): one real scope stream — mandate is a
  // same-scope binding input. Do not publish a second framed mandate stream on the issue side.
  const sameScope = issueScope.repository === pullRequest.repository && issueScope.target === pullRequest.target
  if (sameScope) {
    const bodies = framedBodies([mandate, binding], author)
    return {
      mandate,
      binding,
      issueScope,
      pullRequest,
      issueBodies: [],
      bindingBodies: bodies,
      issueHistory: historyFrom([mandate, binding], author),
    }
  }
  const issueHistory = historyFrom([mandate], author)
  return {
    mandate,
    binding,
    issueScope,
    pullRequest,
    issueBodies: framedBodies([mandate], author),
    bindingBodies: framedBodies([binding], author, [issueHistory]),
    issueHistory,
  }
}
