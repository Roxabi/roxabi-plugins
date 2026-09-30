import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'ci-watch.sh')

function classifyMerge(...args: string[]): string {
  return execFileSync(SCRIPT, ['--classify-merge-state', ...args], { encoding: 'utf8' }).trim()
}

function classifyChecks(json: string): string {
  return execFileSync(SCRIPT, ['--classify-checks'], { encoding: 'utf8', input: json }).trim()
}

function checksOf(rollup: unknown[]): string {
  return execFileSync(SCRIPT, ['--checks-of'], {
    encoding: 'utf8',
    input: JSON.stringify({ statusCheckRollup: rollup }),
  })
}

function classifyRollup(rollup: unknown[]): string {
  return execFileSync(SCRIPT, ['--classify-checks'], { encoding: 'utf8', input: checksOf(rollup) }).trim()
}

function exitOf(args: string[]): number {
  try {
    execFileSync(SCRIPT, args, { encoding: 'utf8' })
    return 0
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return error.status
    throw error
  }
}

describe('non-verdict exits', () => {
  it('an unknown flag exits 70', () => {
    expect(exitOf(['7', '--nope'])).toBe(70)
  })

  it('a bogus merge mode exits 70', () => {
    expect(exitOf(['7', '--merge-mode', 'bogus', '--repo', 'acme/app'])).toBe(70)
  })

  it('a bad timeout exits 70', () => {
    expect(exitOf(['7', '--timeout', 'bogus', '--repo', 'acme/app'])).toBe(70)
  })

  it('--since without a value exits 70', () => {
    expect(exitOf(['7', '--repo', 'acme/app', '--since'])).toBe(70)
  })

  it.each(['--timeout', '--interval', '--merge-mode', '--repo'] as const)(
    '%s without a value exits 70, not the FAIL code',
    (flag) => {
      expect(exitOf(['7', flag])).toBe(70)
    },
  )

  it('--since that is not a UTC second exits 70', () => {
    expect(exitOf(['7', '--since', '2026-09-29T10:00:00.123Z', '--repo', 'acme/app'])).toBe(70)
  })

  it('no PR exits 70', () => {
    expect(exitOf([])).toBe(70)
  })

  it('a missing jq on PATH exits 70', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-no-jq-'))
    // Symlink bash/gh/bun into an otherwise empty PATH — no jq. Assert the
    // specific stderr so a later gh failure cannot satisfy this test.
    for (const cmd of ['bash', 'gh', 'bun'] as const) {
      const real = execFileSync('/bin/bash', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' }).trim()
      execFileSync('/bin/ln', ['-s', real, join(dir, cmd)])
    }
    try {
      execFileSync(SCRIPT, ['7', '--repo', 'acme/app'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: dir },
      })
      expect.unreachable('expected exit 70')
    } catch (error) {
      const failed = error as { status?: number; stderr?: string }
      expect(failed.status).toBe(70)
      expect(String(failed.stderr ?? '')).toContain("'jq' is required but not found on PATH")
    }
  })
})

describe('classify-merge-state', () => {
  it('maps a deadline to exit 5', () => {
    expect(classifyMerge('OPEN', 'BLOCKED', 'merge-on-green', 'true', '1800', '1800')).toBe('5')
  })

  it('maps a revoked reviewed label under merge-on-green to exit 4', () => {
    expect(classifyMerge('OPEN', 'CLEAN', 'merge-on-green', 'false', '10', '1800')).toBe('4')
  })

  it('maps merged to exit 0, ahead of the deadline', () => {
    expect(classifyMerge('MERGED', 'UNKNOWN', 'merge-on-green', 'false', '9999', '1800')).toBe('0')
  })

  it('keeps watching transient merge states', () => {
    for (const mss of ['BEHIND', 'BLOCKED', 'UNSTABLE']) {
      expect(classifyMerge('OPEN', mss, 'merge-on-green', 'true', '10', '1800')).toBe('WATCH')
    }
  })

  it('treats native with no auto-merge as nothing to watch', () => {
    expect(classifyMerge('OPEN', 'CLEAN', 'native', 'false', '10', '1800')).toBe('0')
  })
})

describe('classify-checks', () => {
  it('treats skipped and neutral as passing, and pending outranks them', () => {
    expect(classifyChecks('[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]')).toBe('GREEN')
    expect(classifyChecks('[{"name":"ci","status":"COMPLETED","conclusion":"SKIPPED"}]')).toBe('GREEN')
    expect(classifyChecks('[{"name":"ci","status":"COMPLETED","conclusion":"Skipped"}]')).toBe('GREEN')
    expect(
      classifyChecks(
        '[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"lint","status":"COMPLETED","conclusion":"NEUTRAL"}]',
      ),
    ).toBe('GREEN')
    expect(
      classifyChecks(
        '[{"name":"ci","status":"IN_PROGRESS","conclusion":""},{"name":"Update behind PRs","status":"COMPLETED","conclusion":"SKIPPED"}]',
      ),
    ).toBe('PENDING')
    expect(
      classifyChecks(
        '[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"scan","status":"COMPLETED","conclusion":"FAILURE"}]',
      ),
    ).toBe('FAIL')
    expect(classifyChecks('[{"name":"ci","status":"IN_PROGRESS","conclusion":""}]')).toBe('PENDING')
    expect(classifyChecks('[]')).toBe('PENDING')
  })
})

describe('checks-of', () => {
  it('normalises each commit-status state and leaves a check run unchanged', () => {
    expect(JSON.parse(checksOf([{ context: 'ci', state: 'SUCCESS' }]))).toEqual([
      { name: 'ci', status: 'completed', conclusion: 'success' },
    ])
    expect(classifyRollup([{ context: 'ci', state: 'SUCCESS' }])).toBe('GREEN')
    expect(JSON.parse(checksOf([{ context: 'ci', state: 'PENDING' }]))).toEqual([
      { name: 'ci', status: 'in_progress', conclusion: '' },
    ])
    expect(classifyRollup([{ context: 'ci', state: 'PENDING' }])).toBe('PENDING')
    expect(JSON.parse(checksOf([{ context: 'ci', state: 'EXPECTED' }]))).toEqual([
      { name: 'ci', status: 'in_progress', conclusion: '' },
    ])
    expect(classifyRollup([{ context: 'ci', state: 'EXPECTED' }])).toBe('PENDING')
    expect(JSON.parse(checksOf([{ context: 'ci', state: 'FAILURE' }]))).toEqual([
      { name: 'ci', status: 'completed', conclusion: 'failure' },
    ])
    expect(classifyRollup([{ context: 'ci', state: 'FAILURE' }])).toBe('FAIL')
    expect(JSON.parse(checksOf([{ context: 'ci', state: 'ERROR' }]))).toEqual([
      { name: 'ci', status: 'completed', conclusion: 'failure' },
    ])
    expect(classifyRollup([{ context: 'ci', state: 'ERROR' }])).toBe('FAIL')
    expect(JSON.parse(checksOf([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]))).toEqual([
      { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ])
  })

  it('keeps a pending commit status ahead of a successful check run', () => {
    expect(
      classifyRollup([
        { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { context: 'coverage', state: 'PENDING' },
      ]),
    ).toBe('PENDING')
  })

  it('keeps an unmapped commit-status state as a non-empty conclusion', () => {
    expect(JSON.parse(checksOf([{ context: 'coverage', state: 'BLOCKED' }]))).toEqual([
      { name: 'coverage', status: 'completed', conclusion: 'BLOCKED' },
    ])
    expect(classifyRollup([{ context: 'coverage', state: 'BLOCKED' }])).toBe('OTHER')
  })

  it('keeps the newest run per workflow+name — a green re-run outranks a stale cancel', () => {
    expect(
      JSON.parse(
        checksOf([
          {
            name: 'Validate PR Title',
            status: 'COMPLETED',
            conclusion: 'CANCELLED',
            workflowName: 'PR',
            startedAt: '2026-09-29T10:00:00Z',
          },
          {
            name: 'Validate PR Title',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            workflowName: 'PR',
            startedAt: '2026-09-29T10:00:05Z',
          },
        ]),
      ),
    ).toEqual([{ name: 'Validate PR Title', status: 'COMPLETED', conclusion: 'SUCCESS' }])
    expect(
      classifyRollup([
        {
          name: 'Validate PR Title',
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          workflowName: 'PR',
          startedAt: '2026-09-29T10:00:00Z',
        },
        {
          name: 'Validate PR Title',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          workflowName: 'PR',
          startedAt: '2026-09-29T10:00:05Z',
        },
      ]),
    ).toBe('GREEN')
  })

  it('ranks an in-progress re-run ahead of a completed stale cancel', () => {
    expect(
      classifyRollup([
        {
          name: 'ci',
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          workflowName: 'CI',
          startedAt: '2026-09-29T10:00:00Z',
        },
        {
          name: 'ci',
          status: 'IN_PROGRESS',
          conclusion: '',
          workflowName: 'CI',
          startedAt: '2026-09-29T10:00:05Z',
        },
      ]),
    ).toBe('PENDING')
  })
})

describe('watch with a stubbed gh', () => {
  function fakeGh(dir: string, body: string): void {
    const path = join(dir, 'gh')
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }

  it('CLOSED during the check phase exits 4, not the deadline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-closed-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
cat <<'EOF'
{"state":"CLOSED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"IN_PROGRESS","conclusion":""}]}
EOF
`,
    )
    const result = runWatch(dir, {}, undefined, '2s', 'native')
    expect(result.code).toBe(4)
    expect(result.stdout.trim()).toBe('closed')
  })

  it('a leading-zero timeout is decimal — 09 seconds still deadlines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-octal-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":{"enabledAt":"t"},"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"IN_PROGRESS","conclusion":""}]}
EOF
`,
    )
    // Without 10#, bash reads 09 as invalid octal inside (( )), the deadline never
    // fires, and the watch would hang. With the fix it exits 5 after ~9s.
    const result = runWatch(dir, {}, undefined, '09', 'native')
    expect(result.code).toBe(5)
  })

  it('sees a late run that appears after a green poll, then the merge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
state="$HOME/.ci-watch-stub-$$"
# one counter shared by this test via CI_WATCH_STUB
n=0
if [[ -f "$CI_WATCH_COUNT" ]]; then n=$(cat "$CI_WATCH_COUNT"); fi
n=$((n + 1))
echo "$n" > "$CI_WATCH_COUNT"
if [[ "$n" -eq 1 ]]; then
  cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]}
EOF
elif [[ "$n" -eq 2 ]]; then
  cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"scan","status":"IN_PROGRESS","conclusion":""}]}
EOF
else
  cat <<'EOF'
{"state":"MERGED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"scan","status":"COMPLETED","conclusion":"SUCCESS"}]}
EOF
fi
`,
    )
    const count = join(dir, 'count')
    const out = execFileSync(
      SCRIPT,
      ['7', '--interval', '0', '--timeout', '30s', '--merge-mode', 'merge-on-green', '--repo', 'acme/app'],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CI_WATCH_COUNT: count },
      },
    )
    expect(out).toContain('merged')
  })

  it('exits 1 when a check failed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-fail-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "run" ]]; then exit 0; fi
cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"FAILURE"}]}
EOF
`,
    )
    let code = 0
    try {
      execFileSync(
        SCRIPT,
        ['7', '--interval', '0', '--timeout', '30s', '--merge-mode', 'merge-on-green', '--repo', 'acme/app'],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        },
      )
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
        code = error.status
      }
    }
    expect(code).toBe(1)
  })

  /** `mode: null` passes no `--merge-mode`, so the script resolves it from `cwd`. */
  function runWatch(
    dir: string,
    extraEnv: Record<string, string> = {},
    cwd?: string,
    timeout = '30s',
    mode: string | null = 'merge-on-green',
    extra: string[] = [],
  ) {
    const modeArgs = mode === null ? [] : ['--merge-mode', mode]
    const args = ['7', '--interval', '0', '--timeout', timeout, ...modeArgs, '--repo', 'acme/app', ...extra]
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...extraEnv }
    try {
      const stdout = execFileSync(SCRIPT, args, { encoding: 'utf8', env, cwd })
      return { code: 0, stdout, stderr: '' }
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
        const failed = error as { status: number; stdout?: string; stderr?: string }
        return { code: failed.status, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
      }
      throw error
    }
  }

  it('keeps polling a skipped run beside an in-progress check, then enters the merge phase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-skip-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" ]]; then echo '{"check_runs":[]}'; exit 0; fi
n=0
if [[ -f "$CI_WATCH_COUNT" ]]; then n=$(cat "$CI_WATCH_COUNT"); fi
n=$((n + 1))
echo "$n" > "$CI_WATCH_COUNT"
if [[ "$n" -eq 1 ]]; then
  cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"IN_PROGRESS","conclusion":""},{"name":"Update behind PRs","status":"COMPLETED","conclusion":"SKIPPED"}]}
EOF
elif [[ "$n" -eq 2 ]]; then
  cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"Update behind PRs","status":"COMPLETED","conclusion":"SKIPPED"}]}
EOF
else
  cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"DIRTY","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"Update behind PRs","status":"COMPLETED","conclusion":"SKIPPED"}]}
EOF
fi
`,
    )
    const count = join(dir, 'count')
    const result = runWatch(dir, { CI_WATCH_COUNT: count }, undefined, '2s')
    expect(result.code).toBe(4)
    expect(readFileSync(count, 'utf8').trim()).toBe('4')
  })

  it('treats a skipped check named in landing.required_checks as green', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-req-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ci-watch-req-cwd-'))
    mkdirSync(join(cwd, '.dev'))
    writeFileSync(join(cwd, '.dev', 'stack.yml'), 'landing:\n  required_checks:\n    - lint\n')
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" ]]; then echo '{"check_runs":[]}'; exit 0; fi
n=0
if [[ -f "$CI_WATCH_COUNT" ]]; then n=$(cat "$CI_WATCH_COUNT"); fi
n=$((n + 1))
echo "$n" > "$CI_WATCH_COUNT"
if [[ "$n" -le 2 ]]; then
  cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"lint","status":"COMPLETED","conclusion":"SKIPPED"},{"name":"scan","status":"COMPLETED","conclusion":"FAILURE"}]}
EOF
else
  cat <<'EOF'
{"state":"MERGED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[{"name":"lint","status":"COMPLETED","conclusion":"SKIPPED"}]}
EOF
fi
`,
    )
    const count = join(dir, 'count')
    const result = runWatch(dir, { CI_WATCH_COUNT: count }, cwd)
    expect(result.code).toBe(0)
    expect(readFileSync(count, 'utf8').trim()).toBe('3')
  })

  it('exits 1 naming the failed check and not the skipped one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-fail-skip-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "run" ]]; then exit 0; fi
cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"FAILURE"},{"name":"Update behind PRs","status":"COMPLETED","conclusion":"SKIPPED"}]}
EOF
`,
    )
    const result = runWatch(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ci=FAILURE')
    expect(result.stderr).not.toContain('Update behind PRs')
  })

  it('exits 1 naming the failure when run list fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-run-list-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "run" && "$2" == "list" ]]; then exit 1; fi
if [[ "$1" == "run" ]]; then exit 0; fi
cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"FAILURE"}]}
EOF
`,
    )
    const result = runWatch(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ci=FAILURE')
    expect(result.stderr).toContain('failed-run logs unavailable')
  })

  it('exits 2 naming a cancelled check beside a skipped one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-cancel-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"CANCELLED"},{"name":"Update behind PRs","status":"COMPLETED","conclusion":"SKIPPED"}]}
EOF
`,
    )
    const result = runWatch(dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('ci=CANCELLED')
    expect(result.stderr).not.toContain('Update behind PRs')
  })

  it('treats a neutral check named in landing.required_checks as green', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-neutral-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ci-watch-neutral-cwd-'))
    mkdirSync(join(cwd, '.dev'))
    writeFileSync(join(cwd, '.dev', 'stack.yml'), 'landing:\n  required_checks:\n    - lint\n')
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" ]]; then echo '{"check_runs":[]}'; exit 0; fi
n=0
if [[ -f "$CI_WATCH_COUNT" ]]; then n=$(cat "$CI_WATCH_COUNT"); fi
n=$((n + 1))
echo "$n" > "$CI_WATCH_COUNT"
if [[ "$n" -le 2 ]]; then
  cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"lint","status":"COMPLETED","conclusion":"NEUTRAL"},{"name":"scan","status":"COMPLETED","conclusion":"FAILURE"}]}
EOF
else
  cat <<'EOF'
{"state":"MERGED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[{"name":"lint","status":"COMPLETED","conclusion":"NEUTRAL"}]}
EOF
fi
`,
    )
    const count = join(dir, 'count')
    const result = runWatch(dir, { CI_WATCH_COUNT: count }, cwd)
    expect(result.code).toBe(0)
    expect(readFileSync(count, 'utf8').trim()).toBe('3')
  })

  it('exits 3 naming each offending check and conclusion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-other-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"Update behind PRs","status":"COMPLETED","conclusion":"SKIPPED"},{"name":"rules","status":"COMPLETED","conclusion":"ACTION_REQUIRED"},{"name":"policy","status":"COMPLETED","conclusion":"STALE"}]}
EOF
`,
    )
    const result = runWatch(dir)
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('rules=ACTION_REQUIRED')
    expect(result.stderr).toContain('policy=STALE')
    expect(result.stderr).not.toContain('ci=SUCCESS')
    expect(result.stderr).not.toContain('Update behind PRs=SKIPPED')
  })

  it('exits 3 naming a commit status with its state, never an empty conclusion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-status-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":null,"labels":[{"name":"reviewed"}],"headRefOid":"abc","statusCheckRollup":[{"context":"coverage","state":"BLOCKED"}]}
EOF
`,
    )
    const result = runWatch(dir)
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('coverage=BLOCKED')
    expect(
      result.stderr
        .split('\n')
        .filter((line) => line.length > 0)
        .every((line) => !line.endsWith('=')),
    ).toBe(true)
  })

  it('exits 70 when gh returns malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-bad-json-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
echo '{'
`,
    )
    const result = runWatch(dir)
    expect(result.code).toBe(70)
    expect([1, 2, 3, 4, 5]).not.toContain(result.code)
  })

  it('exits 70 when gh returns an empty snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-empty-'))
    fakeGh(
      dir,
      `#!/usr/bin/env bash
exit 0
`,
    )
    const started = Date.now()
    const result = runWatch(dir, {}, undefined, '2s')
    expect(result.code).toBe(70)
    expect(result.stderr).toContain('empty gh pr view')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('with no --merge-mode, a checkout holding only merge-on-green.yml watches in merge-on-green mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-mog-file-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ci-watch-mog-file-cwd-'))
    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(cwd, '.github', 'workflows', 'merge-on-green.yml'), 'name: merge-on-green\n')
    // No `reviewed` label but auto-merge armed: merge-on-green says not eligible (4),
    // native would keep watching until the MERGED snapshot (0).
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" ]]; then echo '{"check_runs":[]}'; exit 0; fi
n=0
if [[ -f "$CI_WATCH_COUNT" ]]; then n=$(cat "$CI_WATCH_COUNT"); fi
n=$((n + 1))
echo "$n" > "$CI_WATCH_COUNT"
if [[ "$n" -le 3 ]]; then
  cat <<'EOF'
{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":{"mergeMethod":"MERGE"},"labels":[],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]}
EOF
else
  cat <<'EOF'
{"state":"MERGED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]}
EOF
fi
`,
    )
    const result = runWatch(dir, { CI_WATCH_COUNT: join(dir, 'count') }, cwd, '30s', null)
    expect(result.code).toBe(4)
  })

  it('exits 70 naming the problem when .dev/stack.yml is not valid YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-bad-stack-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ci-watch-bad-stack-cwd-'))
    mkdirSync(join(cwd, '.dev'))
    writeFileSync(join(cwd, '.dev', 'stack.yml'), 'landing: [unclosed\n')
    const log = join(dir, 'gh.log')
    fakeGh(
      dir,
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
cat <<'EOF'
{"state":"MERGED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[]}
EOF
`,
    )
    const result = runWatch(dir, {}, cwd)
    expect(result.code).toBe(70)
    expect(result.stderr).toContain('not valid YAML')
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('')
  })

  it('--since that is not a UTC second exits 70 with no gh call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-since-frac-'))
    const log = join(dir, 'gh.log')
    fakeGh(
      dir,
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
cat <<'EOF'
{"state":"MERGED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[]}
EOF
`,
    )
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', '2026-09-29T10:00:00.123Z'])
    expect(result.code).toBe(70)
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('')
  })

  it('--since without a value exits 70 with no gh call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-since-missing-'))
    const log = join(dir, 'gh.log')
    fakeGh(
      dir,
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
cat <<'EOF'
{"state":"MERGED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[]}
EOF
`,
    )
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since'])
    expect(result.code).toBe(70)
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('')
  })

  // Stub gh for the evaluate-only probe. `pr view` walks `snapshots`, the
  // check-runs lookup walks `runs` (each clamped to its last entry), and a run's
  // annotations come from `annotations[id]` — an id without an entry fails the
  // call. Every `api` call is logged to api.log, every walk counted in <name>.count.
  function probeGh(
    dir: string,
    {
      snapshots,
      runs = [page()],
      annotations = {},
    }: { snapshots: string[]; runs?: string[]; annotations?: Record<number, string> },
  ): void {
    for (const [i, body] of snapshots.entries()) writeFileSync(join(dir, `snap.${i + 1}.json`), body)
    for (const [i, body] of runs.entries()) writeFileSync(join(dir, `runs.${i + 1}.json`), body)
    for (const [id, body] of Object.entries(annotations)) writeFileSync(join(dir, `annotations.${id}.json`), body)
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
d="$(dirname "$0")"
next() {
  local n=0 f="$d/$1.count"
  if [[ -f "$f" ]]; then n=$(cat "$f"); fi
  n=$((n + 1))
  echo "$n" > "$f"
  if (( n > $2 )); then n=$2; fi
  cat "$d/$1.$n.json"
}
if [[ "$1" == "api" ]]; then
  args="$*"
  echo "$args" >> "$d/api.log"
  case "$args" in
    *commits/abc/check-runs*) next runs ${runs.length} ;;
    *check-runs/*/annotations*) id="\${args#*check-runs/}"; cat "$d/annotations.\${id%%/*}.json" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
next snap ${snapshots.length}
`,
    )
  }

  const SINCE = '2026-09-29T10:00:00Z'
  const EVALUATE_ONLY = 'evaluate-only: kit-ci App not configured — manual merge required (docs/kit/ci-app-setup.md)'
  const EVALUATE_ONLY_LATEST =
    'evaluate-only: the latest merge-on-green run was evaluate-only — configure kit-ci (docs/kit/ci-app-setup.md), then re-label reviewed'
  const NOT_CONFIGURED = JSON.stringify([
    { title: 'kit-ci not configured', message: 'Auto-merge OFF (evaluate-only)', annotation_level: 'notice' },
  ])
  const OTHER_NOTICE = JSON.stringify([{ title: 'something else', message: 'x', annotation_level: 'notice' }])

  function page(
    ...runs: { id: number; status: string; started_at: string | null; conclusion?: string | null }[]
  ): string {
    return JSON.stringify({
      total_count: runs.length,
      check_runs: runs.map((r) => ({
        name: 'merge-on-green',
        conclusion: r.status === 'completed' ? 'success' : null,
        ...r,
      })),
    })
  }

  function snapshot(
    state = 'OPEN',
    { autoMergeRequest = null as unknown, extraChecks = [] as unknown[] } = {},
  ): string {
    return JSON.stringify({
      state,
      mergeStateStatus: state === 'OPEN' ? 'BLOCKED' : 'UNKNOWN',
      autoMergeRequest,
      labels: state === 'OPEN' ? [{ name: 'reviewed' }] : [],
      headRefOid: 'abc',
      statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }, ...extraChecks],
    })
  }

  const count = (dir: string, name: string) => readFileSync(join(dir, `${name}.count`), 'utf8').trim()
  const apiLog = (dir: string) => (existsSync(join(dir, 'api.log')) ? readFileSync(join(dir, 'api.log'), 'utf8') : '')

  it('exits 6 once green when the merge-on-green run of this landing reports kit-ci not configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-only-'))
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const started = Date.now()
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY)
    expect(count(dir, 'snap')).toBe('3')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('without --since, an annotated latest run exits 6 naming the re-label fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-no-since-'))
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T09:00:00Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', [])
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY_LATEST)
    expect(result.stderr).not.toContain(EVALUATE_ONLY)
  })

  it('a run started at exactly --since counts as this landing and exits 6', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-boundary-'))
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: SINCE })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY)
  })

  it('a fractional started_at in the same UTC second as --since is kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-frac-'))
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:00.500Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY)
  })

  it('MERGED on the first merge-phase poll exits 0 without probing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-merged-'))
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(0)
    expect(apiLog(dir)).toBe('')
    expect(count(dir, 'snap')).toBe('3')
  })

  it('exits 70 when the check-runs lookup fails, without waiting out the deadline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-runs-fail-'))
    // Enough OPEN merge-phase snaps that a swallowed failure would deadline (exit 5).
    for (let i = 1; i <= 20; i++) {
      writeFileSync(join(dir, `snap.${i}.json`), i <= 2 || i < 20 ? snapshot() : snapshot())
    }
    fakeGh(
      dir,
      `#!/usr/bin/env bash
set -euo pipefail
d="$(dirname "$0")"
if [[ "$1" == "api" ]]; then
  echo "$*" >> "$d/api.log"
  exit 1
fi
n=0
if [[ -f "$d/snap.count" ]]; then n=$(cat "$d/snap.count"); fi
n=$((n + 1))
echo "$n" > "$d/snap.count"
if (( n > 20 )); then n=20; fi
cat "$d/snap.$n.json"
`,
    )
    const result = runWatch(dir, {}, undefined, '2s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(70)
    expect(apiLog(dir)).toContain('commits/abc/check-runs')
    // Check phase: 2 polls, then first merge probe fails the api — not a deadline loop.
    expect(count(dir, 'snap')).toBe('3')
  })

  it('a completed run without the notice is configured: the probe stops and the merge path runs unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-merge-'))
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: OTHER_NOTICE },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(0)
    expect(count(dir, 'snap')).toBe('5')
    expect(count(dir, 'runs')).toBe('1')
  })

  it('never judges a stale annotated run older than --since; the fresh configured run wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-stale-'))
    const stale = { id: 41, status: 'completed', started_at: '2026-09-29T09:00:00Z' }
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page(stale), page(stale, { id: 42, status: 'completed', started_at: '2026-09-29T10:00:07Z' })],
      annotations: { 41: NOT_CONFIGURED, 42: '[]' },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(0)
    expect(count(dir, 'runs')).toBe('2')
    expect(apiLog(dir)).not.toContain('check-runs/41/annotations')
    expect(apiLog(dir)).toContain('check-runs/42/annotations')
  })

  it('keeps probing a queued run hidden by landing.required_checks until it reports kit-ci not configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-queued-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ci-watch-eval-queued-cwd-'))
    mkdirSync(join(cwd, '.dev'))
    writeFileSync(join(cwd, '.dev', 'stack.yml'), 'landing:\n  required_checks: [ci]\n')
    const queued = page({ id: 42, status: 'queued', started_at: '2026-09-29T10:00:05Z' })
    const open = snapshot('OPEN', { extraChecks: [{ name: 'merge-on-green', status: 'QUEUED', conclusion: '' }] })
    probeGh(dir, {
      snapshots: [open],
      runs: [queued, queued, queued, page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = runWatch(dir, {}, cwd, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY)
    expect(count(dir, 'runs')).toBe('4')
  })

  it('a newer skipped run does not hide the run that reports kit-ci not configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-skipped-'))
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [
        page(
          { id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' },
          { id: 43, status: 'completed', conclusion: 'skipped', started_at: '2026-09-29T10:00:09Z' },
        ),
      ],
      annotations: { 42: NOT_CONFIGURED, 43: '[]' },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(6)
  })

  it('of two runs since the label, the newest decides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-newest-'))
    probeGh(dir, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [
        page(
          { id: 44, status: 'completed', started_at: '2026-09-29T10:00:08Z' },
          { id: 42, status: 'completed', started_at: '2026-09-29T10:00:03Z' },
        ),
      ],
      annotations: { 42: NOT_CONFIGURED, 44: '[]' },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(0)
    expect(apiLog(dir)).not.toContain('check-runs/42/annotations')
  })

  it('native mode never probes: an annotated merge-on-green run with auto-merge armed still merges', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-native-no-probe-'))
    const armed = snapshot('OPEN', { autoMergeRequest: { mergeMethod: 'MERGE' } })
    probeGh(dir, {
      snapshots: [armed, armed, armed, snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = runWatch(dir, {}, undefined, '30s', 'native', ['--since', SINCE])
    expect(result.code).toBe(0)
    expect(count(dir, 'snap')).toBe('4')
    expect(apiLog(dir)).toBe('')
  })

  it('exits 70, not 6, when the annotations lookup fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-eval-fail-'))
    probeGh(dir, {
      snapshots: [snapshot()],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
    })
    const result = runWatch(dir, {}, undefined, '30s', 'merge-on-green', ['--since', SINCE])
    expect(result.code).toBe(70)
    expect(apiLog(dir)).toContain('check-runs/42/annotations')
  })
})
