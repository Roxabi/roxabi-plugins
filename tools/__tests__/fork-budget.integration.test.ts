import { exec, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { createVitest } from 'vitest/node'

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

  it('counts a fork without changing what child_process returns', async () => {
    // util.promisify dispatches on the promisify.custom symbol, which is what
    // makes this resolve to an object rather than the bare first callback
    // argument. A wrapper that dropped the original's own properties would
    // silently reshape every promisified caller in the suite — for instance
    // promote/lib/hotfix-density.ts.
    const result = await promisify(exec)('echo counted')
    expect(result.stdout.trim()).toBe('counted')
    expect(result.stderr).toBe('')
  })
})

describe('the repo suite is wired to the guard', () => {
  it('gives both projects the setup file and their own budget', async () => {
    // The guard only protects files whose project loads vitest.setup.ts.
    // Dropping `setupFiles`, or dropping `extends: true` from a project, would
    // leave forking unit tests green while the fixture test above still passes.
    const vitest = await createVitest('test', { watch: false, run: true })
    try {
      const byName = Object.fromEntries(vitest.projects.map((project) => [project.config.name, project.config]))
      expect(Object.keys(byName).sort()).toEqual(['integration', 'unit'])
      const setupFile = path.join(ROOT, 'vitest.setup.ts')
      for (const name of ['unit', 'integration']) {
        expect(byName[name].setupFiles, `${name} must load the fork guard`).toContain(setupFile)
        // Inherited from the root config — proof that `extends: true` is live.
        expect(byName[name].env.GITHUB_REPO, `${name} must inherit root env`).toBe('Test/test-repo')
      }
      expect(byName.unit.testTimeout).toBe(5_000)
      expect(byName.integration.testTimeout).toBe(30_000)
    } finally {
      await vitest.close()
    }
  })
})
