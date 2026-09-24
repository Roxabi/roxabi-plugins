import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  it('aggregates green, failed, skipped, and pending', () => {
    expect(classifyChecks('[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]')).toBe('GREEN')
    expect(
      classifyChecks(
        '[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"scan","status":"COMPLETED","conclusion":"FAILURE"}]',
      ),
    ).toBe('FAIL')
    expect(classifyChecks('[{"name":"ci","status":"COMPLETED","conclusion":"SKIPPED"}]')).toBe('SKIP')
    expect(classifyChecks('[{"name":"ci","status":"IN_PROGRESS","conclusion":""}]')).toBe('PENDING')
  })
})

describe('watch with a stubbed gh', () => {
  function fakeGh(dir: string, body: string): void {
    const path = join(dir, 'gh')
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }

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
})
