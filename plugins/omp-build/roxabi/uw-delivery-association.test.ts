import { expect, it } from 'vitest'
import { createUwDeliveryFactReader } from '../adapters/github-workflow/uw-delivery-facts.ts'
import { criterionDeclarationSchema } from '../engine/criterion-evidence-schema.ts'
import { FINDING_TARGET_FORMAT } from '../engine/finding-target-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { bindExternalRef } from '../engine/workflow-control.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'

const UW42: Scope = { repository: 'other/repo', target: 'other/repo#42' }
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

function readFacts(
  timeline: unknown,
  pulls?: unknown,
  extraComments: unknown[] = [],
  extraMandateComments: unknown[] = [],
) {
  return createUwDeliveryFactReader({
    cwd: '/tmp',
    gh: gh(timeline, pulls, extraComments, extraMandateComments),
    readAuthor: 'operator',
  }).read(UW42, [])
}

it('keeps a PR bound to another UW out of this delivery and does not rewrite its repository', async () => {
  calls.splice(0)
  const decoded = receiptHistory.operations.find((item) => item.record?.recordId === 'pr77-receipt')?.record
  expect(decoded?.repository).toBe(PR77.repository)
  expect(decoded?.target).toBe(PR77.target)
  const read = await readFacts({ data: null }, completePulls())
  expect(read.ok).toBe(true)
  if (!read.ok) return
  expect(read.value.facts.pullRequests).toEqual([])
  expect(calls.some((item) => item.includes('repos/other/repo/issues/77/comments'))).toBe(true)
  expect(calls.some((item) => item.includes('repos/acme/app/issues/77'))).toBe(false)
  expect(calls.some((item) => item.includes('repos/acme/app/issues/99/comments'))).toBe(true)
})

it('ignores foreign binding and mandate identity collisions on an unrelated enumerated PR', async () => {
  const foreign = (id: number, body: string) => ({ ...comment(id, body), user: { login: 'foreign' } })
  const bindingNoise = bindingBodies.map((body, index) => foreign(100 + index, body))
  const mandateNoise = mandateBodies.map((body, index) => foreign(200 + index, body))
  const read = await readFacts({ data: null }, completePulls(), bindingNoise, mandateNoise)
  expect(read.ok).toBe(true)
  if (!read.ok) return
  expect(read.value.facts.pullRequests).toEqual([])
})

it('refuses an unresolved expected-author binding on an unrelated enumerated PR', async () => {
  const malformed = '<!-- omp-build-record v=1 kind=workflow-binding id=bad operationId=bad-op part=1/2 data=e30 -->'
  const read = await readFacts({ data: null }, completePulls(), [comment(100, malformed)])
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
    const read = await readFacts(timeline)
    expect(read.ok).toBe(false)
  }
})

it('refuses noncanonical repository spelling rather than treating a binding as absent', async () => {
  const page = completePulls()
  const first = page.data.repository.pullRequests.nodes[0]
  if (!first) throw new Error('Expected pull request')
  first.repository.nameWithOwner = 'Other/Repo'
  const result = await readFacts({}, page)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics[0]?.message).toContain('canonical')
})

it('refuses conflicting duplicate pull-request identities before binding selection', async () => {
  const page = completePulls()
  const first = page.data.repository.pullRequests.nodes[0]
  if (!first) throw new Error('Expected pull request')
  page.data.repository.pullRequests.nodes.push({ ...first, headRefName: 'different-branch' })
  const result = await readFacts({}, page)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics[0]?.message).toContain('Conflicting')
})

it('enumerates repository pull requests once per observation across multiple UW reads', async () => {
  let pages = 0
  const reader = createUwDeliveryFactReader({
    cwd: '/tmp',
    readAuthor: 'operator',
    gh: async () => {
      pages += 1
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
    },
  })
  const first = await reader.read(UW42, [])
  const second = await reader.read({ repository: 'other/repo', target: 'other/repo#43' }, [])
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  expect(pages).toBe(1)
})
