import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateAutoMergeYml, workflowOptsFromStack } from '../workflows/workflow-generators'

const HEAD = 'a'.repeat(40)
const BASE = { stack: 'bun' as const, test: 'vitest' as const, deploy: 'none' as const }

function stepBlock(yml: string, name: string): string {
  const marker = `- name: ${name}\n`
  const start = yml.indexOf(marker)
  if (start < 0) throw new Error(`missing step ${name}`)
  const rest = yml.slice(start + marker.length)
  const bounds = [rest.search(/\n {6}- name:/), rest.search(/\n {2}[a-z0-9-]+:/)].filter((at) => at >= 0)
  const end = bounds.length === 0 ? yml.length : start + marker.length + Math.min(...bounds)
  return yml.slice(start, end)
}

function stepIf(block: string): string {
  const folded = block.match(/if: >-\n((?: {10}\S.*\n)+)/)
  if (folded) return folded[1].replace(/^ {10}/gm, '').trim()
  const line = block.match(/if: (.+)/)
  if (!line) throw new Error('step has no if')
  return line[1].trim()
}

function stepScript(yml: string, name: string): string {
  const block = stepBlock(yml, name)
  const runAt = block.indexOf('run: |')
  if (runAt < 0) throw new Error(`step ${name} has no run`)
  const lines = block
    .slice(runAt + 'run: |'.length)
    .split('\n')
    .slice(1)
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^ */)?.[0].length ?? 0)
  const cut = Math.min(...indents)
  return `${lines
    .map((line) => (line.length >= cut ? line.slice(cut) : line))
    .join('\n')
    .replace(/\s+$/, '')}\n`
}

function stubGh(dir: string): void {
  const path = join(dir, 'gh')
  writeFileSync(
    path,
    `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *'--disable-auto'*) exit 0 ;;
  *'--remove-label'*) exit 0 ;;
  *'pr comment'*) exit 0 ;;
  *'--auto'*)
    if [ "\${GH_AUTO_FAIL:-}" = 1 ]; then
      n=$(cat "$GH_LOG.auto" 2>/dev/null || echo 0)
      n=$((n + 1))
      printf '%s' "$n" > "$GH_LOG.auto"
      if [ "$n" -eq 1 ]; then
        echo "\${GH_AUTO_MSG:-refused}" >&2
        exit 1
      fi
    fi
    exit 0
    ;;
  *'--paginate'*|*'issues/'*)
    if [ "\${GH_COMMENTS_FAIL:-}" = 1 ]; then
      echo 'comments unavailable' >&2
      exit 1
    fi
    printf '%s' "\${GH_COMMENTS:-[]}"
    exit 0
    ;;
  *autoMergeRequest*|*'--json labels'*)
    if [ "\${GH_VIEW_FAIL:-}" = 1 ]; then
      echo 'view failed' >&2
      exit 1
    fi
    printf '%s\\n' "\${GH_ARMED:-false}"
    exit 0
    ;;
esac
echo "unexpected gh: $*" >&2
exit 1
`,
  )
  chmodSync(path, 0o755)
}

function stubJq(dir: string): void {
  const path = join(dir, 'jq')
  writeFileSync(
    path,
    `#!/bin/bash
if [ "\${GH_JQ_VERDICT_FAIL:-}" = 1 ]; then
  for arg in "$@"; do
    if [ "$arg" = -r ]; then
      printf '%s\\n' '${HEAD}'
      exit 1
    fi
  done
fi
exec /usr/bin/jq "$@"
`,
  )
  chmodSync(path, 0o755)
}

function runScript(
  script: string,
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'auto-merge-gh-'))
  try {
    stubGh(dir)
    stubJq(dir)
    const log = join(dir, 'log')
    writeFileSync(log, '')
    const proc = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GH_LOG: log,
        PR_NUMBER: '652',
        GITHUB_REPOSITORY: 'Roxabi/roxabi-plugins',
        HEAD_SHA: HEAD,
        REVIEWER: 'omp-bot',
        ACTION: 'labeled',
        ...env,
      },
    })
    return {
      status: proc.status ?? 1,
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
      log: readFileSync(log, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('auto-merge review record is opt-in', () => {
  it('with the option off, the generated job is the label-only fleet job', () => {
    for (const yml of [generateAutoMergeYml(), generateAutoMergeYml({ ...BASE, reviewRecord: false })]) {
      expect(yml).not.toContain('OMP_BUILD_AUTOMATION_LOGIN')
      expect(yml).not.toContain('omp-build:review-head')
      expect(yml).toContain('update-branch')
      expect(yml).toContain('|| true')
    }
  })

  it('workflowOptsFromStack leaves the gate off unless the stack asks for it', () => {
    expect(workflowOptsFromStack({ runtime: 'bun', commands: { test: 'bun run test' } }).reviewRecord).toBe(false)
    expect(
      workflowOptsFromStack({
        runtime: 'bun',
        commands: { test: 'bun run test' },
        reviewRecord: true,
      }).reviewRecord,
    ).toBe(true)
    const off = generateAutoMergeYml(workflowOptsFromStack({ runtime: 'bun', commands: { test: 'bun run test' } }))
    expect(off).not.toContain('OMP_BUILD_AUTOMATION_LOGIN')
  })
})

describe('dependabot exemption when the record gate is on', () => {
  const yml = () => generateAutoMergeYml({ ...BASE, reviewRecord: true })

  function record(verdict: string, sha: string): string {
    return [
      '<!-- omp-build:code-review -->',
      `<!-- omp-build:review-head sha=${sha} -->`,
      '## Code Review',
      `**Verdict: ${verdict}**`,
    ].join('\n')
  }

  function pages(comments: Array<{ body: string; at: string }>): string {
    return JSON.stringify([
      comments.map((comment) => ({
        user: { login: 'omp-bot' },
        body: comment.body,
        created_at: comment.at,
      })),
    ])
  }

  it('enables from a successful Approve page and disarms on a later Request changes', () => {
    const approved = runScript(stepScript(yml(), 'Enable auto-merge (merge commit)'), {
      ACTION: 'labeled',
      AUTHOR: 'someone',
      GH_COMMENTS: pages([{ body: record('Approve', HEAD), at: '2026-01-01T00:00:00Z' }]),
    })
    expect(approved.status).toBe(0)
    expect(approved.log).toContain('--auto --merge')
    expect(approved.log).toContain(`--match-head-commit ${HEAD}`)
    expect(approved.log).not.toContain('--remove-label')

    const suppressed = runScript(stepScript(yml(), 'Enable auto-merge (merge commit)'), {
      ACTION: 'labeled',
      AUTHOR: 'someone',
      GH_COMMENTS: pages([
        { body: record('Approve', HEAD), at: '2026-01-01T00:00:00Z' },
        { body: record('Request changes', HEAD), at: '2026-01-01T00:00:01Z' },
      ]),
    })
    expect(suppressed.status).not.toBe(0)
    expect(suppressed.log).not.toContain('--auto --merge')
    expect(suppressed.log.indexOf('--disable-auto')).toBeLessThan(suppressed.log.indexOf('--remove-label reviewed'))

    const empty = runScript(stepScript(yml(), 'Enable auto-merge (merge commit)'), {
      ACTION: 'labeled',
      AUTHOR: 'someone',
      GH_COMMENTS: '[[]]',
    })
    expect(empty.status).not.toBe(0)
    expect(empty.log).not.toContain('--auto --merge')
  })

  it('enables a non-major dependabot PR without a review record', () => {
    const ran = runScript(stepScript(yml(), 'Enable auto-merge (merge commit)'), {
      ACTION: 'labeled',
      AUTHOR: 'dependabot[bot]',
      GH_COMMENTS_FAIL: '1',
    })
    expect(ran.status).toBe(0)
    expect(ran.log).toContain('--auto --merge')
    expect(ran.log).toContain('--match-head-commit')
    expect(ran.log).toContain(HEAD)
    expect(ran.log).not.toContain('--remove-label')
    expect(ran.log).not.toContain('issues/')
  })

  it('still refuses a human PR that has no record', () => {
    const ran = runScript(stepScript(yml(), 'Enable auto-merge (merge commit)'), {
      ACTION: 'labeled',
      AUTHOR: 'someone',
      GH_COMMENTS_FAIL: '1',
    })
    expect(ran.status).not.toBe(0)
    expect(ran.log).toContain('--disable-auto')
    expect(ran.log).toContain('--remove-label reviewed')
    expect(ran.log.indexOf('--disable-auto')).toBeLessThan(ran.log.indexOf('--remove-label reviewed'))
  })

  it('still refuses a dependabot semver-major bump', () => {
    const generated = yml()
    const block = stepBlock(generated, 'Block dependabot semver-major bumps')
    const fetchId = stepBlock(generated, 'Fetch dependabot metadata').match(/\n\s+id: (\S+)/)?.[1]
    expect(fetchId).toBeTruthy()
    expect(stepIf(block)).toBe(
      [
        "github.event.action == 'labeled' &&",
        "github.event.pull_request.user.login == 'dependabot[bot]' &&",
        `steps.${fetchId}.outputs.update-type == 'version-update:semver-major'`,
      ].join('\n'),
    )
    expect(block).not.toContain('continue-on-error')
    const enableIf = stepIf(stepBlock(generated, 'Enable auto-merge (merge commit)'))
    expect(enableIf).toBe("github.event.action == 'labeled'")
    expect(enableIf).not.toMatch(/\b(success|failure|cancelled|always)\s*\(/)
    expect(block).toContain("steps.dependabot-meta.outputs.update-type == 'version-update:semver-major'")
    expect(generated.indexOf('Block dependabot semver-major bumps')).toBeLessThan(
      generated.indexOf('Enable auto-merge (merge commit)'),
    )
    const ran = runScript(stepScript(generated, 'Block dependabot semver-major bumps'), {
      ACTION: 'labeled',
      AUTHOR: 'dependabot[bot]',
    })
    expect(ran.status).not.toBe(0)
    expect(ran.stdout).toContain('semver-major')
    expect(ran.log).toContain('semver-major')
    expect(ran.log).not.toContain('--auto --merge')
  })

  it('a synchronize still disarms, including when the label is already gone', () => {
    const generated = yml()
    const disarm = stepBlock(generated, 'Disarm auto-merge on a moved head')
    expect(stepIf(disarm)).toBe("always() && github.event.action == 'synchronize'")
    expect(disarm).toContain("github.event.action == 'synchronize'")
    expect(generated.indexOf('Disarm auto-merge on a moved head')).toBeLessThan(generated.indexOf('Mint app token'))
    const viewFails = runScript(stepScript(generated, 'Disarm auto-merge on a moved head'), {
      ACTION: 'synchronize',
      GH_VIEW_FAIL: '1',
    })
    expect(viewFails.status).not.toBe(0)
    expect(viewFails.log).toContain('--disable-auto')
    expect(viewFails.log.indexOf('--disable-auto')).toBeLessThan(viewFails.log.indexOf('--remove-label reviewed'))
    expect(viewFails.log).not.toContain('--auto --merge')
  })

  it('a verdict jq that emits a sha and exits non-zero disarms', () => {
    const ran = runScript(stepScript(yml(), 'Enable auto-merge (merge commit)'), {
      ACTION: 'labeled',
      AUTHOR: 'someone',
      GH_COMMENTS: '[[]]',
      GH_JQ_VERDICT_FAIL: '1',
    })
    expect(ran.status).not.toBe(0)
    expect(ran.log).toContain('--disable-auto')
    expect(ran.log.indexOf('--disable-auto')).toBeLessThan(ran.log.indexOf('--remove-label reviewed'))
    expect(ran.log).not.toContain('--auto --merge')
  })

  it('a refused pin disarms and does not re-enable', () => {
    const ran = runScript(stepScript(yml(), 'Enable auto-merge (merge commit)'), {
      ACTION: 'labeled',
      AUTHOR: 'someone',
      GH_COMMENTS: pages([{ body: record('Approve', HEAD), at: '2026-01-01T00:00:00Z' }]),
      GH_AUTO_FAIL: '1',
      GH_AUTO_MSG: 'refused',
    })
    expect(ran.status).not.toBe(0)
    expect(ran.log.match(/--auto --merge/g)).toHaveLength(1)
    expect(ran.log.indexOf('--auto --merge')).toBeLessThan(ran.log.indexOf('--disable-auto'))
    expect(ran.log).toContain('--remove-label reviewed')
  })

  it('an already-enabled pin is disabled and re-enabled on the reviewed head', () => {
    const ran = runScript(stepScript(yml(), 'Enable auto-merge (merge commit)'), {
      ACTION: 'labeled',
      AUTHOR: 'someone',
      GH_COMMENTS: pages([{ body: record('Approve', HEAD), at: '2026-01-01T00:00:00Z' }]),
      GH_AUTO_FAIL: '1',
      GH_AUTO_MSG: 'already enabled',
    })
    expect(ran.status).toBe(0)
    const merges = ran.log.match(/--auto --merge/g) ?? []
    expect(merges).toHaveLength(2)
    const first = ran.log.indexOf('--auto --merge')
    const disabled = ran.log.indexOf('--disable-auto')
    const second = ran.log.indexOf('--auto --merge', first + 1)
    expect(first).toBeLessThan(disabled)
    expect(disabled).toBeLessThan(second)
    expect(ran.log).toContain(`--match-head-commit ${HEAD}`)
    expect(ran.log).not.toContain('--remove-label')
  })
})

describe('dev-init workflows --local', () => {
  const initTs = join(import.meta.dirname, '../../dev-init/init.ts')

  function written(stack: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'init-review-record-'))
    try {
      mkdirSync(join(dir, '.dev'))
      writeFileSync(join(dir, '.dev/stack.yml'), stack)
      const proc = spawnSync(
        'bun',
        [initTs, 'workflows', '--local', '--stack', 'bun', '--test', 'vitest', '--deploy', 'none'],
        { cwd: dir, encoding: 'utf8' },
      )
      if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout || 'init workflows failed')
      return readFileSync(join(dir, '.github/workflows/auto-merge.yml'), 'utf8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('keeps the fleet default when ci.review_record is absent', () => {
    const yml = written('runtime: bun\n')
    expect(yml).not.toContain('OMP_BUILD_AUTOMATION_LOGIN')
    expect(yml).toContain('update-branch')
  })

  it('opts in when ci.review_record is true', () => {
    const yml = written('ci:\n  review_record: true\n')
    expect(yml).toContain('OMP_BUILD_AUTOMATION_LOGIN')
    expect(yml).toContain('AUTHOR')
    expect(yml).not.toContain('update-branch')
  })
})
