import type { History } from '../../engine/history-schema.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { ObservedComment } from '../../engine/review-schema.ts'
import { buildFixOnlyMandate } from '../../engine/workflow-correction-mandate.ts'
import { githubScope } from '../github/transport.ts'
import type { Gh } from '../github/types.ts'

export const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const BASE_TIP = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

export function comment(body: string, author = 'automation', nativeId = '100'): ObservedComment {
  return {
    locator: `acme/app#42:comment:${nativeId}`,
    nativeId,
    body,
    author,
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:00:01Z',
  }
}

export function framed(kind: string, operationId: string, recordId: string): string {
  const record = {
    repository: 'acme/app',
    target: 'acme/app#42',
    version: 1,
    recordId,
    runId: 'run-1',
    operationId,
    inputs: [],
    kind,
    payload:
      kind === 'stop'
        ? { reason: 'ci-failed', reviewId: 'review-1', detail: {} }
        : kind === 'epic-event'
          ? { outcome: 'verified' }
          : { retained: true },
  }
  return `<!-- omp-build-record v=1 kind=${kind} id=${recordId} operationId=${operationId} part=1/1 data=${Buffer.from(JSON.stringify(record)).toString('base64url')} -->\n# ${kind}`
}

export function historyFrom(body: string, author = 'automation', stopAuthor: string | null = null): History {
  return {
    scope: githubScope('acme/app', 42),
    expectedAuthor: 'automation',
    stopAuthor,
    complete: true,
    comments: [comment(body, author)],
    diagnostics: [],
  }
}

export function prView(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    state: 'OPEN',
    headRefOid: HEAD,
    headRefName: 'feat/7-work',
    baseRefName: 'main',
    baseRefOid: BASE_TIP,
    author: { login: 'operator' },
    ...overrides,
  })
}

export function mustRecord(
  result: { ok: true; value: CanonicalRecord } | { ok: false; diagnostics: { code: string }[] },
): CanonicalRecord {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}

export function wire(record: CanonicalRecord): string {
  return `<!-- omp-build-record v=1 kind=${record.kind} id=${record.recordId} operationId=${record.operationId} part=1/1 data=${Buffer.from(JSON.stringify(record)).toString('base64url')} -->\n# ${record.kind}`
}

export function issueMandate(
  scope: Scope,
  recordId = 'mandate-1',
  parent: CanonicalRecord | null = null,
): CanonicalRecord {
  return mustRecord(
    buildFixOnlyMandate({
      scope,
      recordId,
      runId: 'run-1',
      operationId: `op-${recordId}`,
      branch: 'feat/7-work',
      base: 'main',
      lineageHead: null,
      productVersion: '0.11.0',
      work: { reference: scope.target, body: 'live linked issue body', lastEditedAt: '2026-10-21T00:00:00Z' },
      config: {
        version: 'catalogue-1',
        digest: 'a'.repeat(64),
        effective: {
          graph: {
            version: 1,
            productVersion: '0.11.0',
            configVersion: 'catalogue-1',
            edgeOrder: 'array',
            nodes: [
              { id: 'frame', action: 'frame' },
              { id: 'land', action: 'land' },
            ],
            edges: [{ from: 'frame', to: 'land', when: 'always' }],
            initial: 'land',
          },
        },
      },
      proofPins: [],
      parent:
        parent === null
          ? null
          : {
              scope: { repository: parent.repository, target: parent.target },
              recordId: parent.recordId,
              kind: 'mandate',
            },
      antecedent: null,
    }),
  )
}

export function bindingRecord(mandate: CanonicalRecord): CanonicalRecord {
  return mustRecord(
    parseRecord({
      repository: 'acme/app',
      target: 'acme/app#42',
      version: 1,
      recordId: 'bind-1',
      runId: 'run-1',
      operationId: 'op-bind-1',
      inputs: [],
      kind: 'workflow-binding',
      payload: {
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          recordId: mandate.recordId,
          kind: 'mandate',
        },
        branch: 'feat/7-work',
        base: 'main',
      },
    }),
  )
}

export function nativeComment(id: number, body: string) {
  return {
    id,
    body,
    user: { login: 'automation' },
    created_at: '2026-10-21T00:00:00Z',
    updated_at: '2026-10-21T00:00:01Z',
  }
}

export function closingGraphql(nodes: Array<{ number: number }>, totalCount = nodes.length): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefName: 'feat/7-work',
          baseRefName: 'main',
          headRefOid: HEAD,
          baseRefOid: BASE_TIP,
          closingIssuesReferences: { totalCount, nodes },
        },
      },
    },
  })
}

export function fakeGh(handlers: Array<(args: string[]) => string | undefined>): Gh {
  return async (_cwd, args) => {
    for (const handler of handlers) {
      const value = handler(args)
      if (value !== undefined) return value
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`)
  }
}
