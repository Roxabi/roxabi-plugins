import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Promote Step 9d is the pasteable finalize loop. A miss or empty verdict must
 * REFUSE (never `noop|*) break`); three iterations without noop must REFUSE
 * convergence; refuse/create-release paths are exercised (#619).
 */
const SKILL = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')

function extract9d(): string {
  const m = /\*\*9d\.\*\*[\s\S]*?```bash\n([\s\S]*?)```/.exec(SKILL)
  if (!m) throw new Error('9d bash block missing from promote/SKILL.md')
  return m[1]
}

/** Step 7 create-promote-pr fence — extract by fence boundaries only. */
function extractStep7(): string {
  const m = /## Step 7[^\n]*\n[\s\S]*?```bash\n([\s\S]*?)```/.exec(SKILL)
  if (!m) throw new Error('step-7 bash fence missing from promote/SKILL.md')
  return m[1]
}

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

type Verdict = { body: string; exit?: number }

type Scenario = {
  realpathOk: boolean
  /** Verdicts returned by bun finalize, one per loop iteration. */
  verdicts: Verdict[]
  logGitGh?: boolean
}

function runLoop(scenario: Scenario) {
  root = mkdtempSync(path.join(tmpdir(), 'omp-finalize-loop-'))
  const bin = path.join(root, 'bin')
  const verdictDir = path.join(root, 'verdicts')
  const logFile = path.join(root, 'commands.log')
  const finalizePath = path.join(root, 'finalize.ts')
  const idxFile = path.join(root, 'idx')
  mkdirSync(bin)
  mkdirSync(verdictDir)
  for (const [i, v] of scenario.verdicts.entries()) {
    const body = v.body.endsWith('\n') ? v.body : `${v.body}\n`
    writeFileSync(path.join(verdictDir, `${i}.txt`), body)
    writeFileSync(path.join(verdictDir, `${i}.exit`), String(v.exit ?? 0))
  }

  writeFileSync(
    path.join(bin, 'realpath'),
    scenario.realpathOk
      ? `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' ${JSON.stringify(finalizePath)}
`
      : `#!/usr/bin/env bash
echo "realpath: $1: No such file or directory" >&2
exit 1
`,
    { mode: 0o755 },
  )
  writeFileSync(finalizePath, 'throw new Error("stub bun should intercept")\n')

  writeFileSync(
    path.join(bin, 'bun'),
    `#!/usr/bin/env bash
set -euo pipefail
EXPECTED=${JSON.stringify(finalizePath)}
if [ "\${1-}" != "$EXPECTED" ]; then
  echo "bun stub: expected argv1=$EXPECTED got=\${1-}" >&2
  exit 99
fi
DIR=${JSON.stringify(verdictDir)}
IDX_FILE=${JSON.stringify(idxFile)}
idx=$(cat "$IDX_FILE" 2>/dev/null || echo 0)
printf '%s' "$((idx + 1))" > "$IDX_FILE"
f="$DIR/$idx.txt"
e="$DIR/$idx.exit"
if [ -f "$f" ]; then cat "$f"; else printf 'action=tag\\n'; fi
exit $(cat "$e" 2>/dev/null || echo 0)
`,
    { mode: 0o755 },
  )

  const logLine = scenario.logGitGh ? `printf '%s\\n' "git $*" >> ${JSON.stringify(logFile)}\n` : ''
  writeFileSync(
    path.join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
${logLine}if [[ "\${1-}" == rev-list ]]; then exit 0; fi
exit 0
`,
    { mode: 0o755 },
  )

  const ghLog = scenario.logGitGh ? `printf '%s\\n' "gh $*" >> ${JSON.stringify(logFile)}\n` : ''
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
${ghLog}if [[ "\${1-}" == release && "\${2-}" == view ]]; then exit 1; fi
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

  const result = spawnSync('bash', [scriptPath], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  })
  return { result, logFile, finalizePath, idxFile }
}

describe('promote 9d finalize loop', () => {
  it('REFUSEs when finalize cannot resolve', () => {
    const { result: r } = runLoop({ realpathOk: false, verdicts: [{ body: 'action=noop' }] })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/REFUSE: cannot resolve/)
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/finalized/)
  })

  it('REFUSEs empty stdout (unknown action)', () => {
    const { result: r } = runLoop({ realpathOk: true, verdicts: [{ body: '' }] })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/REFUSE: empty or unknown/)
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/finalized/)
  })

  it('REFUSEs when three iterations never reach noop', () => {
    const { result: r } = runLoop({
      realpathOk: true,
      verdicts: [{ body: 'action=tag' }, { body: 'action=tag' }, { body: 'action=tag' }],
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/REFUSE: finalize did not converge/)
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/finalized/)
  })

  it('exits 0 and prints finalized on action=noop', () => {
    const { result: r } = runLoop({ realpathOk: true, verdicts: [{ body: 'action=noop' }] })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Release kit\/v1\.0\.0 finalized/)
  })

  it('REFUSEs action=refuse with the reason, no tag/push/release, one finalize call', () => {
    const {
      result: r,
      logFile,
      idxFile,
    } = runLoop({
      realpathOk: true,
      logGitGh: true,
      verdicts: [{ body: 'action=refuse\nreason=X', exit: 1 }],
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/REFUSE: X/)
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/finalized/)
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    expect(log).not.toMatch(/git tag/)
    expect(log).not.toMatch(/git push/)
    expect(log).not.toMatch(/gh release create/)
    expect(readFileSync(idxFile, 'utf8')).toBe('1')
  })

  it('walks tag → push → create-release → noop in order and passes the resolved path to bun', () => {
    const { result: r, logFile } = runLoop({
      realpathOk: true,
      logGitGh: true,
      verdicts: [{ body: 'action=tag' }, { body: 'action=create-release' }, { body: 'action=noop' }],
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Release kit\/v1\.0\.0 finalized/)
    const log = readFileSync(logFile, 'utf8').trim().split('\n')
    const tagIdx = log.findIndex((l) => /^git tag -a /.test(l))
    const pushIdx = log.findIndex((l) => /^git push origin /.test(l))
    const relIdx = log.findIndex((l) => /^gh release create /.test(l))
    expect(tagIdx).toBeGreaterThanOrEqual(0)
    expect(pushIdx).toBeGreaterThan(tagIdx)
    expect(relIdx).toBeGreaterThan(pushIdx)
  })
})

describe('promote step 7 create-promote-pr', () => {
  it('propagates the stub exit code after rm -f (PR_RC) without runner errexit', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-step7-'))
    const bin = path.join(root, 'bin')
    const tmpDir = path.join(root, 'tmp')
    mkdirSync(bin)
    mkdirSync(tmpDir)
    const scriptPath = path.join(root, 'create-promote-pr.sh')
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 3\n', { mode: 0o755 })
    writeFileSync(
      path.join(bin, 'realpath'),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' ${JSON.stringify(scriptPath)}
`,
      { mode: 0o755 },
    )
    const block = extractStep7()
    // No `set -e`: the OMP shell runs with errexit off; PR_RC must carry the
    // stub exit past `rm -f` to the gate. Keep `set -u` for unbound names.
    const runner = `#!/usr/bin/env bash
set -u
VERSION=kit/v1.0.0
${block}
`
    const runPath = path.join(root, 'run-step7.sh')
    writeFileSync(runPath, runner, { mode: 0o755 })
    const r = spawnSync('bash', [runPath], {
      env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir },
      encoding: 'utf8',
    })
    expect(r.status).toBe(3)
    // BODY_FILE was created under TMPDIR and must be gone after rm -f.
    expect(readdirSync(tmpDir)).toEqual([])
  })
})
