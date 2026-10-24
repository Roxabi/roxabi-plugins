import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const biome = join(repositoryRoot, 'node_modules/.bin/biome')
const checker = join(repositoryRoot, 'tools/check-omp-build-quality.ts')
const owned = new Set<string>()

type Result = { code: number; diagnostics: Array<{ category: string; severity: string }> }

afterEach(() => {
  for (const root of owned) rmSync(root, { recursive: true, force: true })
  owned.clear()
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omp-build-biome-'))
  owned.add(root)
  copyFileSync(join(repositoryRoot, 'biome.json'), join(root, 'biome.json'))
  write(root, 'tools/check-omp-build-quality.ts', 'export {}\n')
  return root
}

function write(root: string, name: string, content: string): string {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function run(root: string): Result {
  const result = spawnSync('bun', [checker, '--root', root, '--with-biome'], { cwd: root, encoding: 'utf8' })
  const report = JSON.parse(result.stdout) as { diagnostics: Array<{ category: string; severity: string }> }
  return { code: result.status ?? 1, diagnostics: report.diagnostics }
}

function runRaw(root: string): { code: number; output: string } {
  const result = spawnSync('bun', [checker, '--root', root, '--with-biome'], { cwd: root, encoding: 'utf8' })
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
}

function format(root: string, path: string): void {
  const result = spawnSync(biome, ['format', '--write', path], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

function flatCognitive(declaration: string, count: number): string {
  return [
    `${declaration} {`,
    '  let value = true',
    ...Array.from({ length: count }, () => '  if (value) value = false'),
    '  return value',
    '}',
  ].join('\n')
}

function expectOnly(result: Result, severity: string, category: string): void {
  expect(result.code).toBe(1)
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]).toMatchObject({ severity, category: expect.stringContaining(category) })
}

describe('C5 Biome command boundaries', () => {
  it('refuses a populated scope with no JavaScript, TypeScript, or CJS candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-build-biome-'))
    owned.add(root)
    write(root, 'plugins/omp-build/quality.py', 'print("quality")\n')
    write(root, 'tools/omp-build-quality.sh', '#!/usr/bin/env bash\necho quality\n')

    const result = runRaw(root)
    expect(result.code).toBe(1)
    expect(result.output).toContain('expected omp-build quality scope contains no JS/TS/CJS candidates for Biome')
  })

  it('enforces cognitive 15/16 through the owned-root command for CJS, scenarios, and direct/nested tools', () => {
    const root = fixture()
    const cjsName = 'plugins/omp-build/hooks/boundary.cjs'
    const scenarioName = 'plugins/omp-build/testing/boundary.integration.test.ts'
    const toolName = 'tools/check-omp-build-boundary.ts'
    const nestedToolName = 'tools/owned-omp-build-boundary/support.ts'
    const cjs = write(root, cjsName, `${flatCognitive('function boundary()', 15)}\nmodule.exports = boundary\n`)
    const scenario = write(
      root,
      scenarioName,
      `import { expect, it } from 'vitest'\n\nit('boundary', () => {\n  let value = true\n${Array.from({ length: 15 }, () => '  if (value) value = false').join('\n')}\n  expect(value).toBe(false)\n})\n`,
    )
    const tool = write(root, toolName, flatCognitive('export function boundary()', 15))
    const nestedTool = write(root, nestedToolName, flatCognitive('export function boundary()', 15))
    for (const path of [cjs, scenario, tool, nestedTool]) format(root, path)
    expect(run(root)).toMatchObject({ code: 0, diagnostics: [] })

    write(root, cjsName, `${flatCognitive('function boundary()', 16)}\nmodule.exports = boundary\n`)
    format(root, cjs)
    expectOnly(run(root), 'error', 'noExcessiveCognitiveComplexity')
    write(root, cjsName, `${flatCognitive('function boundary()', 15)}\nmodule.exports = boundary\n`)
    format(root, cjs)

    write(
      root,
      scenarioName,
      `import { expect, it } from 'vitest'\n\nit('boundary', () => {\n  let value = true\n${Array.from({ length: 16 }, () => '  if (value) value = false').join('\n')}\n  expect(value).toBe(false)\n})\n`,
    )
    format(root, scenario)
    expectOnly(run(root), 'error', 'noExcessiveCognitiveComplexity')
    write(
      root,
      scenarioName,
      `import { expect, it } from 'vitest'\n\nit('boundary', () => {\n  let value = true\n${Array.from({ length: 15 }, () => '  if (value) value = false').join('\n')}\n  expect(value).toBe(false)\n})\n`,
    )
    format(root, scenario)

    write(root, toolName, flatCognitive('export function boundary()', 16))
    format(root, tool)
    expectOnly(run(root), 'error', 'noExcessiveCognitiveComplexity')
    write(root, toolName, flatCognitive('export function boundary()', 15))
    format(root, tool)

    write(root, nestedToolName, flatCognitive('export function boundary()', 16))
    format(root, nestedTool)
    expectOnly(run(root), 'error', 'noExcessiveCognitiveComplexity')
  })

  it('does not require a nested owned-tool directory', () => {
    const root = fixture()
    const runtime = write(root, 'plugins/omp-build/runtime.ts', 'export {}\n')
    format(root, runtime)
    expect(run(root)).toMatchObject({ code: 0, diagnostics: [] })
  })

  it('turns a warning alone into a failing owned-root command', () => {
    const root = fixture()
    const path = write(
      root,
      'plugins/omp-build/runtime.ts',
      'function warning() { let value = true; return value }\nwarning()\n',
    )
    format(root, path)
    expectOnly(run(root), 'warning', 'useConst')
  })

  it('rejects a focused test alone', () => {
    const root = fixture()
    const path = write(
      root,
      'plugins/omp-build/testing/focus.integration.test.ts',
      "import { expect, it } from 'vitest'\n\nit.only('focused', () => { expect(true).toBe(true) })\n",
    )
    format(root, path)
    expectOnly(run(root), 'error', 'noFocusedTests')
  })

  it('rejects runtime async misuse while scenario, nested-testing support, declaration, and JavaScript variants stay clean', () => {
    const root = fixture()
    const runtime = write(
      root,
      'plugins/omp-build/runtime.ts',
      'export async function good() { await Promise.resolve() }\n',
    )
    const scenario = write(
      root,
      'plugins/omp-build/testing/async.integration.test.ts',
      '[1].forEach(async () => { await Promise.resolve() })\n',
    )
    const cases = write(
      root,
      'plugins/omp-build/scripts/review-gate-mandate.cases.ts',
      '[1].forEach(async () => { await Promise.resolve() })\n',
    )
    const fixtureData = write(
      root,
      'plugins/omp-build/skills/feature/proof-integration-fixture-data.ts',
      '[1].forEach(async () => { await Promise.resolve() })\n',
    )
    const support = write(
      root,
      'plugins/omp-build/skills/feature/testing/gh-simulator/entry.ts',
      '[1].forEach(async () => { await Promise.resolve() })\n',
    )
    const declaration = write(
      root,
      'plugins/omp-build/skills/feature/landing-foundation.d.ts',
      'declare const promise: Promise<void>\nexport type State = typeof promise\n',
    )
    const javascript = write(
      root,
      'plugins/omp-build/runtime.js',
      '[1].forEach(async () => { await Promise.resolve() })\n',
    )
    for (const path of [runtime, scenario, cases, fixtureData, support, declaration, javascript]) format(root, path)
    expect(run(root)).toMatchObject({ code: 0, diagnostics: [] })

    write(root, 'plugins/omp-build/runtime.ts', 'Promise.resolve()\n')
    format(root, runtime)
    expectOnly(run(root), 'error', 'noFloatingPromises')
    write(root, 'plugins/omp-build/runtime.ts', '[1].forEach(async () => { await Promise.resolve() })\n')
    format(root, runtime)
    expectOnly(run(root), 'error', 'noMisusedPromises')
  })

  it('does not block on outside-plugin or shared-tool warnings', () => {
    const root = fixture()
    const runtime = write(root, 'plugins/omp-build/runtime.ts', 'export {}\n')
    const otherPlugin = write(root, 'plugins/issue-triage/uncapped.ts', flatCognitive('export function uncapped()', 16))
    const otherWarning = write(
      root,
      'plugins/issue-triage/warning.ts',
      'function warning() { let value = true; return value }\nwarning()\n',
    )
    const sharedTool = write(root, 'tools/unrelated.ts', flatCognitive('export function uncapped()', 16))
    for (const path of [runtime, otherPlugin, otherWarning, sharedTool]) format(root, path)
    expect(run(root)).toMatchObject({ code: 0, diagnostics: [] })
  })
})
