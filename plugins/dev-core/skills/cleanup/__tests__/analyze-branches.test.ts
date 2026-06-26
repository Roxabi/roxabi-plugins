import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const SHELL_TEST = path.resolve(import.meta.dirname, 'analyze-branches.test.sh')

describe('analyze-branches.test.sh', () => {
  it('passes integration fixture', () => {
    const output = execSync(`bash ${SHELL_TEST}`, { encoding: 'utf8' })
    expect(output.trim()).toContain('PASS: analyze-branches.test.sh')
  })
})