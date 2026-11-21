import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

/** Real committed installed bytes with an older shared pin and a later source default-branch head. */
export function isolatedPinSandbox(box: Box): { candidate: string; shared: string; env: NodeJS.ProcessEnv } {
  const simulator = process.env.OMP_TEST_GH_SIMULATOR_PATH
  if (!simulator) throw new Error('fixture-gh-simulator-missing')
  const pinGh = process.env.OMP_TEST_PIN_GH_CLIENT_PATH ?? process.env.OMP_TEST_PIN_GH_PATH
  if (!pinGh) throw new Error('fixture-pin-gh-missing')
  execFileSync(simulator, ['variable', 'get', 'OMP_BUILD_TOOLING_SHA', '--repo', 'Roxabi/roxabi-plugins'], {
    cwd: box.principal,
    env: box.env,
  })
  const tooling = join(box.root, 'omp-tooling.git')
  const pkg = join(tooling, 'plugins/omp-build/package.json')
  const installedPackage = readFileSync(pkg, 'utf8')
  const oldPackage = JSON.parse(installedPackage) as { version: string }
  oldPackage.version = '0.0.1'
  writeFileSync(pkg, `${JSON.stringify(oldPackage, null, 2)}\n`)
  git(box, tooling, ['add', 'plugins/omp-build/package.json'])
  git(box, tooling, ['commit', '-qm', 'fixture: shared older package'])
  const shared = git(box, tooling, ['rev-parse', 'HEAD'])
  writeFileSync(pkg, installedPackage)
  git(box, tooling, ['add', 'plugins/omp-build/package.json'])
  git(box, tooling, ['commit', '-qm', 'fixture: installed candidate'])
  const candidate = git(box, tooling, ['rev-parse', 'HEAD'])
  const tree = git(box, tooling, ['rev-parse', `${candidate}^{tree}`])
  const defaultHead = git(box, tooling, [
    'commit-tree',
    tree,
    '-p',
    candidate,
    '-m',
    'fixture: later default branch head',
  ])
  git(box, tooling, ['update-ref', 'refs/remotes/fixture/main', defaultHead])
  const bin = join(box.root, 'pin-bin')
  mkdirSync(bin)
  symlinkSync(pinGh, join(bin, 'gh'))
  return {
    candidate,
    shared,
    env: {
      ...box.env,
      PATH: `${bin}:${box.env.PATH}`,
      PIN_SHARED: shared,
      PIN_CANDIDATE: candidate,
      PIN_DEFAULT_HEAD: defaultHead,
    },
  }
}
