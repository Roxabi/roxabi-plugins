import { describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { fixtureCausal } from '../../testing/action-input-fixtures.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { resolveBoundWork } from '../workflow-bound-work-resolution.ts'
import { selectWorkflowBinding } from '../workflow-pr-binding.ts'
import { binding, featureMandate, history, must, SCOPE } from './workflow-test-support.ts'

describe('workflow bound work behavior', () => {
  test('records-only standalone review refuses missing or conflicting binding evidence', () => {
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const empty = history([], pr)
    const native = { branch: 'feature/bounded', base: 'main' }
    const input = { use: 'review' as const, explicitSelection: true, pullRequest: pr, native }
    const causal = fixtureCausal([empty])
    expect(resolveBoundWork({ ...input, histories: [empty], causal })).toEqual({
      status: 'standalone',
      binding: 'absent',
    })
    expect(selectWorkflowBinding({ pullRequest: pr, histories: [empty], native })).toEqual({ status: 'absent' })
    expect(
      resolveBoundWork({
        ...input,
        histories: [empty],
        causal: { ...causal, histories: [empty, empty] },
      }),
    ).toMatchObject({ status: 'refused', reason: 'incomplete' })
    const incomplete = { ...empty, source: { ...empty.source, complete: false } }
    expect(
      resolveBoundWork({
        ...input,
        histories: [incomplete],
        causal: fixtureCausal([incomplete]),
      }),
    ).toMatchObject({ status: 'refused', reason: 'incomplete' })
    const bound = history([binding(featureMandate(), pr)], pr)
    const foreign = decodeHistory({
      ...bound.source,
      comments: bound.source.comments.map((comment) => ({ ...comment, author: 'stranger' })),
    })
    expect(
      resolveBoundWork({
        ...input,
        histories: [foreign],
        causal: fixtureCausal([foreign]),
      }),
    ).toMatchObject({ status: 'refused', reason: 'incomplete' })
    expect(selectWorkflowBinding({ pullRequest: pr, histories: [foreign], native }).status).not.toBe('absent')
    const original = bound.source.comments[0]
    if (original === undefined) throw new Error('expected a native binding comment')
    for (const body of [
      '<!-- omp-build-record v=1 kind=workflow-binding id=broken operationId=broken part=1/2 data=abcd -->\npartial',
      '<!-- omp-build-record v=1 kind=workflow-binding id=broken operationId=broken part=1/1 data=! -->\nmalformed',
    ]) {
      const damaged = decodeHistory({ ...bound.source, comments: [{ ...original, body }] })
      expect(selectWorkflowBinding({ pullRequest: pr, histories: [damaged], native }).status).not.toBe('absent')
      expect(
        resolveBoundWork({
          ...input,
          histories: [damaged],
          causal: fixtureCausal([damaged]),
        }),
      ).toMatchObject({ status: 'refused' })
    }
    const selected = [history([featureMandate()]), bound]
    expect(
      resolveBoundWork({
        ...input,
        histories: selected,
        causal: fixtureCausal(selected),
      }),
    ).toMatchObject({ status: 'refused', reason: 'incomplete' })
  })
  test('binding ignores foreign successor controls but refuses incomplete expected-author controls', () => {
    const mandated = featureMandate()
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const predecessor = { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' as const }
    const successor = { scope: SCOPE, recordId: 'other-mandate', kind: 'mandate' as const }
    const built = buildRecord({
      version: 1,
      ...SCOPE,
      recordId: 'foreign-select',
      runId: 'run-1',
      operationId: 'op-foreign-select',
      kind: 'operator-control',
      payload: { control: 'select-successor', controlId: 'foreign-select', mandate: successor, predecessor, successor },
    })
    if (!built.ok) throw new Error('fixture requires successor control')
    const control = history([built.value])
    const home = history([mandated])
    const prHistory = history([binding(mandated, pr)], pr)
    const input = {
      pullRequest: pr,
      native: { branch: 'feature/bounded', base: 'main' },
      histories: [home, prHistory],
    }
    const foreign = decodeHistory({
      ...home.source,
      comments: [
        ...home.source.comments,
        ...control.source.comments.map((comment, index) => ({
          ...comment,
          locator: `${SCOPE.target}:comment:${1001 + index}`,
          nativeId: String(1001 + index),
          author: 'stranger',
        })),
      ],
    })
    expect(
      selectWorkflowBinding({
        ...input,
        histories: [foreign, prHistory],
      }),
    ).toMatchObject({ status: 'bound', binding: { recordId: `binding-${mandated.recordId}` } })
    const incomplete = decodeHistory({
      ...home.source,
      comments: [
        ...home.source.comments,
        ...control.source.comments.map((comment, index) => ({
          ...comment,
          locator: `${SCOPE.target}:comment:${1001 + index}`,
          nativeId: String(1001 + index),
          body: comment.body.replace('part=1/1', 'part=1/2'),
        })),
      ],
    })
    expect(
      selectWorkflowBinding({
        ...input,
        histories: [incomplete, prHistory],
      }),
    ).toMatchObject({ status: 'incomplete' })
    const next = must(
      parseRecord({
        ...mandated,
        recordId: successor.recordId,
        operationId: 'op-next-mandate',
        inputs: [mandated.recordId, ...mandated.inputs],
        payload: { ...mandated.payload, antecedent: predecessor },
      }),
    )
    const chainHome = history([mandated, next, built.value])
    const chainPr = history([binding(mandated, pr), binding(next, pr)], pr)
    expect(selectWorkflowBinding({ ...input, histories: [chainHome, chainPr] })).toMatchObject({
      status: 'bound',
      mandate: successor,
    })
    const unresolved = must(
      parseRecord({ ...built.value, recordId: 'unresolved-select', operationId: 'op-unresolved-select' }),
    )
    const unresolvedComments = history([unresolved]).source.comments.map((comment, index) => ({
      ...comment,
      locator: `${SCOPE.target}:comment:${2001 + index}`,
      nativeId: String(2001 + index),
      body: comment.body.replace('part=1/1', 'part=1/2'),
    }))
    const uncertainChainHome = decodeHistory({
      ...chainHome.source,
      comments: [...chainHome.source.comments, ...unresolvedComments],
    })
    expect(selectWorkflowBinding({ ...input, histories: [uncertainChainHome, chainPr] })).toMatchObject({
      status: 'incomplete',
    })
  })
})
