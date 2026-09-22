import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The fork budget guard lives in vitest.setup.ts, so the only way to observe it
 * is to run vitest. One boot covers both directions: a forking test named for
 * the unit project must fail, and the same body named for the integration
 * project must pass.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// Inside the repo, so the fixture config resolves `vitest/config`; inside
// node_modules, so neither git nor vitest ever sees the fixtures.
const scratch = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.fork-budget-'))

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

const FORKING_BODY = [
  "import { execSync } from 'node:child_process'",
  "import { expect, it } from 'vitest'",
  "it('forks', () => {",
  "  execSync('true')",
  '  expect(true).toBe(true)',
  '})',
  '',
].join('\n')

describe('fork budget guard', () => {
  it('fails a forking test named for the unit project and passes the same body named for integration', () => {
    fs.writeFileSync(path.join(scratch, 'offender.test.ts'), FORKING_BODY)
    fs.writeFileSync(path.join(scratch, 'allowed.integration.test.ts'), FORKING_BODY)
    const config = [
      "import { defineConfig } from 'vitest/config'",
      'export default defineConfig({',
      `  test: { root: ${JSON.stringify(scratch)}, setupFiles: [${JSON.stringify(path.join(ROOT, 'vitest.setup.ts'))}] },`,
      '})',
      '',
    ].join('\n')
    const configPath = path.join(scratch, 'vitest.fixture.config.ts')
    fs.writeFileSync(configPath, config)

    let output = ''
    let failed = false
    try {
      output = execFileSync('bunx', ['vitest', 'run', '--config', configPath], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Without this the nested reporter inherits colour from the parent run
        // and interleaves ANSI codes through the summary line.
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      })
    } catch (error) {
      failed = true
      const shape = error as { stdout?: string; stderr?: string }
      output = `${shape.stdout ?? ''}${shape.stderr ?? ''}`
    }

    // The offender fails the run...
    expect(failed).toBe(true)
    expect(output).toContain('forked 1 process(es) on the 5s unit budget')
    expect(output).toContain('offender.test.ts')
    // ...and the integration-named twin is not accused.
    expect(output).not.toContain('allowed.integration.test.ts >')
    expect(output).toMatch(/1 failed \| 1 passed/)
  })
})
