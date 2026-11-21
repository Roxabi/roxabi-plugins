import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    ompTestGhServerPath: string
    ompTestGhStandalonePath: string
    ompTestPinGhPath: string
    ompTestToolingGhPath: string
  }
}

export default function setupSimulator(project: TestProject): () => void {
  const dir = mkdtempSync(path.join(path.resolve(tmpdir()), 'omp-test-gh-simulator-'))
  const binary = path.join(dir, 'gh-server')
  const standalone = path.join(dir, 'gh-standalone')
  const pinGh = path.join(dir, 'pin-gh')
  const toolingReader = path.join(dir, 'tooling-gh')
  const plugin = path.resolve(import.meta.dirname, 'plugins/omp-build')
  try {
    execFileSync(
      'bun',
      [
        'build',
        path.join(plugin, 'skills/feature/testing/gh-simulator/sim-server.ts'),
        '--compile',
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--bytecode',
        '--format=esm',
        '--define',
        `OMP_SIM_PHYSICAL_TOOLING_ROOT=${JSON.stringify(plugin)}`,
        '--outfile',
        binary,
      ],
      { stdio: 'inherit' },
    )
    execFileSync(
      'bun',
      [
        'build',
        path.join(plugin, 'skills/feature/testing/gh-simulator/gh-simulator.ts'),
        '--compile',
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--bytecode',
        '--format=esm',
        '--define',
        `OMP_SIM_PHYSICAL_TOOLING_ROOT=${JSON.stringify(plugin)}`,
        '--outfile',
        standalone,
      ],
      { stdio: 'inherit' },
    )
    execFileSync(
      'bun',
      [
        'build',
        path.join(plugin, 'testing/isolated-pin-gh-fixture.ts'),
        '--compile',
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--bytecode',
        '--format=esm',
        '--define',
        `OMP_SIM_PHYSICAL_TOOLING_ROOT=${JSON.stringify(plugin)}`,
        '--outfile',
        pinGh,
      ],
      { stdio: 'inherit' },
    )
    // Epic fixtures read the physical checkout pin, not the simulator's synthetic tooling tree.
    execFileSync(
      'bun',
      [
        'build',
        path.join(plugin, 'testing/review-gate-tooling-gh-cli.ts'),
        '--compile',
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--bytecode',
        '--format=esm',
        '--outfile',
        toolingReader,
      ],
      { stdio: 'inherit' },
    )
    project.provide('ompTestGhServerPath', binary)
    project.provide('ompTestGhStandalonePath', standalone)
    project.provide('ompTestPinGhPath', pinGh)
    project.provide('ompTestToolingGhPath', toolingReader)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return () => rmSync(dir, { recursive: true, force: true })
}
