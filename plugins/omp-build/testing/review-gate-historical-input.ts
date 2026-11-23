import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sha256Bytes } from '../roxabi/uw-action-result.ts'
import { boundInput } from './review-gate-arrangement.ts'
import { git, type ReviewGateFixture } from './review-gate-fixture.ts'

// The producer's ordered nativeReviewProfiles roster at cf03b9c4, independent of the verifier.
const PROFILES = [
  'adversarial',
  'security-auditor',
  'architect',
  'devops',
  'tester',
  'spec',
  'synthesis',
  'fix-intake',
  'fix-synthesis',
  'fix-apply',
  'fix-falsify',
  'recall',
] as const

/** A committed pre-3c catalogue with all twelve retired review profiles. */
export function historicalGateInput(
  fixture: ReviewGateFixture,
  fault?: 'bad profile digest' | 'stale repository references' | 'incomplete historical inventory',
) {
  const root = 'plugins/omp-build'
  const packageFile = `${root}/package.json`
  const pkgBytes = `${JSON.stringify({ ...JSON.parse(readFileSync(path.join(fixture.tools, packageFile), 'utf8')), version: '0.21.14' })}\n`
  git(fixture.tools, ['switch', '-q', '--detach', fixture.pin])
  writeFileSync(path.join(fixture.tools, packageFile), pkgBytes)
  const profiles = PROFILES.map((profile) => {
    const name = `R-review-${profile}`
    const file = `${root}/agents/${name}.md`
    const bytes = `---\nname: ${name}\n---\nReview the supplied input.\n`
    const installed = path.join(fixture.tools, file)
    if (existsSync(installed)) throw new Error(`${file} is installed in the current gate`)
    writeFileSync(installed, bytes)
    const digest =
      fault === 'bad profile digest' && profile === 'spec' ? '0'.repeat(64) : sha256Bytes(Buffer.from(bytes))
    return { path: file, digest }
  })
  git(fixture.tools, ['add', packageFile, ...profiles.map((profile) => profile.path)])
  git(fixture.tools, ['commit', '-qm', 'pre-3c review tooling'])
  const commit = git(fixture.tools, ['rev-parse', 'HEAD'])
  git(fixture.tools, ['switch', '-q', 'main'])
  for (const profile of profiles) {
    if (existsSync(path.join(fixture.tools, profile.path)))
      throw new Error(`${profile.path} leaked into the current gate`)
  }
  // The omitted profile still exists at the pinned commit; every listed digest is valid.
  if (fault === 'incomplete historical inventory') profiles.pop()

  return boundInput(fixture, (manifest) => {
    const { repository, files } = manifest.plugin
    manifest.plugin = {
      ...manifest.plugin,
      commit,
      version: '0.21.14',
      files: [
        ...files.map((ref) => ({
          ...ref,
          commit,
          digest: ref.path === packageFile ? sha256Bytes(Buffer.from(pkgBytes)) : ref.digest,
        })),
        ...profiles.map((profile) => ({ source: 'git-file' as const, repository, commit, ...profile })),
      ],
    }
    if (fault === 'stale repository references') manifest.repositoryReferences = []
  })
}
