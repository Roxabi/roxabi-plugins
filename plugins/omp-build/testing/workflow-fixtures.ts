import { decodeHistory, encodeRecord } from '../adapters/github.ts'
import type { DecodedHistory, History } from '../engine/history-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import { specDigest } from '../engine/record-digests.ts'
import type { ExternalRecordRef, ProofConfigPin } from '../engine/record-references.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Json, Scope } from '../engine/record-values.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'

export type WorkflowFixtureContext = {
  productVersion: string
  config: { version: string; digest: string; effective: Json }
  proofPins: readonly ProofConfigPin[]
  head: string | null
  editedAt: string
}

export type ApprovedChild = { scope: Scope; specDigest: string; specBody: string }

type MandateOverrides = {
  recordId?: string
  operationId?: string
  runId?: string
  branch?: string | null
  base?: string
  lineageHead?: string | null
  body?: string
  proofPins?: readonly ProofConfigPin[]
  parent?: ExternalRecordRef | null
  antecedent?: ExternalRecordRef | null
  config?: WorkflowFixtureContext['config']
}

function mustRecord(draft: Parameters<typeof buildRecord>[0]): CanonicalRecord {
  const result = buildRecord(draft)
  if (!result.ok) throw new Error(result.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; '))
  return result.value
}

function mustMandate(draft: Parameters<typeof buildRecord>[0]): MandateRecord {
  const record = mustRecord(draft)
  if (record.kind !== 'mandate') throw new Error('fixture is not a mandate')
  return record
}

export function createWorkflowFixtures(context: WorkflowFixtureContext) {
  const spec = (body: string, reference: string) => ({
    reference,
    body,
    bodySha256: specDigest(body),
    lastEditedAt: context.editedAt,
  })
  const mandateRef = (record: CanonicalRecord): ExternalRecordRef => ({
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  })
  const childSnapshot = (scope: Scope, specBody: string): ApprovedChild => ({
    scope,
    specBody,
    specDigest: specDigest(specBody),
  })
  const featureMandate = (scope: Scope, overrides: MandateOverrides = {}) => {
    const body = overrides.body ?? '## Acceptance\n- [ ] Save keeps the selected region'
    return mustMandate({
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
        lineageHead: overrides.lineageHead === undefined ? context.head : overrides.lineageHead,
        config: { productVersion: context.productVersion, ...(overrides.config ?? context.config) },
        proofPins: [...(overrides.proofPins ?? context.proofPins)],
        parent: overrides.parent ?? null,
        antecedent: overrides.antecedent ?? null,
        spec: spec(body, scope.target),
        permissions: { landing: true, correct: true },
      },
    })
  }
  const epicMandate = (scope: Scope, children: ApprovedChild[], overrides: MandateOverrides = {}) => {
    const body = overrides.body ?? '## Acceptance\n- [ ] Deliver the epic'
    return mustMandate({
      version: 1,
      recordId: overrides.recordId ?? 'mandate-epic-1',
      runId: overrides.runId ?? 'run00001',
      operationId: overrides.operationId ?? 'op-mandate-epic-1',
      repository: scope.repository,
      target: scope.target,
      kind: 'mandate',
      payload: {
        role: 'epic',
        run: overrides.runId ?? 'run00001',
        children,
        branch: null,
        base: overrides.base ?? 'main',
        lineageHead: null,
        config: { productVersion: context.productVersion, ...(overrides.config ?? context.config) },
        proofPins: [...(overrides.proofPins ?? context.proofPins)],
        parent: null,
        antecedent: null,
        spec: spec(body, scope.target),
        permissions: { landing: true, correct: true },
      },
    })
  }
  const fixOnlyMandate = (scope: Scope, overrides: MandateOverrides = {}) => {
    const body = overrides.body ?? '## Acceptance\n- [ ] Save keeps the selected region'
    return mustMandate({
      version: 1,
      recordId: overrides.recordId ?? 'mandate-fix-1',
      runId: overrides.runId ?? 'run00001',
      operationId: overrides.operationId ?? 'op-mandate-fix-1',
      repository: scope.repository,
      target: scope.target,
      kind: 'mandate',
      payload: {
        role: 'fix-only',
        run: null,
        children: null,
        branch: overrides.branch ?? 'fix/42-save',
        base: overrides.base ?? 'main',
        lineageHead: overrides.lineageHead === undefined ? context.head : overrides.lineageHead,
        config: { productVersion: context.productVersion, ...(overrides.config ?? context.config) },
        proofPins: [...(overrides.proofPins ?? context.proofPins)],
        parent: overrides.parent ?? null,
        antecedent: overrides.antecedent ?? null,
        spec: spec(body, scope.target),
        permissions: { landing: false, correct: true },
      },
    })
  }
  const workflowBinding = (pullRequest: Scope, mandate: CanonicalRecord, branch: string, base: string) => {
    const recordId = `workflow-binding:${pullRequest.target}:${mandate.recordId}`
    return mustRecord({
      version: 1,
      recordId,
      runId: recordId,
      operationId: recordId,
      repository: pullRequest.repository,
      target: pullRequest.target,
      kind: 'workflow-binding',
      payload: { mandate: mandateRef(mandate), branch, base },
    })
  }
  const framedBodies = (
    records: readonly CanonicalRecord[],
    author: string,
    externalHistories: readonly DecodedHistory[] = [],
  ) => {
    const comments: string[] = []
    for (const record of records) {
      const history: History = {
        scope: { repository: record.repository, target: record.target },
        expectedAuthor: author,
        stopAuthor: null,
        complete: true,
        comments: comments.map((body, index) => ({
          locator: `${record.target}:comment:${index + 1}`,
          nativeId: String(index + 1),
          body,
          author,
          createdAt: context.editedAt,
          updatedAt: context.editedAt,
        })),
        diagnostics: [],
      }
      const encoded = encodeRecord(record, history, null, externalHistories)
      if (!encoded.ok) throw new Error(encoded.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; '))
      comments.push(...encoded.value)
    }
    return comments
  }
  const historyFrom = (
    records: readonly CanonicalRecord[],
    author = 'operator',
    expectedAuthor = author,
    externalHistories: readonly DecodedHistory[] = [],
  ) => {
    const first = records[0]
    if (first === undefined) throw new Error('a history needs at least one record')
    const bodies = framedBodies(records, author, externalHistories)
    return decodeHistory({
      scope: { repository: first.repository, target: first.target },
      expectedAuthor,
      stopAuthor: null,
      complete: true,
      comments: bodies.map((body, index) => ({
        locator: `${first.target}:comment:${index + 1}`,
        nativeId: String(index + 1),
        body,
        author,
        createdAt: context.editedAt,
        updatedAt: context.editedAt,
      })),
      diagnostics: [],
    })
  }
  const linkedLandingAuthority = (input: {
    repository: string
    issueNumber: number
    prNumber: number
    branch: string
    base: string
    issueBody: string
    proofPins: readonly ProofConfigPin[]
    lineageHead?: string | null
    author?: string
  }) => {
    const author = input.author ?? 'operator'
    const issueScope = { repository: input.repository, target: `${input.repository}#${input.issueNumber}` }
    const pullRequest = { repository: input.repository, target: `${input.repository}#${input.prNumber}` }
    const mandate = featureMandate(issueScope, {
      body: input.issueBody,
      branch: input.branch,
      base: input.base,
      lineageHead: input.lineageHead === undefined ? null : input.lineageHead,
      proofPins: input.proofPins,
    })
    const binding = workflowBinding(pullRequest, mandate, input.branch, input.base)
    const sameScope = issueScope.repository === pullRequest.repository && issueScope.target === pullRequest.target
    if (sameScope) {
      const bindingBodies = framedBodies([mandate, binding], author)
      return {
        mandate,
        binding,
        issueScope,
        pullRequest,
        issueBodies: [],
        bindingBodies,
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
  return {
    childSnapshot,
    featureMandate,
    epicMandate,
    fixOnlyMandate,
    mandateRef,
    workflowBinding,
    framedBodies,
    historyFrom,
    linkedLandingAuthority,
  }
}
