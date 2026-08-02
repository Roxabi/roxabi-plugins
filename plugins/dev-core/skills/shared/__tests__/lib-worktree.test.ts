import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SHELL_TEST = path.resolve(import.meta.dirname, 'lib-worktree.test.sh')

describe('lib-worktree.test.sh', () => {
  it('principal freeze + branch-first feature worktree detect', () => {
    const output = execFileSync('bash', [SHELL_TEST], { encoding: 'utf8' })
    expect(output.trim()).toContain('PASS: lib-worktree.test.sh')
  })
})
