import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { observeHistoricalPins } from '../../adapters/github/historical-pins.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { actionInputDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import {
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { history, must, SCOPE } from './workflow-test-support.ts'

const variants = ['valid', 'wrong digest', 'missing blob'] as const
const placements = ['repositoryReferences', 'plugin.files'] as const

test.each(placements)('uncited assessment %s pins still bind the historical result', async (placement) => {
  const git = nativeImplementationGit()
  try {
    const commit = git.heads[0]
    if (commit === undefined) throw new Error('Expected a committed fixture')
    execFileSync('git', ['-C', git.cwd, 'remote', 'set-url', 'origin', `https://github.com/${SCOPE.repository}.git`])
    const bytes = execFileSync('git', ['-C', git.cwd, 'show', `${commit}:fixture.txt`])
    const digest = createHash('sha256').update(bytes).digest('hex')
    const mandate = shippedFeatureMandate()
    const accepted = mandateAssessmentState(mandate)
    const proposed = proposedAssessmentState(accepted, { body: 'Make the original wording more precise' })
    const fixture = assessFixture(mandate, 'uncited-manifest', accepted, proposed, 'editorial', [history([mandate])])
    const original = fixture.result.payload.inputs
    expect(fixture.result.payload.structured).toMatchObject({ compatibility: { references: [] } })
    if (fixture.start.kind !== 'action-receipt') throw new Error('Expected assessment START')
    for (const variant of variants) {
      const repo = SCOPE.repository
      const pin = {
        source: 'git-file' as const,
        repository: repo,
        commit,
        path: variant === 'missing blob' ? 'missing-file.txt' : 'fixture.txt',
        digest: variant === 'wrong digest' ? 'f'.repeat(64) : digest,
      }
      const manifest =
        placement === 'repositoryReferences'
          ? { ...original.manifest, repositoryReferences: [pin] }
          : { ...original.manifest, plugin: { ...original.manifest.plugin, repository: repo, commit, files: [pin] } }
      const inputs = { ...original, manifest, fingerprint: actionInputDigest(manifest) }
      const start = must(buildRecord({ ...fixture.start, payload: { ...fixture.start.payload, inputs } }))
      const result = must(buildRecord({ ...fixture.result, payload: { ...fixture.result.payload, inputs } }))
      const observed = await observeHistoricalPins(history([mandate, start, result]), {
        cwd: git.cwd,
        readAuthor: 'operator',
        gh: async () => {
          throw new Error('No remote fixture Git objects')
        },
      })
      expect(resolveAcceptedSpec(mandate, [observed]).ok, variant).toBe(variant === 'valid')
    }
  } finally {
    git.cleanup()
  }
})
