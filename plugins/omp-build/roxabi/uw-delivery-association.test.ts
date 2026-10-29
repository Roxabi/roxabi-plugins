import { expect, it } from 'vitest'
import { criterionDeclarationSchema } from '../engine/criterion-evidence-schema.ts'
import { FINDING_TARGET_FORMAT } from '../engine/finding-target-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { bindExternalRef } from '../engine/workflow-control.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { fixture } from '../testing/uw-operations-fixture.ts'
import { collectDeclarations } from './uw-delivery-collect.ts'
import { readUwDelivery, type UwDeliveryReadPorts } from './uw-delivery-read.ts'
import { readDeliveryHistories } from './uw-input-linked.ts'

const UW42: Scope = { repository: 'acme/app', target: 'acme/app#42' }
const UW99: Scope = { repository: 'acme/app', target: 'acme/app#99' }
const PR77: Scope = { repository: 'other/repo', target: 'other/repo#77' }
const TIP = 'a'.repeat(40)
const fixtures = roxabiWorkflowFixtures()
const mandate = fixtures.featureMandate(UW99, { branch: 'feature/other', base: 'main' })
const binding = fixtures.workflowBinding(PR77, mandate, 'feature/other', 'main')
const start = fixtures.implementStart(mandate)
const mandateHistory = fixtures.historyFrom([mandate, start], 'operator')

function foreignReceipt(): CanonicalRecord {
  const base = fixtures.rejectedImplementResult(mandate)
  if (base.payload.action !== 'implement' || base.payload.phase !== 'result' || base.payload.admission === null) {
    throw new Error('expected an implement result')
  }
  const built = buildRecord({
    version: 1,
    recordId: 'pr77-receipt',
    runId: base.runId,
    operationId: 'op-pr77-receipt',
    repository: PR77.repository,
    target: PR77.target,
    kind: 'action-receipt',
    payload: {
      ...base.payload,
      admission: { ...base.payload.admission, admitted: true, remoteTip: TIP, commits: [TIP] },
      structured: {
        outcome: 'implemented',
        commitSHAs: [TIP],
        commands: base.payload.structured?.commands ?? [],
        criteria: [
          criterionDeclarationSchema.parse({
            target: {
              format: FINDING_TARGET_FORMAT,
              kind: 'criterion',
              id: 'C1',
              spec: {
                uw: UW99,
                version: mandate.payload.ownSpec.version,
                sourceAccepted: { scope: UW99, recordId: mandate.recordId, kind: 'mandate' },
              },
            },
            verification: 'unverified',
            reason: 'observed on another UW',
          }),
        ],
        reason: 'foreign delivery',
      },
    },
  })
  if (!built.ok) throw new Error(built.diagnostics.map((item) => item.message).join('; '))
  return built.value
}

const receipt = foreignReceipt()
const receiptHistory = fixtures.historyFrom([receipt], 'operator', 'operator', [mandateHistory])
const bindingBodies = fixtures.framedBodies([binding, receipt], 'operator', [mandateHistory])
const mandateBodies = fixtures.framedBodies([mandate, start], 'operator')

function comment(id: number, body: string) {
  return {
    id,
    body,
    user: { login: 'operator' },
    created_at: '2026-10-21T12:00:00Z',
    updated_at: '2026-10-21T12:00:00Z',
  }
}

function commentsFor(args: readonly string[]): unknown[] {
  const url = args.find((item) => item.includes('/comments')) ?? ''
  if (url.includes('repos/other/repo/issues/77/comments')) {
    return bindingBodies.map((body, index) => comment(index + 1, body))
  }
  if (url.includes('repos/acme/app/issues/99/comments')) {
    return mandateBodies.map((body, index) => comment(index + 1, body))
  }
  return []
}

function completePulls() {
  return {
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 77,
              headRefName: 'feature/other',
              baseRefName: 'main',
              repository: { nameWithOwner: PR77.repository },
            },
          ],
        },
      },
    },
  }
}

const calls: string[] = []
function gh(payload: unknown, pulls?: unknown, extraComments: unknown[] = [], extraMandateComments: unknown[] = []) {
  return async (_cwd: string, args: string[]) => {
    calls.push(args.join(' '))
    const query = args.find((item) => item.startsWith('query='))?.slice('query='.length) ?? ''
    if (query.includes('pullRequests') && pulls !== undefined) return JSON.stringify(pulls)
    if (args.some((item) => item.includes('/comments'))) {
      const extra = args.some((item) => item.includes('repos/other/repo/issues/77/comments'))
        ? extraComments
        : args.some((item) => item.includes('repos/acme/app/issues/99/comments'))
          ? extraMandateComments
          : []
      return JSON.stringify([...commentsFor(args), ...extra])
    }
    return JSON.stringify(payload)
  }
}

function ports(
  timeline: unknown,
  pulls?: unknown,
  extraComments: unknown[] = [],
  extraMandateComments: unknown[] = [],
): UwDeliveryReadPorts {
  const readUw = fixture().operations.readUw
  return {
    readUw,
    readDeliveryHistories: (uw) =>
      readDeliveryHistories(uw, {
        cwd: '/tmp',
        gh: gh(timeline, pulls, extraComments, extraMandateComments),
        readAuthor: 'operator',
      }),
  }
}

it('keeps a PR bound to another UW out of this delivery and does not rewrite its repository', async () => {
  calls.splice(0)
  const decoded = receiptHistory.operations.find((item) => item.record?.recordId === 'pr77-receipt')?.record
  expect(decoded?.repository).toBe(PR77.repository)
  expect(decoded?.target).toBe(PR77.target)
  const skipped = collectDeclarations(UW42, [receiptHistory], [])
  expect(skipped.map((item) => item.receipt.record.recordId)).not.toContain('pr77-receipt')
  const stamped = collectDeclarations(UW99, [receiptHistory], [])
  expect(stamped.map((item) => item.receipt.record.scope)).toContainEqual(PR77)
  const read = await readUwDelivery(UW42, ports({ data: null }, completePulls()))
  expect(read.ok).toBe(true)
  if (!read.ok) return
  expect(read.value.declarations.map((item) => item.receipt.record.recordId)).not.toContain('pr77-receipt')
  expect(calls.some((item) => item.includes('repos/other/repo/issues/77/comments'))).toBe(true)
  expect(calls.some((item) => item.includes('repos/acme/app/issues/77'))).toBe(false)
  expect(calls.some((item) => item.includes('repos/acme/app/issues/99/comments'))).toBe(true)
})

it('ignores foreign binding and mandate identity collisions on an unrelated enumerated PR', async () => {
  const foreign = (id: number, body: string) => ({ ...comment(id, body), user: { login: 'foreign' } })
  const bindingNoise = bindingBodies.map((body, index) => foreign(100 + index, body))
  const mandateNoise = mandateBodies.map((body, index) => foreign(200 + index, body))
  const read = await readUwDelivery(UW42, ports({ data: null }, completePulls(), bindingNoise, mandateNoise))
  expect(read.ok).toBe(true)
  if (!read.ok) return
  expect(read.value.declarations.map((item) => item.receipt.record.recordId)).not.toContain('pr77-receipt')
})

it('refuses an unresolved expected-author binding on an unrelated enumerated PR', async () => {
  const malformed = '<!-- omp-build-record v=1 kind=workflow-binding id=bad operationId=bad-op part=1/2 data=e30 -->'
  const read = await readUwDelivery(UW42, ports({ data: null }, completePulls(), [comment(100, malformed)]))
  expect(read.ok).toBe(false)
})

it('binds an authenticated mandate reference despite a foreign record and operation identity collision', () => {
  if (binding.kind !== 'workflow-binding') throw new Error('fixture requires a binding')
  const foreign = fixtures.historyFrom([mandate], 'stranger', 'operator')
  const collision = foreign.operations.find((operation) => operation.recordId === mandate.recordId)
  if (collision === undefined) throw new Error('fixture requires a foreign mandate observation')
  const noisy = { ...mandateHistory, operations: [...mandateHistory.operations, collision] }
  expect(bindExternalRef(binding.payload.mandate, noisy)).toMatchObject({
    ok: true,
    value: { recordId: mandate.recordId },
  })
  expect(bindExternalRef(binding.payload.mandate, foreign)).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: 'foreign' })],
  })
})

it('refuses an incomplete, malformed, or paginated enumeration instead of succeeding empty', async () => {
  const cases = [
    {
      data: {
        repository: {
          pullRequests: { pageInfo: { hasNextPage: true, endCursor: 'cursor-2' }, nodes: [] },
        },
      },
    },
    { data: null, errors: [{ message: 'malformed timeline' }] },
    { data: { repository: { pullRequests: null } } },
    {
      data: {
        repository: {
          pullRequests: { nodes: [null], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
    {
      data: {
        repository: {
          pullRequests: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
        },
      },
    },
  ]
  for (const timeline of cases) {
    const read = await readUwDelivery(UW42, ports(timeline))
    expect(read.ok).toBe(false)
  }
})
