import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The ### Filing block of fix/SKILL.md is the command operators paste. A bare
 * `skill://` argv yields "Module not found"; the fail-closed form must reach
 * triage (or REFUSE on a realpath miss without ever invoking bun).
 */
const FIX = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')
const TRIAGE = path.resolve(import.meta.dirname, '../../../../issue-triage/skills/issue-triage/triage.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function filingCommand(): string {
  const block = /### Filing[\s\S]*?```bash\n([\s\S]*?)```/.exec(FIX)?.[1]
  if (!block) throw new Error('### Filing bash block missing from fix/SKILL.md')
  // Match the create line whether or not it still uses the fail-closed form —
  // a bare `bun skill://…` regression must run and yield Module not found.
  const line = block
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /issue-triage\/triage\.ts/.test(l) && /\bcreate\b/.test(l))
  if (!line) throw new Error('Filing create line missing')
  return line.replace(/\s+\.\.\.\s*$/, '')
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
    const cmd = filingCommand().replaceAll('$FILE_DIR', fileDir)
    const result = spawnSync('bash', ['-c', cmd], {
      env: { PATH: `${bin}:${path.dirname(REAL_BUN)}:${process.env.PATH ?? ''}` },
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
    const cmd = filingCommand().replaceAll('$FILE_DIR', fileDir)
    const result = spawnSync('bash', ['-c', cmd], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.status).not.toBe(42)
    expect(() => readFileSync(marker, 'utf8')).toThrow()
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Module not found')
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/--title-file/)
  })
})
