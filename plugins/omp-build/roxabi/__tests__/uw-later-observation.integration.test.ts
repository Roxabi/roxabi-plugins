import { expect, it } from 'vitest'
import { readGitHubHistory } from '../../adapters/github/transport.ts'
import { assessUwAdmission } from '../../dist/contracts.js'
import { scopeKey } from '../../engine/uw-graph.ts'
import { installedMultiSisterFixture } from '../../testing/multi-sister-installed-fixture.ts'
import { deliverCreatedSister } from '../../testing/sister-delivery-fixture.ts'
import { readFeatureObservation } from '../feature-continuation-observation.ts'
import type { SelectedFeature } from '../feature-continuation-selection.ts'
import { loadContracts } from '../feature-engine.ts'
import type { UwRead } from '../uw-contract.ts'
import { readCurrentOwnSpecFacts } from '../uw-current-facts.ts'
import { createInstalledUwReadPort } from '../uw-read-port.ts'

async function deliveryCheck(read: UwRead) {
  if (!read.identity.ok) return read.admission.deliverable
  const facts = await readCurrentOwnSpecFacts({ uw: read.uw, read })
  const currentChildren = facts.ok
    ? {
        ok: true as const,
        value: facts.value.currentSpec.children.map(({ scope, specVersion, tier }) => ({ scope, specVersion, tier })),
      }
    : { ok: false as const, diagnostics: facts.diagnostics }
  return assessUwAdmission({
    uw: read.uw,
    graph: read.graph,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    histories: read.histories,
    catalogues: read.catalogues,
    completion: read.completion,
    phase: 'delivery-transition',
    currentChildren,
  }).deliverable
}

it.each(['reopened', 'not-planned', 'missing-identity'] as const)(
  'a later full UW observation recomputes a delivered sister %s without changing the original root',
  async (change) => {
    const world = await installedMultiSisterFixture(1)
    const created = await world.operations.createSister(world.request(0))
    expect(created.status, JSON.stringify(created)).toBe('created')
    const sister = world.issues.get(43)
    if (!sister) throw new Error('created sister is missing')
    sister.state = 'CLOSED'
    sister.stateReason = 'COMPLETED'
    const reader = createInstalledUwReadPort({ cwd: '/fixture', gh: world.gh, readAuthor: 'automation' })
    const closedOnly = await reader.readUw(world.context.original)
    expect(
      closedOnly.completion.completions.get(scopeKey({ repository: 'acme/app', target: 'acme/app#43' }))?.state,
    ).not.toBe('complete')
    expect((await deliveryCheck(closedOnly)).ok).toBe(false)
    sister.state = 'OPEN'
    sister.stateReason = null
    const delivered = await deliverCreatedSister(world)
    sister.state = 'CLOSED'
    sister.stateReason = 'COMPLETED'
    const before = await reader.readUw(world.context.original)
    expect(before.completion.completions.get(scopeKey(delivered.scope))).toMatchObject({ state: 'complete' })
    const previousCheck = await deliveryCheck(before)
    expect(previousCheck.ok, JSON.stringify(previousCheck)).toBe(true)
    const original = await readGitHubHistory(world.context.original, {
      cwd: '/fixture',
      gh: world.gh,
      readAuthor: 'automation',
    })
    if (!original.complete) throw new Error('original history incomplete')
    if (before.accepted.status !== 'accepted') throw new Error('original accepted Spec unavailable')
    const engine = await loadContracts()
    if ('missing' in engine) throw new Error(`missing engine: ${engine.missing}`)
    const primary = before.histories.find((history) => history.source.scope.target === 'acme/app#42')
    if (!primary) throw new Error('original causal history missing')
    if (before.observation.status !== 'complete') throw new Error('Expected complete before observation')
    const causal = { histories: before.histories, catalogues: before.catalogues, observation: before.observation }
    const gh = async (cwd: string, args: string[]) =>
      args[0] === 'pr' && args[1] === 'list' ? '[]' : world.gh(cwd, args)
    const selected: SelectedFeature = {
      authority: {
        context: {
          cwd: '/fixture',
          gh,
          git: async () => {
            throw new Error('unexpected git request')
          },
          engine,
        },
        identity: { ok: false, reason: 'no-session' },
        onPrincipal: true,
        target: {
          status: 'issue',
          scope: world.context.original,
          issue: {
            repository: 'acme/app',
            number: 42,
            state: 'OPEN',
            author: 'automation',
            body: world.body,
            isPullRequest: false,
          },
        },
        scope: world.context.original,
        history: primary,
        parentHistories: [],
        causal,
        selection: engine.selectApplicableMandate(primary, [], causal),
      },
      number: 42,
      reader,
      uwRead: before,
      mandate: world.mandate,
      acceptedSpec: before.accepted.value,
      mandateRef: { scope: world.context.original, kind: 'mandate', recordId: world.mandate.recordId },
      issue: { title: 'Original', body: world.body, labels: ['size:S'], updatedAt: '2026-10-27T12:00:00Z' },
      firstMandateEstablished: false,
    }
    if (change === 'reopened') {
      sister.state = 'OPEN'
      sister.stateReason = 'REOPENED'
    } else if (change === 'not-planned') {
      sister.state = 'CLOSED'
      sister.stateReason = 'NOT_PLANNED'
    } else world.comments.set(43, [])
    const after = await reader.readUw(world.context.original)
    const current = await readGitHubHistory(world.context.original, {
      cwd: '/fixture',
      gh: world.gh,
      readAuthor: 'automation',
    })
    expect(current).toEqual(original)
    const result = await deliveryCheck(after)
    expect(result.ok, JSON.stringify(result)).toBe(change === 'reopened')
    if (change !== 'missing-identity')
      expect(after.completion.completions.get(scopeKey(delivered.scope))).toMatchObject({ state: 'complete' })
    if (change === 'reopened') return
    const feature = await readFeatureObservation('continue', selected)
    const assertBlockedFeature = () => {
      if ('kind' in feature) {
        expect(feature.kind).toBe('blocked')
      } else {
        expect(feature.deliveryAdmission).not.toBeNull()
        if (feature.deliveryAdmission === null) throw new Error('missing final delivery admission')
        const diagnostics =
          'diagnostics' in feature.deliveryAdmission
            ? feature.deliveryAdmission.diagnostics
            : feature.deliveryAdmission.admission.deliverable.diagnostics
        expect(diagnostics.length).toBeGreaterThan(0)
      }
    }
    assertBlockedFeature()
  },
)
