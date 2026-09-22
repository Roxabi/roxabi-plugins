import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Integration, not unit: sourcing lib.sh forks bash, and vitest.setup.ts fails a
// unit test that forks (#502).
const LIB = path.resolve(import.meta.dirname, '..', 'lib.sh')

/**
 * Git reads GIT_DIR / GIT_WORK_TREE from the environment and they beat `cwd`.
 * Under a git hook — lefthook runs this suite on pre-push — they point at
 * whatever repository invoked the hook, so a probe would answer about the wrong
 * one (#532).
 */
function envWithoutGit(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
}

function runHelper(snippet: string, cwd: string): string {
  return execFileSync('bash', ['-c', `source ${JSON.stringify(LIB)} && ${snippet}`], {
    cwd,
    encoding: 'utf8',
    env: envWithoutGit(),
  }).trim()
}

describe('omp-build shared/lib.sh', () => {
  it('resolves the base branch from the omp-build path', () => {
    // The acceptance criterion of #491: the helper works from its new home,
    // without dev-core on disk.
    expect(runHelper('detect_base_branch', process.cwd())).toMatch(/^(staging|main|master)$/)
  })

  it('recognises the protected bases and nothing else', () => {
    expect(runHelper('is_base_branch main && echo yes', process.cwd())).toBe('yes')
    expect(runHelper('is_base_branch feat/x || echo no', process.cwd())).toBe('no')
  })
})
