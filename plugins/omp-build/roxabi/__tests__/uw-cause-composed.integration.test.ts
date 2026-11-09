import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { bindExternalRef, recordsOf } from '../../dist/contracts.js'
import type { CauseCreationProposal } from '../../engine/cause-disposition-schema.ts'
import type { ExternalRecordRef } from '../../engine/record-references.ts'
import type { Scope } from '../../engine/record-values.ts'
import { readComposedMaterialIntent } from '../../engine/workflow-composed-material-intent.ts'
import type { UwOperations, UwRead } from '../uw-contract.ts'
import { cleanupComposedScenario, scenario } from './uw-cause-composed-fixture.ts'

afterEach(cleanupComposedScenario)

it('accepts a blocking sister and exact parent coverage in one confirmed decision without completing the work', async () => {
  const { world, request, decisions, result } = await scenario(() => true)
  expect(result.status, JSON.stringify(result)).toBe('created')
  if (result.status !== 'created' || world.parent === null) throw new Error('Expected created sister and active parent')
  expect(world.effective.versionVector).toEqual([
    {
      uw: request.disposition.scope,
      version: world.mandate.payload.ownSpec.version,
      sourceAccepted: { scope: request.disposition.scope, recordId: world.mandate.recordId, kind: 'mandate' },
    },
    {
      uw: world.parent.scope,
      version: world.parent.version,
      sourceAccepted: { scope: world.parent.scope, recordId: world.parent.mandate.recordId, kind: 'mandate' },
    },
  ])
  expect(decisions).toHaveLength(1)
  expect(decisions[0]?.detail).toContain('Confirmer')
  expect(world.issues.get(43)?.parent).toBe(41)
  expect(world.issues.get(42)?.blockers).toContain(43)
  const parent = await world.operations.readUw(world.parent.scope)
  expect(parent.accepted.status).toBe('accepted')
  if (parent.accepted.status !== 'accepted') throw new Error('Parent acceptance unavailable')
  expect(parent.accepted.value.ref.sourceAccepted).toEqual({
    scope: world.parent.scope,
    recordId: world.parent.mandate.recordId,
    kind: 'mandate',
  })
  const acceptance = parent.accepted.value.chain.at(-1)
  if (acceptance?.kind !== 'accept-material') throw new Error('Parent material acceptance missing')
  expect(acceptance.source).toMatchObject({ scope: world.parent.scope, kind: 'operator-control' })
  expect(parent.accepted.value.children.map((child) => child.scope)).toEqual(
    expect.arrayContaining([request.disposition.scope, result.value.uw]),
  )
  expect(
    parent.accepted.value.children.find((child) => child.scope.target === request.disposition.scope.target),
  ).toEqual(world.parent.mandate.payload.children[0])
  if (result.value.parsed.status !== 'conformant') throw new Error('Created sister Spec is not conformant')
  const createdCommitment = parent.accepted.value.children.find(
    (child) => child.scope.target === result.value.uw.target,
  )
  expect(createdCommitment).toMatchObject({
    scope: result.value.uw,
    snapshot: result.value.parsed.snapshot,
    specVersion: result.value.parsed.snapshot.spec.version,
  })
  expect(parent.accepted.value.tier).toBe(world.parent.mandate.payload.tier)
  expect(parent.accepted.value.ref.version).toBe(world.parent.version)
  expect(parent.accepted.value.coverage?.assignments[0]?.children).toEqual(
    expect.arrayContaining([request.disposition.scope, result.value.uw]),
  )
  const origin = await world.operations.readUw(request.disposition.scope)
  const own = origin.histories.find((history) => history.source.scope.target === request.disposition.scope.target)
  if (!own) throw new Error('Origin history unavailable')
  const receipt = bindExternalRef(result.receipt, own)
  if (!receipt.ok || receipt.value.kind !== 'debt-receipt') throw new Error('Authenticated debt receipt unavailable')
  expect(receipt.value.payload).toMatchObject({
    disposition: request.disposition,
    original: request.disposition.scope,
    sister: result.value.uw,
    parent: world.parent.scope,
    relation: 'original-blocked-by-sister',
  })
  const intent = bindExternalRef(receipt.value.payload.operation, own)
  if (!intent.ok || intent.value.kind !== 'cause-operation') throw new Error('Authenticated cause intent unavailable')
  const proposal = intent.value.payload.proposal
  if (proposal.operation !== 'create') throw new Error('Expected creation intent')
  expect(proposal.parentAcceptance?.exactInputs.proposed.coverage).toBeDefined()
  const assertConfirmedAssessment = () => {
    expect(decisions).toHaveLength(1)
    const consent = proposal.parentAcceptance
    if (consent === null) throw new Error('Composed parent consent unavailable')
    const parentHistory = parent.histories.find((history) => history.source.scope.target === world.parent?.scope.target)
    if (!parentHistory) throw new Error('Parent history unavailable')
    const control = bindExternalRef(acceptance.source, parentHistory)
    if (!control.ok || control.value.kind !== 'operator-control')
      throw new Error('Authenticated parent acceptance control unavailable')
    expect(acceptance.assessment).toEqual(consent.assessment)
    const assessment = bindExternalRef(consent.assessment, parentHistory)
    if (
      !assessment.ok ||
      assessment.value.kind !== 'action-receipt' ||
      assessment.value.payload.action !== 'assess-spec' ||
      assessment.value.payload.phase !== 'result'
    )
      throw new Error('Authenticated assessment result unavailable')
    expect(assessment.value.payload.admission).toBeNull()
    if (!assessment.value.payload.structured || !('classification' in assessment.value.payload.structured))
      throw new Error('Assessment did not produce a classification')
    expect(assessment.value.payload.structured.classification).toBe('material')
    expect(assessment.value.payload.exactInputs).toEqual(consent.exactInputs)
    const start = bindExternalRef(assessment.value.payload.start, parentHistory)
    expect(start.ok).toBe(true)
  }
  assertConfirmedAssessment()
  expect(intent.value.payload.confirmation.proposalDigest).toBe(intent.value.payload.proposalDigest)
  expect(receipt.ok).toBe(true)
  expect(recordsOf(own).filter((record) => record.kind === 'debt-receipt')).toHaveLength(1)
  expect(origin.admission.deliverable.ok).toBe(false)
  expect(origin.completion.waits.causeWaits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: 'required', receipt: result.receipt, target: result.value.uw }),
    ]),
  )
  expect(
    origin.completion.completions.get(`${request.disposition.scope.repository}\0${request.disposition.scope.target}`),
  ).toMatchObject({
    state: expect.not.stringMatching(/^complete$/),
  })
  expect(
    parent.completion.completions.get(`${world.parent.scope.repository}\0${world.parent.scope.target}`),
  ).toMatchObject({
    state: expect.not.stringMatching(/^complete$/),
  })
  await assertForeignMaterialIntent({
    proposal,
    parent,
    origin,
    operations: world.operations,
    childScope: result.value.uw,
    acceptance: acceptance.source,
  })
})

it('declining the composed decision creates no sister or parent acceptance', async () => {
  const { world, decisions, result } = await scenario(() => false)
  expect(result.status).toBe('partial')
  expect(decisions).toHaveLength(1)
  expect(world.issues.has(43)).toBe(false)
  if (world.parent === null) throw new Error('Expected active parent')
  const parent = await world.operations.readUw(world.parent.scope)
  expect(parent.accepted.status).toBe('accepted')
  if (parent.accepted.status !== 'accepted') throw new Error('Parent acceptance unavailable')
  expect(parent.accepted.value.ref.sourceAccepted).toEqual({
    scope: world.parent.scope,
    recordId: world.parent.mandate.recordId,
    kind: 'mandate',
  })
})

it.each(['origin-spec', 'source-history', 'parent-vector', 'child-tier', 'parent-graph'] as const)(
  'refuses a changed %s after assessment and confirmation before sister creation',
  async (change) => {
    const { world, result, decisions, request } = await scenario((current) => {
      const origin = current.issues.get(42)
      if (!origin) throw new Error('Origin missing')
      switch (change) {
        case 'origin-spec':
          origin.body += '\nUnconfirmed material edit'
          break
        case 'source-history': {
          const source = current.comments.get(44)?.[0]
          if (!source) throw new Error('Source history missing')
          source.body += '\nUnconfirmed source edit'
          break
        }
        case 'parent-vector': {
          const parent = current.issues.get(41)
          if (!parent) throw new Error('Parent missing')
          parent.body += '\nUnconfirmed parent Spec edit'
          break
        }
        case 'child-tier':
          origin.labels = ['size:F-lite']
          break
        case 'parent-graph':
          current.issues.set(45, {
            title: 'Unconfirmed child',
            body: '',
            labels: [],
            parent: 41,
            blockers: [],
            state: 'OPEN',
          })
      }
      return true
    })
    expect(decisions).toHaveLength(1)
    expect(result.status).toBe('partial')
    expect(world.issues.has(43)).toBe(false)
    const origin = await world.operations.readUw(request.disposition.scope)
    expect(origin.admission.deliverable.ok).toBe(false)
  },
)

it('holds the origin when the created sister parent readback no longer matches', async () => {
  const { world, request, result } = await scenario(
    () => true,
    (current) => {
      const sister = current.issues.get(43)
      if (!sister) throw new Error('Created sister missing')
      sister.parent = null
    },
  )
  expect(result.status).toBe('partial')
  expect(world.issues.has(43)).toBe(true)
  const origin = await world.operations.readUw(request.disposition.scope)
  const own = origin.histories.find((history) => history.source.scope.target === request.disposition.scope.target)
  if (!own) throw new Error('Origin history unavailable')
  expect(recordsOf(own).filter((record) => record.kind === 'debt-receipt')).toEqual([])
  expect(origin.admission.deliverable.ok).toBe(false)
})

it.each(['scope', 'version'] as const)(
  'refuses parent coverage with a different %s without creation or parent acceptance',
  async (changed) => {
    const { world, decisions, result } = await scenario(
      () => true,
      undefined,
      (request) => {
        if (request.parentCoverage == null) throw new Error('Expected explicit coverage')
        const parent = request.parentCoverage.parent
        return {
          ...request,
          parentCoverage: {
            ...request.parentCoverage,
            parent:
              changed === 'scope'
                ? { ...parent, uw: { repository: parent.uw.repository, target: 'acme/app#99' } }
                : { ...parent, version: parent.version === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64) },
          },
        }
      },
    )
    expect(result.status).toBe('refused')
    expect(decisions).toEqual([])
    expect(world.issues.has(43)).toBe(false)
    if (world.parent === null) throw new Error('Expected active parent')
    const parent = await world.operations.readUw(world.parent.scope)
    expect(parent.accepted.status).toBe('accepted')
    if (parent.accepted.status !== 'accepted') throw new Error('Parent acceptance unavailable')
    expect(parent.accepted.value.ref.sourceAccepted).toEqual({
      scope: world.parent.scope,
      recordId: world.parent.mandate.recordId,
      kind: 'mandate',
    })
    const history = parent.histories.find((entry) => entry.source.scope.target === world.parent?.scope.target)
    if (!history) throw new Error('Parent history unavailable')
    expect(recordsOf(history).filter((record) => record.kind === 'operator-control')).toEqual([])
  },
)

async function assertForeignMaterialIntent(context: {
  proposal: CauseCreationProposal
  parent: UwRead
  origin: UwRead
  operations: UwOperations
  childScope: Scope
  acceptance: ExternalRecordRef
}): Promise<void> {
  const { proposal, parent, origin, operations, childScope, acceptance } = context
  const consent = proposal.parentAcceptance
  if (!consent) throw new Error('Expected confirmed parent consent')
  const parentHistory = parent.histories.find((history) => history.source.scope.target === parent.uw.target)
  if (!parentHistory) throw new Error('Expected parent history')
  const control = bindExternalRef(acceptance, parentHistory)
  if (!control.ok || control.value.kind !== 'operator-control' || control.value.payload.control !== 'accept-material')
    throw new Error('Expected authenticated material control')
  const authorization = control.value.payload.authorization
  if (authorization.kind !== 'cause-creation') throw new Error('Expected composed creation authorization')
  const child = await operations.readUw(childScope)
  const histories = [
    ...new Map(
      [...origin.histories, ...parent.histories, ...child.histories].map((history) => [
        `${history.source.scope.repository}\0${history.source.scope.target}`,
        history,
      ]),
    ).values(),
  ]
  const childHistory = histories.find((history) => history.source.scope.target === childScope.target)
  if (!childHistory) throw new Error('Expected created child identity history')
  const identity = childHistory.operations.find((entry) => entry.recordId === authorization.binding.identity.recordId)
  if (!identity || identity.parts.length === 0) throw new Error('Expected authenticated child identity parts')
  const material = {
    format: 'omp-build-material-acceptance/2' as const,
    operationId: consent.parentOperationId,
    uw: consent.parent,
    mandate: consent.mandate,
    predecessor: consent.predecessor,
    assessment: consent.assessment,
    classification: 'material' as const,
    exactInputs: consent.exactInputs,
  }
  const input = { proposal: material, authorization, confirmation: control.value.payload.confirmation, histories }
  expect(readComposedMaterialIntent(input)).toMatchObject({
    ok: true,
    value: { identity: { recordId: authorization.binding.identity.recordId } },
  })
  const identityParts = new Set(identity.parts.map((part) => part.locator))
  const missing = decodeHistory({
    ...childHistory.source,
    comments: childHistory.source.comments.filter((part) => !identityParts.has(part.locator)),
  })
  expect(
    readComposedMaterialIntent({
      ...input,
      histories: histories.map((history) => (history === childHistory ? missing : history)),
    }).ok,
  ).toBe(false)
  const copies = identity.parts.map((part, index) => ({
    ...part,
    locator: `foreign-identity-${index}`,
    nativeId: `foreign-identity-${index}`,
    author: 'intruder',
  }))
  const foreign = decodeHistory({ ...childHistory.source, comments: [...childHistory.source.comments, ...copies] })
  expect(foreign.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'spec-identity', authority: 'foreign' }),
      expect.objectContaining({
        kind: 'spec-identity',
        recordId: authorization.binding.identity.recordId,
        authority: 'accounted',
      }),
    ]),
  )
  expect(
    readComposedMaterialIntent({
      ...input,
      histories: histories.map((history) => (history === childHistory ? foreign : history)),
    }),
  ).toMatchObject({ ok: true, value: { identity: { recordId: authorization.binding.identity.recordId } } })
}
