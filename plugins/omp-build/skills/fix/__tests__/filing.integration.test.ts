import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The ### Filing block of fix/SKILL.md is the command operators paste. A bare
 * `skill://` argv yields "Module not found"; the realpath form must reach
 * triage and surface triage's own --title-file error instead (#619 RC-3).
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
  // The SKILL ends the template with `...` for elided flags — drop it for bash.
  return line.replace(/\s+\.\.\.\s*$/, '')
}

describe('fix Filing command', () => {
  it('reaches triage through a realpath stub and surfaces --title-file, not Module not found', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-fix-filing-'))
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'realpath'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "skill://issue-triage/triage.ts" ]; then
  printf '%s\\n' ${JSON.stringify(TRIAGE)}
  exit 0
fi
exec /usr/bin/realpath "$@"
`,
      { mode: 0o755 },
    )

    const fileDir = path.join(root, 'files')
    mkdirSync(fileDir)
    // Deliberately omit title.txt / body.md so triage owns the failure mode.
    const cmd = filingCommand().replaceAll('$FILE_DIR', fileDir)
    const result = spawnSync('bash', ['-c', cmd], {
      env: {
        PATH: `${bin}:${path.dirname(REAL_BUN)}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    })
    const combined = `${result.stdout}\n${result.stderr}`
    expect(result.status).not.toBe(0)
    expect(combined).toMatch(/--title-file cannot read/)
    expect(combined).not.toContain('Module not found')
  })
})
