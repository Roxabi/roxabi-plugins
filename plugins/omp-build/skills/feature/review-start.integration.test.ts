import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * A review start disarms an armed PR (#713 AC2, kept by #744) — whichever skill starts it. Runs the
 * `javascript` fence of dev-review's Phase 1 step 0, extracted verbatim from its SKILL.md, in a
 * forked bun against the stateful simulated `gh` — the same fence the nested review of an `existing`
 * PR in `/feature` §6.3 executes, with `explicitPr` set to the PR's number.
 *
 * The harness appends the review's next action (the diff read, then the panel) to the fence: it prints
 * `continued` only when the fence let the review go on, `stopped` when the fence returned, and the
 * run fails when the fence threw. What the PR holds afterwards is read back from the simulator.
 *
 * The limit: this proves the fence disarms. That an agent runs the fence is the skill text's
 * contract, not something a test can drive.
 */

const SIM = path.resolve(import.meta.dirname, 'gh-simulator.ts')
const DEV_REVIEW = path.resolve(import.meta.dirname, '../dev-review')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const BRANCH = 'feat/744-armed-gate'
const PR = 10

type Box = { root: string; origin: string; stateFile: string; env: NodeJS.ProcessEnv }
type Sim = {
  prs: Record<
    string,
    { state: string; labels: string[]; autoMerge: { enabledAt: string; matchHeadCommit?: string } | null }
  >
}

let box: Box | undefined
afterEach(() => {
  if (box) rmSync(box.root, { recursive: true, force: true })
  box = undefined
})

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  }).trim()
}

/** The first `javascript` fence after dev-review's step 0, verbatim. */
function stepZeroFence(): string {
  const text = readFileSync(path.join(DEV_REVIEW, 'SKILL.md'), 'utf8')
  const start = text.indexOf('\n0. **')
  const open = text.indexOf('```javascript\n', start)
  const close = text.indexOf('\n   ```', open)
  if (start === -1 || open === -1 || close === -1) throw new Error('dev-review step 0 has no javascript fence')
  return text
    .slice(open + '```javascript\n'.length, close)
    .split('\n')
    .map((line) => line.replace(/^ {3}/, ''))
    .join('\n')
}

const record = (verdict: string, sha: string): string =>
  [
    '<!-- omp-build:code-review -->',
    `<!-- omp-build:review-head sha=${sha} -->`,
    '## Code Review',
    '',
    `**Verdict: ${verdict}**`,
    '',
  ].join('\n')

/**
 * An OPEN PR armed (label + auto-merge). `moved` pushes a commit after the approval, so the
 * review-head is older than the current head; otherwise the record approves the current head.
 * `spent`: three Request-changes records, so the review bound is spent. Its required check is not
 * green, so the simulator never merges it. `gh` is a wrapper over the simulator that refuses the
 * writes named by `GH_FAIL` (`disable`, `remove`, or both, comma-separated).
 */
function armedReviewedPr({ moved = false, spent = false } = {}): { older: string; head: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-review-start-')))
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  const bin = path.join(root, 'bin')
  const stateFile = path.join(root, 'gh-state.json')
  mkdirSync(bin)
  chmodSync(SIM, 0o755)
  writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *--disable-auto*) case ",$GH_FAIL," in *,disable,*) echo "gh: disable-auto refused" >&2; exit 1 ;; esac ;;',
      '  *--remove-label*) case ",$GH_FAIL," in *,remove,*) echo "gh: remove-label refused" >&2; exit 1 ;; esac ;;',
      'esac',
      `exec "${SIM}" "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(path.join(bin, 'gh'), 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    GH_SIM_STATE: stateFile,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key]
  }
  box = { root, origin, stateFile, env }
  git(root, ['init', '-q', '--bare', origin], env)
  git(root, ['init', '-q', '-b', 'main', work], env)
  git(work, ['remote', 'add', 'origin', origin], env)
  writeFileSync(path.join(work, 'README.md'), 'base\n')
  git(work, ['add', '.'], env)
  git(work, ['commit', '-qm', 'chore: base'], env)
  git(work, ['push', '-q', 'origin', 'main'], env)
  git(work, ['checkout', '-q', '-b', BRANCH], env)
  writeFileSync(path.join(work, 'a.txt'), 'a\n')
  git(work, ['add', '.'], env)
  git(work, ['commit', '-qm', 'feat: reviewed (#744)'], env)
  const older = git(work, ['rev-parse', 'HEAD'], env)
  git(work, ['push', '-q', 'origin', BRANCH], env)
  let head = older
  if (moved) {
    writeFileSync(path.join(work, 'b.txt'), 'b\n')
    git(work, ['add', '.'], env)
    git(work, ['commit', '-qm', 'feat: pushed after the approval (#744)'], env)
    head = git(work, ['rev-parse', 'HEAD'], env)
    git(work, ['push', '-q', 'origin', BRANCH], env)
  }
  const bodies = spent
    ? [record('Request changes', older), record('Request changes', older), record('Request changes', older)]
    : [record('Approve (clean)', older)]
  writeFileSync(
    stateFile,
    JSON.stringify({
      viewer: 'operator',
      owner: 'acme',
      name: 'app',
      defaultBranch: 'main',
      origin,
      requiredChecks: ['ci'],
      nextPr: PR + 1,
      clock: 0,
      issues: {},
      prs: {
        [PR]: {
          number: PR,
          title: 'feat: reviewed',
          body: 'Closes #744',
          state: 'OPEN',
          headRefName: BRANCH,
          baseRefName: 'main',
          headRefOid: head,
          isCrossRepository: false,
          labels: ['reviewed', 'size:F-lite'],
          autoMerge: { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: older },
          mergeCommit: null,
          mergedAt: null,
          comments: bodies.map((body) => ({ author: 'operator', body })),
          closes: [],
        },
      },
      checks: {},
      events: {},
      calls: [],
    }),
  )
  return { older, head }
}

function readSim(): Sim {
  if (!box) throw new Error('no sandbox')
  return JSON.parse(readFileSync(box.stateFile, 'utf8')) as Sim
}

/**
 * Runs the fence as dev-review's step 0 does: `SKILL_DIR`, `cwd` and `explicitPr` in scope. What
 * follows the fence stands for the review itself — `continued` is the diff read and the panel.
 */
function runFence(
  fence: string,
  explicitPr: number | undefined,
  failing = '',
): { status: number | null; stdout: string; stderr: string } {
  if (!box) throw new Error('no sandbox')
  const script = path.join(box.root, 'step-zero.mjs')
  writeFileSync(
    script,
    [
      `const SKILL_DIR = ${JSON.stringify(DEV_REVIEW)}`,
      `const cwd = ${JSON.stringify(box.root)}`,
      `const explicitPr = ${explicitPr === undefined ? 'undefined' : explicitPr}`,
      'const outcome = await (async () => {',
      fence,
      "  return 'continued'",
      '})()',
      "process.stdout.write((outcome ?? 'stopped') + '\\n')",
    ].join('\n'),
  )
  const out = spawnSync(REAL_BUN, [script], {
    cwd: box.root,
    env: { ...box.env, GH_FAIL: failing },
    encoding: 'utf8',
  })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

describe('a review start disarms the PR it reviews', () => {
  it("dev-review's step 0, run for an existing armed PR whose head moved, removes the label and auto-merge", () => {
    const { head, older } = armedReviewedPr({ moved: true })
    const before = readSim().prs[PR]
    expect(before.labels).toContain('reviewed')
    expect(before.autoMerge?.matchHeadCommit).toBe(older)
    expect(head).not.toBe(older)

    const ran = runFence(stepZeroFence(), PR)
    expect(ran.stderr).toBe('')
    expect(ran.status).toBe(0)
    expect(ran.stdout.trim()).toBe('continued')

    const after = readSim().prs[PR]
    expect(after.state).toBe('OPEN')
    expect(after.labels).toEqual(['size:F-lite'])
    expect(after.autoMerge).toBeNull()
  })

  it("dev-review's step 0, run for an existing armed PR whose review approves the current head, clears the label and auto-merge and continues", () => {
    const { head, older } = armedReviewedPr()
    expect(head).toBe(older)
    const before = readSim().prs[PR]
    expect(before.labels).toContain('reviewed')
    expect(before.autoMerge?.matchHeadCommit).toBe(head)

    const ran = runFence(stepZeroFence(), PR)
    expect(ran.stderr).toBe('')
    expect(ran.status).toBe(0)
    expect(ran.stdout.trim()).toBe('continued')

    const after = readSim().prs[PR]
    expect(after.state).toBe('OPEN')
    expect(after.labels).toEqual(['size:F-lite'])
    expect(after.autoMerge).toBeNull()
  })

  it("dev-review's step 0, run for an armed PR whose review bound is spent, clears the gate and stops before the review", () => {
    armedReviewedPr({ spent: true })
    expect(readSim().prs[PR].labels).toContain('reviewed')

    const ran = runFence(stepZeroFence(), PR)
    expect(ran.stderr).toBe('')
    expect(ran.status).toBe(0)
    expect(ran.stdout.trim()).toBe('stopped')

    const after = readSim().prs[PR]
    expect(after.state).toBe('OPEN')
    expect(after.labels).toEqual(['size:F-lite'])
    expect(after.autoMerge).toBeNull()
  })

  it.each([
    ['auto-merge cannot be disabled', 'disable', /stays armed — auto-merge(?! and)/, ['size:F-lite'], true],
    ['the label cannot be removed', 'remove', /stays armed — the reviewed label/, ['reviewed', 'size:F-lite'], false],
    [
      'neither write works',
      'disable,remove',
      /stays armed — auto-merge and the reviewed label/,
      ['reviewed', 'size:F-lite'],
      true,
    ],
  ])(
    "dev-review's step 0 on an armed PR whose disarm fails because %s: the review does not go on, and the error names what stays armed",
    (_case, failing, message, labels, autoMerge) => {
      armedReviewedPr({ moved: true })

      const ran = runFence(stepZeroFence(), PR, failing)
      expect(ran.status).not.toBe(0)
      expect(ran.stdout).not.toContain('continued')
      expect(ran.stderr).toMatch(message)

      // Each write was attempted on its own: only the ones that were refused remain.
      const after = readSim().prs[PR]
      expect(after.state).toBe('OPEN')
      expect(after.labels).toEqual(labels)
      expect(after.autoMerge !== null).toBe(autoMerge)
    },
  )

  it("dev-review's step 0 on an armed PR whose bound is spent and whose disarm fails stops with the error, not with a clean stop", () => {
    armedReviewedPr({ spent: true })

    const ran = runFence(stepZeroFence(), PR, 'disable')
    expect(ran.status).not.toBe(0)
    expect(ran.stdout).not.toContain('stopped')
    expect(ran.stdout).not.toContain('continued')
    expect(ran.stderr).toMatch(/stays armed — auto-merge/)
    expect(readSim().prs[PR].autoMerge).not.toBeNull()
  })
})
