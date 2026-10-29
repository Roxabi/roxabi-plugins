import { describe, expect, test } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  actionInputDigest,
  canonicalActionInput,
  citesCurrentRootOutput,
  validateActionInputs,
} from '../action-input.ts'
import {
  ACTION_BINDING_FORMAT,
  ACTION_INPUT_FORMAT,
  type ActionInputManifest,
  type RecordInputRef,
} from '../action-input-schema.ts'
import type { UnframedParser } from '../issue-spec-analysis-schema.ts'
import type { SpecRawSource } from '../uw-spec-schema.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { SCOPE } from './workflow-test-support.ts'

const SHA = 'a'.repeat(64)
const GIT = 'b'.repeat(40)
const UW = { repository: 'acme/app', target: 'acme/app#42' }

const parser: UnframedParser = {
  status: 'malformed',
  diagnostics: [],
  analysis: { criterionSources: [], invariantSources: [], contentSources: [], preservedContent: [] },
  draft: null,
}

function source(lastEditedAt: string | null): SpecRawSource {
  return { reference: 'acme/app#42', body: 'C1: persist the region', bodySha256: SHA, lastEditedAt }
}

function manifest(
  specInput: ActionInputManifest['spec'],
  purpose: ActionInputManifest['purpose'],
): ActionInputManifest {
  return {
    format: ACTION_INPUT_FORMAT,
    purpose,
    subject: { kind: 'uw', uw: UW, pullRequest: null, binding: null },
    spec: specInput,
    code: { repository: 'acme/app', base: GIT, head: GIT, referenceCommit: GIT },
    acceptedSources: [],
    deliveryData: [],
    repositoryReferences: [],
    plugin: {
      name: 'omp-build',
      version: '0.15.0',
      repository: 'Roxabi/roxabi-plugins',
      commit: GIT,
      root: 'plugins/omp-build',
      files: [],
    },
    configuration: { version: '0.15.0', digest: SHA, serialized: 'config' },
    expandedContext: [],
  }
}

function outputRef(selector: string): RecordInputRef {
  return {
    source: 'record',
    record: { scope: UW, recordId: 'current-review', kind: 'review' },
    selector,
    digest: SHA,
  }
}

function bound(manifestValue: ActionInputManifest, stageSources: RecordInputRef[] = []) {
  return {
    format: ACTION_BINDING_FORMAT,
    manifest: manifestValue,
    fingerprint: actionInputDigest(manifestValue),
    stageSources,
  }
}

describe('action input fingerprint', () => {
  test('ignores observed edit time and keeps source body and parser order', () => {
    const mandate = roxabiWorkflowFixtures().featureMandate(SCOPE, {
      recordId: 'digest-mandate',
      runId: 'run-1',
      operationId: 'op-digest-mandate',
      branch: 'feature/digest',
      base: 'main',
      lineageHead: null,
      body: 'ship the bounded workflow',
    })
    const accepted = mandateAssessmentState(mandate)
    const assessment = assessFixture(
      mandate,
      'digest-assessment',
      accepted,
      proposedAssessmentState(accepted, { body: 'new proposal' }),
      'material',
    )
    if (assessment.start.kind !== 'action-receipt' || assessment.start.payload.action !== 'assess-spec')
      throw new Error('expected assessment start')
    const assessmentManifest = assessment.start.payload.inputs.manifest
    const proposed = (lastEditedAt: string | null) => {
      return {
        ...assessmentManifest,
        spec: {
          kind: 'proposed' as const,
          uw: SCOPE,
          snapshot: { ...assessment.proposed.snapshot, raw: { ...assessment.proposed.snapshot.raw, lastEditedAt } },
        },
      }
    }
    const unframed = (lastEditedAt: string | null, sources = parser.analysis.criterionSources) =>
      manifest(
        {
          kind: 'unframed',
          uw: UW,
          source: source(lastEditedAt),
          parser: { ...parser, analysis: { ...parser.analysis, criterionSources: sources } },
        },
        'normalize',
      )
    const first = {
      id: 'C1',
      statement: 'first',
      span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      source: 'body',
    }
    const second = {
      id: 'C2',
      statement: 'second',
      span: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } },
      source: 'body',
    }
    expect(actionInputDigest(proposed('2026-10-21T00:00:00Z'))).toBe(actionInputDigest(proposed(null)))
    expect(actionInputDigest(unframed('2026-10-22T00:00:00Z'))).toBe(
      actionInputDigest(unframed('2026-10-21T00:00:00Z')),
    )
    expect(canonicalActionInput(proposed('2026-10-21T00:00:00Z'))).not.toContain('lastEditedAt')
    expect(canonicalActionInput(unframed('2026-10-21T00:00:00Z'))).toContain('persist the region')
    expect(canonicalActionInput(unframed('2026-10-21T00:00:00Z'))).toContain('"status":"malformed"')
    expect(actionInputDigest(unframed(null, [first, second]))).not.toBe(
      actionInputDigest(unframed(null, [second, first])),
    )
  })

  test('refuses the same current output under another selector and keeps a prior review', () => {
    const current = manifest({ kind: 'absent', reason: 'standalone-review' }, 'review')
    const laundered = bound({ ...current, expandedContext: [outputRef('/payload')] }, [
      outputRef('/payload/structured'),
    ])
    const prior = bound({
      ...current,
      expandedContext: [
        { ...outputRef('/payload'), record: { ...outputRef('/payload').record, recordId: 'prior-review' } },
      ],
    })
    expect(validateActionInputs(laundered).ok).toBe(false)
    expect(citesCurrentRootOutput(prior, [outputRef('/payload')])).toEqual([])
    expect(
      citesCurrentRootOutput(prior, [
        { ...outputRef('/payload/raw'), record: { ...outputRef('/payload').record, recordId: 'prior-review' } },
      ]),
    ).toEqual([expect.objectContaining({ code: 'self-output' })])
  })
})
