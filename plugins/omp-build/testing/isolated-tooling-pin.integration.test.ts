import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { git, sandbox } from './sandbox/sandbox-repository.ts'

it('lets an operator activate the target proposal and frame with the installed candidate despite the shared mismatch', () => {
  const box = sandbox({ base: { 'README.md': 'fixture\n' }, branches: [], issues: [], prs: [] })
  try {
    const simulator = process.env.OMP_TEST_GH_SIMULATOR_PATH
    if (!simulator) throw new Error('fixture-gh-simulator-missing')
    const pinGh = process.env.OMP_TEST_PIN_GH_PATH
    if (!pinGh) throw new Error('fixture-pin-gh-missing')
    // The canonical simulator materializes a real tooling repository containing the installed bytes.
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
    // The candidate is an ancestor, not the tip, of the source default branch.
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
    expect(candidate).not.toBe(shared)

    // The adapter only supplies the two variables, old package blob lookup and source ancestry.
    const bin = join(box.root, 'pin-bin')
    execFileSync('mkdir', ['-p', bin])
    symlinkSync(pinGh, join(bin, 'gh'))
    const run = spawnSync('bun', [resolve(import.meta.dirname, 'isolated-pin-consumer-runner.ts'), box.principal], {
      cwd: box.principal,
      env: {
        ...box.env,
        PATH: `${bin}:${box.env.PATH}`,
        PIN_SHARED: shared,
        PIN_CANDIDATE: candidate,
        PIN_DEFAULT_HEAD: defaultHead,
      },
      encoding: 'utf8',
      timeout: 45_000,
    })
    expect(run.status, run.stderr).toBe(0)
    const result = JSON.parse(run.stdout) as {
      beforeStatus: string
      beforeUserMessages: unknown[]
      afterStatus: string
      displays: string[]
      userMessages: Array<{ content: unknown; options: unknown }>
      projection?: { messages: unknown[] }
    }
    expect(result.beforeStatus).toContain('framing procedures unavailable (plugin-pin-mismatch)')
    expect(result.beforeUserMessages).toEqual([])
    expect(result.displays.join('\n')).toContain(candidate)
    expect(result.displays.join('\n')).toContain('Roxabi/roxabi-plugins')
    expect(result.afterStatus).toContain('feature-framing: interview started')
    expect(result.userMessages).toContainEqual({
      content: 'Build a billing export for operators',
      options: { attribution: 'user' },
    })
    expect(result.projection?.messages).toContainEqual(
      expect.objectContaining({
        role: 'custom',
        customType: 'omp-build-framing-procedure',
        content: expect.stringContaining('Procedure: grilling; manifest:'),
      }),
    )
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})
