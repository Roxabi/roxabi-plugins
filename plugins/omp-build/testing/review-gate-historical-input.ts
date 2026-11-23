import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sha256Bytes } from '../roxabi/uw-action-result.ts'
import { boundInput } from './review-gate-arrangement.ts'
import { git, type ReviewGateFixture } from './review-gate-fixture.ts'

/** A committed pre-3c catalogue with a profile that the current gate checkout no longer installs. */
export function historicalGateInput(
  fixture: ReviewGateFixture,
  fault?: 'bad profile digest' | 'stale repository references',
) {
  const root = 'plugins/omp-build'
  const profile = `${root}/agents/R-review-spec.md`
  const packageFile = `${root}/package.json`
  const profileFile = path.join(fixture.tools, profile)
  if (existsSync(profileFile)) throw new Error('retired review profile is installed in the current gate')
  const pkgBytes = `${JSON.stringify({ ...JSON.parse(readFileSync(path.join(fixture.tools, packageFile), 'utf8')), version: '0.21.14' })}\n`
  const profileBytes = '---\nname: R-review-spec\n---\nReview the supplied Spec.\n'
  git(fixture.tools, ['switch', '-q', '--detach', fixture.pin])
  writeFileSync(path.join(fixture.tools, packageFile), pkgBytes)
  writeFileSync(profileFile, profileBytes)
  git(fixture.tools, ['add', packageFile, profile])
  git(fixture.tools, ['commit', '-qm', 'pre-3c review tooling'])
  const commit = git(fixture.tools, ['rev-parse', 'HEAD'])
  git(fixture.tools, ['switch', '-q', 'main'])
  if (existsSync(profileFile)) throw new Error('historical review profile leaked into the current gate')

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
        {
          source: 'git-file',
          repository,
          commit,
          path: profile,
          digest: fault === 'bad profile digest' ? '0'.repeat(64) : sha256Bytes(Buffer.from(profileBytes)),
        },
      ],
    }
    if (fault === 'stale repository references') manifest.repositoryReferences = []
  })
}
