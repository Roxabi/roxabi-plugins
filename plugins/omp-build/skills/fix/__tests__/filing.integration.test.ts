import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The ### Filing fenced block (after `# write … then:`) is what operators paste.
 * Run the whole trailing block so a multi-line fail-closed form stays green and
 * a newline fail-open form reaches bun on a miss (#619).
 */
const FIX = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')
const TRIAGE = path.resolve(import.meta.dirname, '../../../../issue-triage/skills/issue-triage/triage.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Body of the Filing ```bash fence after the `# write … then:` comment. */
function filingBlockAfterWrite(): string {
  const block = /### Filing[\s\S]*?```bash\n([\s\S]*?)```/.exec(FIX)?.[1]
  if (!block) throw new Error('### Filing bash block missing from fix/SKILL.md')
  const lines = block.split('\n')
  const idx = lines.findIndex((l) => /#\s*write\b.*\bthen\s*:/.test(l))
  if (idx < 0) throw new Error('Filing "# write … then:" marker missing')
  const tail = lines
    .slice(idx + 1)
    .join('\n')
    .replace(/\s+\.\.\.\s*$/, '')
    .trim()
  if (!tail) throw new Error('Filing block empty after write marker')
  return tail
}

function writeRealpathStub(bin: string, ok: boolean) {
  writeFileSync(
    path.join(bin, 'realpath'),
    ok
      ? `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "skill://issue-triage/triage.ts" ]; then
  printf '%s\\n' ${JSON.stringify(TRIAGE)}
  exit 0
fi
exec /usr/bin/realpath "$@"
`
      : `#!/usr/bin/env bash
echo "realpath: $1: No such file or directory" >&2
exit 1
`,
    { mode: 0o755 },
  )
}

describe('fix Filing command', () => {
  it('reaches triage through a realpath stub and surfaces --title-file, not Module not found', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-fix-filing-'))
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeRealpathStub(bin, true)

    const fileDir = path.join(root, 'files')
    mkdirSync(fileDir)
    const result = spawnSync('bash', ['-c', filingBlockAfterWrite()], {
      env: {
        PATH: `${bin}:${path.dirname(REAL_BUN)}:${process.env.PATH ?? ''}`,
        FILE_DIR: fileDir,
      },
      encoding: 'utf8',
    })
    const combined = `${result.stdout}\n${result.stderr}`
    expect(result.status).not.toBe(0)
    expect(combined).toMatch(/--title-file cannot read/)
    expect(combined).not.toContain('Module not found')
  })

  it('exits non-zero on a realpath miss and never reaches triage', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-fix-filing-miss-'))
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeRealpathStub(bin, false)
    const marker = path.join(root, 'bun-ran')
    writeFileSync(
      path.join(bin, 'bun'),
      `#!/usr/bin/env bash
printf 'ran\\n' > ${JSON.stringify(marker)}
exit 42
`,
      { mode: 0o755 },
    )

    const fileDir = path.join(root, 'files')
    mkdirSync(fileDir)
    const result = spawnSync('bash', ['-c', filingBlockAfterWrite()], {
      env: { PATH: `${bin}:/usr/bin:/bin`, FILE_DIR: fileDir },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.status).not.toBe(42)
    expect(() => readFileSync(marker, 'utf8')).toThrow()
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Module not found')
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/--title-file/)
  })
})
