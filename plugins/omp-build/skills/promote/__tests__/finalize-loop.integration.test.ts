import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Promote Step 9d is the pasteable finalize loop. A miss or empty verdict must
 * REFUSE (never `noop|*) break`); three iterations without noop must REFUSE
 * convergence (#619).
 */
const SKILL = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')

function extract9d(): string {
  const m = /\*\*9d\.\*\*[\s\S]*?```bash\n([\s\S]*?)```/.exec(SKILL)
  if (!m) throw new Error('9d bash block missing from promote/SKILL.md')
  return m[1]
}

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

type Scenario = {
  realpathOk: boolean
  /** Verdicts returned by bun finalize, one per loop iteration. */
  verdicts: string[]
}

function runLoop(scenario: Scenario) {
  root = mkdtempSync(path.join(tmpdir(), 'omp-finalize-loop-'))
  const bin = path.join(root, 'bin')
  const verdictDir = path.join(root, 'verdicts')
  mkdirSync(bin)
  mkdirSync(verdictDir)
  for (const [i, v] of scenario.verdicts.entries()) {
    writeFileSync(path.join(verdictDir, `${i}.txt`), v.endsWith('\n') ? v : `${v}\n`)
  }

  writeFileSync(
    path.join(bin, 'realpath'),
    scenario.realpathOk
      ? `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' ${JSON.stringify(path.join(root, 'finalize.ts'))}
`
      : `#!/usr/bin/env bash
echo "realpath: $1: No such file or directory" >&2
exit 1
`,
    { mode: 0o755 },
  )
  writeFileSync(path.join(root, 'finalize.ts'), 'throw new Error("stub bun should intercept")\n')

  writeFileSync(
    path.join(bin, 'bun'),
    `#!/usr/bin/env bash
set -euo pipefail
DIR=${JSON.stringify(verdictDir)}
IDX_FILE=${JSON.stringify(path.join(root, 'idx'))}
idx=$(cat "$IDX_FILE" 2>/dev/null || echo 0)
printf '%s' "$((idx + 1))" > "$IDX_FILE"
f="$DIR/$idx.txt"
if [ -f "$f" ]; then cat "$f"; else printf 'action=tag\\n'; fi
`,
    { mode: 0o755 },
  )

  writeFileSync(
    path.join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
# rev-list -n1 "$VERSION" → empty (tag absent) so TAG_STATE=absent
if [[ "\${1-}" == rev-list ]]; then exit 0; fi
exit 0
`,
    { mode: 0o755 },
  )

  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1-}" == release && "\${2-}" == view ]]; then exit 1; fi
exit 0
`,
    { mode: 0o755 },
  )

  const script = `#!/usr/bin/env bash
set -euo pipefail
VERSION=kit/v1.0.0
M=abc123
PARENT_COUNT=2
IS_PROMOTE=true
DERIVED=1.0.0
BASE=0.9.0
TITLE_V=1.0.0
HEADING_V=1.0.0
FILE_V=1.0.0
CHANGELOG_CONTENT='notes'
ACTION=
${extract9d()}
printf 'Release %s finalized\\n' "$VERSION"
`
  const scriptPath = path.join(root, 'run-9d.sh')
  writeFileSync(scriptPath, script, { mode: 0o755 })

  return spawnSync('bash', [scriptPath], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  })
}

describe('promote 9d finalize loop', () => {
  it('REFUSEs when finalize cannot resolve', () => {
    const r = runLoop({ realpathOk: false, verdicts: ['action=noop'] })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/REFUSE: cannot resolve/)
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/finalized/)
  })

  it('REFUSEs empty stdout (unknown action)', () => {
    const r = runLoop({ realpathOk: true, verdicts: [''] })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/REFUSE: empty or unknown/)
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/finalized/)
  })

  it('REFUSEs when three iterations never reach noop', () => {
    const r = runLoop({
      realpathOk: true,
      verdicts: ['action=tag', 'action=tag', 'action=tag'],
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/REFUSE: finalize did not converge/)
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/finalized/)
  })

  it('exits 0 and prints finalized on action=noop', () => {
    const r = runLoop({ realpathOk: true, verdicts: ['action=noop'] })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Release kit\/v1\.0\.0 finalized/)
  })
})
