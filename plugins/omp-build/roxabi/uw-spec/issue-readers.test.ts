import { describe, expect, it } from 'vitest'
import { readEpicInputSpec, readReviewIssueSpec } from './issue-readers.ts'

const repository = 'acme/app'
const target = 'acme/app#7'
const body = '## Acceptance Criteria\n- Preserve issue date projection'

type IssuePayload = {
  body: string
  state: string
  labels: unknown[]
  updatedAt?: unknown
}

function issueGh(payload: IssuePayload) {
  return async (_cwd: string, args: string[]): Promise<string> => {
    expect(args).toEqual(['issue', 'view', '7', '--repo', repository, '--json', 'body,updatedAt,state,labels'])
    return JSON.stringify(payload)
  }
}

describe('UW Spec issue reader date profiles', () => {
  it.each([
    ['missing', undefined],
    ['numeric', 7],
  ])(
    'normalizes an Epic input %s updatedAt to null while the strict review profile refuses it',
    async (_name, updatedAt) => {
      const payload: IssuePayload = { body, state: 'OPEN', labels: [] }
      if (updatedAt !== undefined) payload.updatedAt = updatedAt
      const gh = issueGh(payload)

      await expect(readEpicInputSpec('/fixture', repository, target, 7, gh)).resolves.toMatchObject({
        lastEditedAt: null,
      })
      await expect(readReviewIssueSpec('/fixture', repository, 7, gh)).resolves.toEqual({
        ok: false,
        diagnostics: [{ code: 'tracker-issue-unreadable', message: 'tracker issue #7 is unreadable' }],
      })
    },
  )

  it.each([
    ['timestamp', '2026-10-27T12:00:00Z'],
    ['null', null],
  ])('preserves a valid Epic input %s updatedAt and accepts it for review', async (_name, updatedAt) => {
    const gh = issueGh({ body, state: 'CLOSED', labels: [{ name: 'size:F-lite' }], updatedAt })

    await expect(readEpicInputSpec('/fixture', repository, target, 7, gh)).resolves.toMatchObject({
      lastEditedAt: updatedAt,
    })
    await expect(readReviewIssueSpec('/fixture', repository, 7, gh)).resolves.toMatchObject({
      ok: true,
      value: { lastEditedAt: updatedAt, labels: ['size:F-lite'] },
    })
  })
})
