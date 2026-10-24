import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const checker = join(repositoryRoot, 'tools/check-omp-build-quality.ts')
const owned = new Set<string>()

afterEach(() => {
  for (const path of owned) rmSync(path, { recursive: true, force: true })
  owned.clear()
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omp-build-quality-'))
  owned.add(root)
  mkdirSync(join(root, 'plugins/omp-build'), { recursive: true })
  write(root, 'tools/check-omp-build-quality.ts', 'export {}\n')
  return root
}

function write(root: string, name: string, content: string): void {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function sourceLines(count: number, ending: string, terminated = true): string {
  const lines = Array.from({ length: count }, (_, index) => {
    if (index % 3 === 0) return '// comment'
    if (index % 3 === 1) return ''
    return 'export const value = 1'
  })
  return `${lines.join(ending)}${terminated ? ending : ''}`
}

function scenarioLines(count: number, ending: string): string {
  const lines = Array.from({ length: count }, (_, index) => {
    if (index === 0) return "import { expect, it } from 'vitest'"
    if (index === 1) return "it('real scenario', () => { expect(true).toBe(true) })"
    return '// scenario'
  })
  return `${lines.join(ending)}${ending}`
}

function paddedLines(count: number, lines: string[], filler: string): string {
  const padding = Array.from({ length: count - lines.length }, () => filler)
  return `${[...lines, ...padding].join('\n')}\n`
}

function jsonDataLines(count: number): string {
  const values = Array.from({ length: count - 2 }, (_, index) => `  ${index},`)
  return `[\n${values.join('\n')}\n]\n`
}

function commentLines(count: number): string {
  return `${Array.from({ length: count }, () => "// it('not executable', () => { expect(true).toBe(true) })").join('\n')}\n`
}

function templateFakeLines(count: number): string {
  const lines = [
    "const fake = `import { expect, it } from 'vitest'",
    "it('not executable', () => { expect(true).toBe(true) })`",
    ...Array.from({ length: count - 2 }, () => '// inert text'),
  ]
  return `${lines.join('\n')}\n`
}

function exportedHelperWithEmptyTestLines(count: number): string {
  const lines = [
    "import { expect, it } from 'vitest'",
    'export function helper(): void {}',
    "it('empty token', () => {})",
    ...Array.from({ length: count - 3 }, () => '// helper support'),
  ]
  return `${lines.join('\n')}\n`
}

function exportedHelperWithTestCaseLines(count: number): string {
  const lines = [
    "import { expect, it } from 'vitest'",
    'export function helper(): void {}',
    "it('asserting token', () => { expect(true).toBe(true) })",
    ...Array.from({ length: count - 3 }, () => '// helper support'),
  ]
  return `${lines.join('\n')}\n`
}

function pythonTemplateFakeLines(count: number): string {
  const lines = [
    "payload = '''",
    'def test_fake():',
    '    assert True',
    "'''",
    ...Array.from({ length: count - 4 }, () => '# inert text'),
  ]
  return `${lines.join('\n')}\n`
}

function shellCommentFakeLines(count: number): string {
  return `${Array.from({ length: count }, () => '# assert_fake').join('\n')}\n`
}

function run(root: string): { code: number; output: string } {
  const result = spawnSync('bun', [checker, '--root', root], { encoding: 'utf8' })
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
}

describe('omp-build physical quality limits', () => {
  it('accepts 300 physical source lines across LF, CRLF, an empty file, and an unterminated final line', () => {
    const root = fixture()
    write(root, 'plugins/omp-build/empty.ts', '')
    write(root, 'plugins/omp-build/lf.ts', sourceLines(300, '\n'))
    write(root, 'plugins/omp-build/crlf.ts', sourceLines(300, '\r\n'))
    write(root, 'plugins/omp-build/unterminated.ts', sourceLines(300, '\n', false))

    expect(run(root)).toEqual({ code: 0, output: '' })
  })

  it('refuses 301-line sources even when test-shaped names, comments, templates, or test tokens try to disguise source or support code', () => {
    const root = fixture()
    write(root, 'plugins/omp-build/__fixtures__/source.test.ts', sourceLines(301, '\n'))
    write(root, 'plugins/omp-build/testing/helper.test.ts', sourceLines(301, '\n'))
    write(root, 'plugins/omp-build/testing/comment-disguised.test.ts', commentLines(301))
    write(root, 'plugins/omp-build/testing/template-disguised.test.ts', templateFakeLines(301))
    write(root, 'plugins/omp-build/testing/exported-helper.test.ts', exportedHelperWithEmptyTestLines(301))
    write(root, 'plugins/omp-build/testing/exported-helper-with-case.test.ts', exportedHelperWithTestCaseLines(301))
    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.output).toContain('__fixtures__/source.test.ts: 301 physical lines; source limit 300')
    expect(result.output).toContain('testing/helper.test.ts: 301 physical lines; source limit 300')
    expect(result.output).toContain('testing/comment-disguised.test.ts: 301 physical lines; source limit 300')
    expect(result.output).toContain('testing/template-disguised.test.ts: 301 physical lines; source limit 300')
    expect(result.output).toContain('testing/exported-helper.test.ts: 301 physical lines; source limit 300')
    expect(result.output).toContain('testing/exported-helper-with-case.test.ts: 301 physical lines; source limit 300')
  })
  it('accepts a genuine 600-line scenario and refuses the same scenario at 601', () => {
    const root = fixture()
    const path = 'plugins/omp-build/testing/quality.integration.test.ts'
    write(root, path, scenarioLines(600, '\n'))

    expect(run(root)).toEqual({ code: 0, output: '' })

    write(root, path, scenarioLines(601, '\n'))
    const result = run(root)
    expect(result.code).toBe(1)
    expect(result.output).toContain('testing/quality.integration.test.ts: 601 physical lines; scenario limit 600')
  })

  it('caps authored live configuration while inert JSON remains data', () => {
    const root = fixture()
    write(root, 'plugins/omp-build/package.json', sourceLines(301, '\n'))
    write(root, 'plugins/omp-build/.omp-plugin/plugin.json', sourceLines(301, '\n'))
    write(root, 'plugins/omp-build/skills/dev-review/review-classes.yml', sourceLines(301, '\n'))
    write(root, 'plugins/omp-build/skills/feature/__fixtures__/proof/records.json', jsonDataLines(601))
    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.output).toContain('plugins/omp-build/package.json: 301 physical lines; source limit 300')
    expect(result.output).toContain('plugins/omp-build/.omp-plugin/plugin.json: 301 physical lines; source limit 300')
    expect(result.output).toContain(
      'plugins/omp-build/skills/dev-review/review-classes.yml: 301 physical lines; source limit 300',
    )
    expect(result.output).not.toContain('records.json')
  })

  it('classifies type-only exports and valid assertion bindings as scenarios but keeps runtime ESM and CJS helpers at 300', () => {
    const root = fixture()
    write(
      root,
      'plugins/omp-build/testing/type-only.integration.test.ts',
      paddedLines(
        600,
        [
          "import { test } from 'node:test'",
          "import assert from 'node:assert'",
          'export type Marker = string',
          "test('type', () => assert.equal(1, 1))",
        ],
        '// scenario',
      ),
    )
    write(
      root,
      'plugins/omp-build/testing/namespace.integration.test.ts',
      paddedLines(
        600,
        [
          "import { test } from 'node:test'",
          "import * as assert from 'node:assert/strict'",
          "test('namespace', () => assert.equal(1, 1))",
        ],
        '// scenario',
      ),
    )
    write(
      root,
      'plugins/omp-build/testing/destructured.integration.test.cjs',
      paddedLines(
        600,
        [
          "const { test } = require('node:test')",
          "const { equal } = require('node:assert')",
          "test('destructured', () => equal(1, 1))",
        ],
        '// scenario',
      ),
    )

    expect(run(root)).toEqual({ code: 0, output: '' })

    write(
      root,
      'plugins/omp-build/hooks/exported-helper.cjs',
      paddedLines(
        301,
        [
          "const { test } = require('node:test')",
          "const assert = require('node:assert')",
          "test('helper', () => assert.equal(1, 1))",
          'module.exports = { helper() {} }',
        ],
        '// helper',
      ),
    )

    write(
      root,
      'plugins/omp-build/hooks/exports-helper.cjs',
      paddedLines(
        301,
        [
          "const { test } = require('node:test')",
          "const assert = require('node:assert')",
          "test('helper', () => assert.equal(1, 1))",
          'exports.helper = () => {}',
        ],
        '// helper',
      ),
    )
    const result = run(root)
    expect(result.code).toBe(1)
    expect(result.output).toContain('hooks/exported-helper.cjs: 301 physical lines; source limit 300')
    expect(result.output).toContain('hooks/exports-helper.cjs: 301 physical lines; source limit 300')
  })

  it('promotes bounded Python and shell assertion cases without promoting inert text', () => {
    const root = fixture()
    write(
      root,
      'plugins/omp-build/skills/python-test.py',
      paddedLines(600, ['def test_quality():', '    assert True'], '# scenario'),
    )
    write(
      root,
      'plugins/omp-build/skills/shell-test.sh',
      paddedLines(600, ['assert_eq() { [ "$1" = "$2" ]; }', 'assert_eq expected actual'], '# scenario'),
    )

    expect(run(root)).toEqual({ code: 0, output: '' })
  })

  it('refuses CJS, Python, and Bash sources above the shared 300-line limit without promoting inert counter-language text', () => {
    const root = fixture()
    write(root, 'plugins/omp-build/hooks/guard.cjs', sourceLines(301, '\n'))
    write(root, 'plugins/omp-build/skills/check.py', sourceLines(301, '\n'))
    write(root, 'plugins/omp-build/skills/template.py', pythonTemplateFakeLines(301))
    write(root, 'plugins/omp-build/skills/check.sh', sourceLines(301, '\n'))
    write(root, 'plugins/omp-build/skills/comment.sh', shellCommentFakeLines(301))
    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.output).toContain('hooks/guard.cjs: 301 physical lines; source limit 300')
    expect(result.output).toContain('skills/check.py: 301 physical lines; source limit 300')
    expect(result.output).toContain('skills/template.py: 301 physical lines; source limit 300')
    expect(result.output).toContain('skills/check.sh: 301 physical lines; source limit 300')
    expect(result.output).toContain('skills/comment.sh: 301 physical lines; source limit 300')
  })

  it('refuses a future helper inside the omp-build tools namespace at 301 lines', () => {
    const root = fixture()
    write(root, 'plugins/omp-build/runtime.ts', sourceLines(1, '\n'))
    write(root, 'tools/omp-build-quality/helpers/counter.ts', sourceLines(301, '\n'))
    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.output).toContain('tools/omp-build-quality/helpers/counter.ts: 301 physical lines; source limit 300')
  })

  it('ignores a symlink outside the exclusive omp-build tools namespace', () => {
    const root = fixture()
    write(root, 'plugins/omp-build/runtime.ts', sourceLines(1, '\n'))
    write(root, 'outside.ts', sourceLines(1, '\n'))
    symlinkSync(join(root, 'outside.ts'), join(root, 'tools/unrelated-link.ts'))

    expect(run(root)).toEqual({ code: 0, output: '' })
  })

  it('refuses a symlink inside the exclusive omp-build tools namespace', () => {
    const root = fixture()
    write(root, 'plugins/omp-build/runtime.ts', sourceLines(1, '\n'))
    write(root, 'outside.ts', sourceLines(1, '\n'))
    mkdirSync(join(root, 'tools/omp-build-quality'), { recursive: true })
    symlinkSync(join(root, 'outside.ts'), join(root, 'tools/omp-build-quality/link.ts'))
    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.output).toContain(
      'exclusive omp-build tool scope contains a symlink: tools/omp-build-quality/link.ts',
    )
  })

  it('excludes only generated root agents and dist outputs', () => {
    const root = fixture()
    write(root, 'plugins/omp-build/runtime.ts', sourceLines(1, '\n'))
    write(root, 'plugins/omp-build/agents/generated.ts', sourceLines(601, '\n'))
    write(root, 'plugins/omp-build/dist/generated.ts', sourceLines(601, '\n'))

    expect(run(root)).toEqual({ code: 0, output: '' })
  })

  it('fails when the expected plugin scope is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-build-quality-'))
    owned.add(root)
    mkdirSync(join(root, 'tools'), { recursive: true })
    write(root, 'tools/check-omp-build-quality.ts', 'export {}\n')
    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.output).toContain('expected plugins/omp-build directory is missing')
  })

  it('fails when the expected exclusive tool scope is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-build-quality-'))
    owned.add(root)
    write(root, 'plugins/omp-build/runtime.ts', sourceLines(1, '\n'))
    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.output).toContain('expected tools directory is missing')
  })
})
