import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    ompTestGhSimulatorPath: string
  }
}

export default function setupSimulator(project: TestProject): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-test-gh-simulator-'))
  const binary = path.join(dir, 'gh')
  const plugin = path.resolve(import.meta.dirname, 'plugins/omp-build')
  try {
    execFileSync(
      'bun',
      [
        'build',
        path.join(plugin, 'skills/feature/testing/gh-simulator/gh-simulator.ts'),
        '--compile',
        '--bytecode',
        '--format=esm',
        '--define',
        `OMP_SIM_PHYSICAL_TOOLING_ROOT=${JSON.stringify(plugin)}`,
        '--outfile',
        binary,
      ],
      { stdio: 'inherit' },
    )
    project.provide('ompTestGhSimulatorPath', binary)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return () => rmSync(dir, { recursive: true, force: true })
}
