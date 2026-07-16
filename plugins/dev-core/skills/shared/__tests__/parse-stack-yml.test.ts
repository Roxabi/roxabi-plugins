import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { parseStackYml } = require('../../../hooks/lib/parse-stack-yml.cjs') as {
  parseStackYml: (text: string | null) => {
    formatters: Array<{ cmd: string; ext: string[] | null }> | null
    singleFormatterCmd: string | null
    platform: string | null
    frontend: string | null
    packageManager: string | null
    standards: Record<string, string> | null
    runtime: string | null
    commands: { lint: string | null; typecheck: string | null; test: string | null }
    testingUnit: string | null
    testingE2e: string | null
    ciMerge: string | null
  }
}

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/sample-stack.yml')
const fixtureText = readFileSync(FIXTURE_PATH, 'utf8')

describe('parseStackYml — sample-stack.yml fixture', () => {
  it('parses formatters array', () => {
    const result = parseStackYml(fixtureText)
    expect(result.formatters).not.toBeNull()
    expect(result.formatters).toHaveLength(2)
    expect(result.formatters?.[0]).toEqual({
      cmd: 'bunx biome check --write',
      ext: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    })
    expect(result.formatters?.[1]).toEqual({
      cmd: 'ruff format',
      ext: ['.py'],
    })
  })

  it('parses deploy.platform', () => {
    const result = parseStackYml(fixtureText)
    expect(result.platform).toBe('vercel')
  })

  it('parses frontend.framework', () => {
    const result = parseStackYml(fixtureText)
    expect(result.frontend).toBe('tanstack-start')
  })

  it('parses package_manager', () => {
    const result = parseStackYml(fixtureText)
    expect(result.packageManager).toBe('bun')
  })

  it('parses standards section', () => {
    const result = parseStackYml(fixtureText)
    expect(result.standards).not.toBeNull()
    expect(result.standards).toEqual({
      architecture: 'docs/architecture',
      deployment: 'docs/guides/deployment.mdx',
      configuration: 'docs/configuration.mdx',
      troubleshooting: 'docs/guides/troubleshooting.mdx',
    })
  })
})

describe('parseStackYml — edge cases', () => {
  it('returns all nulls for null input', () => {
    const result = parseStackYml(null)
    expect(result.formatters).toBeNull()
    expect(result.singleFormatterCmd).toBeNull()
    expect(result.platform).toBeNull()
    expect(result.frontend).toBeNull()
    expect(result.packageManager).toBeNull()
    expect(result.standards).toBeNull()
    expect(result.runtime).toBeNull()
    expect(result.commands).toEqual({ lint: null, typecheck: null, test: null })
    expect(result.testingUnit).toBeNull()
    expect(result.testingE2e).toBeNull()
    expect(result.ciMerge).toBeNull()
  })

  it('parses testing.unit', () => {
    const result = parseStackYml(`
runtime: bun
testing:
  unit: bun
  e2e: none
`)
    expect(result.testingUnit).toBe('bun')
    expect(result.testingE2e).toBeNull()
  })

  it('parses runtime, commands, testing.e2e, and ci.merge', () => {
    const text = `runtime: bun
testing:
  e2e: playwright
ci:
  merge: merge-on-green
commands:
  lint: bun lint
  test: bun run test
deploy:
  platform: cloudflare-pages
`
    const result = parseStackYml(text)
    expect(result.runtime).toBe('bun')
    expect(result.commands.lint).toBe('bun lint')
    expect(result.commands.test).toBe('bun run test')
    expect(result.testingE2e).toBe('playwright')
    expect(result.ciMerge).toBe('merge-on-green')
    expect(result.platform).toBe('cloudflare-pages')
  })

  it('platform=none returns null', () => {
    const text = 'deploy:\n  platform: none\n'
    expect(parseStackYml(text).platform).toBeNull()
  })

  it('frontend framework=none returns null', () => {
    const text = 'frontend:\n  framework: none\n'
    expect(parseStackYml(text).frontend).toBeNull()
  })

  it('falls back to singleFormatterCmd when no formatters array', () => {
    const text = 'build:\n  formatter_fix_cmd: "bunx biome check --write"\n'
    const result = parseStackYml(text)
    expect(result.formatters).toBeNull()
    expect(result.singleFormatterCmd).toBe('bunx biome check --write')
  })

  it('parses formatter cmd with single-quote wrapping', () => {
    const text = "build:\n  formatter_fix_cmd: 'ruff format'\n"
    expect(parseStackYml(text).singleFormatterCmd).toBe('ruff format')
  })

  it('formatter ext=null when ext key absent', () => {
    const text = 'build:\n  formatters:\n    - cmd: "ruff format"\n'
    const result = parseStackYml(text)
    expect(result.formatters).not.toBeNull()
    expect(result.formatters?.[0].ext).toBeNull()
  })
})
