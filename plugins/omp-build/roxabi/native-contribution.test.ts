import { describe, expect, it } from 'vitest'
import { decodeHistory, encodeRecord, projectRecord } from '../dist/contracts.js'
import { NATIVE_AUTHOR, nativeOutcome, TEST_SCOPE } from '../testing/record-builders.ts'
import { contribution } from '../testing/record-decisions.ts'
import { history, observedComment, operation } from '../testing/record-history.ts'
import { roxabiRecordFixtures } from '../testing/roxabi-presets.ts'
import { modelContributionPayload } from './native-contribution'

const { projection: TEST_PROJECTION_CONFIG } = roxabiRecordFixtures()

describe('native contribution model payload', () => {
  it('omits only direct SDK task envelopes from model input while canonical records retain full native raw facts', () => {
    const nativeRaw = {
      provider: 'native-sdk',
      terminal: {
        task: 'sdk-task-envelope',
        assignment: 'sdk-assignment-envelope',
        output: 'provider completed the assigned review',
        postYieldText: 'provider yielded retained review details',
        error: 'provider retained stderr',
        proof: { status: 'verified', receipt: 'proof-17' },
        modelMetadata: { provider: 'local-sse', model: 'reviewer-v2', attempt: 3 },
        modelProduced: {
          task: 'model finding task remains evidence',
          assignment: 'model assigned evidence remains evidence',
        },
      },
    }
    const source = contribution({
      id: 'contribution-native-raw',
      inventoryId: null,
      native: nativeOutcome({ raw: nativeRaw }),
    })

    const model = modelContributionPayload(source.payload)

    expect(model.native?.raw).toEqual({
      provider: 'native-sdk',
      terminal: {
        output: 'provider completed the assigned review',
        postYieldText: 'provider yielded retained review details',
        error: 'provider retained stderr',
        proof: { status: 'verified', receipt: 'proof-17' },
        modelMetadata: { provider: 'local-sse', model: 'reviewer-v2', attempt: 3 },
        modelProduced: {
          task: 'model finding task remains evidence',
          assignment: 'model assigned evidence remains evidence',
        },
      },
    })
    expect(source.payload.native?.raw).toEqual(nativeRaw)

    const transport = {
      scope: TEST_SCOPE,
      expectedAuthor: NATIVE_AUTHOR,
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    }
    const encoded = encodeRecord(source, transport, TEST_PROJECTION_CONFIG)
    if (!encoded.ok) throw new Error(encoded.diagnostics.map((diagnostic) => diagnostic.code).join(','))
    const decoded = decodeHistory({
      ...transport,
      comments: encoded.value.map((body, index) =>
        observedComment({ locator: `comment-${index + 1}`, nativeId: String(index + 1), body }),
      ),
    })
    const decodedSource = decoded.operations.find((entry) => entry.recordId === source.recordId)?.record
    expect(decodedSource?.kind).toBe('contribution')
    expect(decodedSource?.kind === 'contribution' ? decodedSource.payload.native?.raw : null).toEqual(nativeRaw)

    const operatorProjection = {
      ...source,
      payload: { ...source.payload, host: { ...source.payload.host, origin: 'operator' as const } },
    }
    const projected = projectRecord(
      operatorProjection,
      { ...history([]), operations: [operation(operatorProjection)] },
      TEST_PROJECTION_CONFIG,
    )
    if (!projected.ok) throw new Error(projected.diagnostics.map((diagnostic) => diagnostic.code).join(','))
    expect(projected.value).not.toContain('sdk-task-envelope')
    expect(projected.value).not.toContain('sdk-assignment-envelope')
  })
})
