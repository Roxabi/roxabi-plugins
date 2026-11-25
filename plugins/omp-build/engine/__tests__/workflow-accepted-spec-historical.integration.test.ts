import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'
import { readComposedWorkflowHistory, resolveAcceptedSpec } from '../../contracts.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import {
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { history, SCOPE } from './workflow-test-support.ts'

const OTHER = { ...SCOPE, target: `${SCOPE.repository}#43` }

const cases = [
  ['intact', null],
  ['damaged', 'Workflow history is not confirmed'],
  ['edited', 'Workflow history is not confirmed'],
  ['wrong-scope', 'Spec assessment start is unresolved'],
] as const

test.each(cases)('historical Accepted Spec authenticates native assessment evidence: %s', async (variant, refusal) => {
  const git = nativeImplementationGit()
  try {
    const head = git.heads[0]
    if (head === undefined) throw new Error('Expected a historical Git commit')
    const committedWording = execFileSync('git', ['-C', git.cwd, 'show', `${head}:fixture.txt`], {
      encoding: 'utf8',
    }).trim()
    const mandate = shippedFeatureMandate()
    const accepted = mandateAssessmentState(mandate)
    const proposed = proposedAssessmentState(accepted, { body: `Retain ${committedWording} in historical evidence` })
    const assessment = assessFixture(
      mandate,
      'historical-editorial',
      accepted,
      proposed,
      'editorial',
      [history([mandate])],
      undefined,
      undefined,
      { repository: SCOPE.repository, base: git.p0, head, referenceCommit: head },
    )
    const recorded = history([mandate, assessment.start, assessment.result])
    const startParts = recorded.operations.find((operation) => operation.recordId === assessment.start.recordId)?.parts
    if (!startParts?.length) throw new Error('Expected native parts for the historical assessment START')
    const startIds = new Set(startParts.map((part) => part.nativeId))
    const ownComments = recorded.source.comments.flatMap((comment) => {
      if (!startIds.has(comment.nativeId)) return [comment]
      if (variant === 'wrong-scope') return []
      if (variant === 'damaged') return [{ ...comment, body: comment.body.replace(/ data=[\w-]+ /, ' data=e30 ') }]
      if (variant === 'edited') return [{ ...comment, updatedAt: '2026-10-22T00:00:00Z' }]
      return [comment]
    })
    const observed = await readComposedWorkflowHistory([SCOPE, OTHER], {
      cwd: git.cwd,
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        const match = /^repos\/acme\/app\/issues\/(42|43)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] ?? '')
        if (args[0] !== 'api' || match === null) throw new Error(`Unexpected GitHub request: ${args.join(' ')}`)
        const comments = match[1] === '42' ? ownComments : variant === 'wrong-scope' ? startParts : []
        const offset = (Number(match[2]) - 1) * 100
        return JSON.stringify(
          comments.slice(offset, offset + 100).map((comment) => ({
            id: Number(comment.nativeId),
            body: comment.body,
            user: { login: comment.author },
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
          })),
        )
      },
    })
    const resolved = resolveAcceptedSpec(mandate, observed.histories)
    if (refusal !== null) {
      expect(resolved).toMatchObject({ ok: false, evidence: [{ code: 'unconfirmed', message: refusal }] })
      if (variant === 'wrong-scope') {
        const misplaced = observed.histories.find((entry) => entry.source.scope.target === OTHER.target)
        expect(misplaced?.diagnostics).toContainEqual(expect.objectContaining({ code: 'header-metadata-mismatch' }))
      }
      if (variant === 'edited') {
        const home = observed.histories.find((entry) => entry.source.scope.target === SCOPE.target)
        expect(home?.diagnostics).toContainEqual(expect.objectContaining({ code: 'record-edited' }))
      }
      return
    }
    expect(observed.ok).toBe(true)
    expect(resolved).toMatchObject({
      ok: true,
      spec: {
        snapshot: proposed.snapshot,
        ref: {
          uw: SCOPE,
          version: assessment.currentVersion,
          sourceAccepted: { scope: SCOPE, kind: 'action-receipt', recordId: assessment.result.recordId },
        },
      },
    })
  } finally {
    git.cleanup()
  }
})
