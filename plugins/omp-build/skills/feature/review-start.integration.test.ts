import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * A review start disarms an armed PR (#713, AC2) — whichever skill starts it. Runs the
 * `javascript` fence of dev-review's Phase 1 step 0, extracted verbatim from its SKILL.md,
 * in a forked bun against the stateful fake `gh` — the same fence the nested review of an
 * `existing` PR in `/feature` §6.3 executes, with `explicitPr` set to the PR's number.
 *
 * The limit: this proves the fence disarms. That an agent runs the fence is the skill text's
 * contract, not something a test can drive.
 */

const SIM = path.resolve(import.meta.dirname, 'gh-simulator.ts')
const DEV_REVIEW = path.resolve(import.meta.dirname, '../dev-review')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const BRANCH = 'feat/713-armed-gate'
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

/**
 * An OPEN PR armed (label + auto-merge pinned) by an approval of an older head, whose branch was
 * pushed since. Its required check is not green, so the simulator never merges it.
 */
function armedPrWithMovedHead(): { box: Box; older: string; head: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-review-start-')))
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  const bin = path.join(root, 'bin')
  const stateFile = path.join(root, 'gh-state.json')
  mkdirSync(bin)
  symlinkSync(SIM, path.join(bin, 'gh'))
  chmodSync(SIM, 0o755)
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
  git(work, ['commit', '-qm', 'feat: reviewed (#713)'], env)
  const older = git(work, ['rev-parse', 'HEAD'], env)
  git(work, ['push', '-q', 'origin', BRANCH], env)
  writeFileSync(path.join(work, 'b.txt'), 'b\n')
  git(work, ['add', '.'], env)
  git(work, ['commit', '-qm', 'feat: pushed after the approval (#713)'], env)
  const head = git(work, ['rev-parse', 'HEAD'], env)
  git(work, ['push', '-q', 'origin', BRANCH], env)
  const record = [
    '<!-- omp-build:code-review -->',
    `<!-- omp-build:review-head sha=${older} -->`,
    '## Code Review',
    '',
    '**Verdict: Approve (clean)**',
    '',
  ].join('\n')
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
          body: 'Closes #713',
          state: 'OPEN',
          headRefName: BRANCH,
          baseRefName: 'main',
          headRefOid: head,
          isCrossRepository: false,
          labels: ['reviewed', 'size:F-lite'],
          autoMerge: { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: older },
          mergeCommit: null,
          mergedAt: null,
          comments: [{ author: 'operator', body: record }],
          closes: [],
        },
      },
      checks: {},
      events: {},
      calls: [],
    }),
  )
  return { box, older, head }
}

function readSim(): Sim {
  if (!box) throw new Error('no sandbox')
  return JSON.parse(readFileSync(box.stateFile, 'utf8')) as Sim
}

/** Runs the fence as dev-review's step 0 does: `SKILL_DIR`, `cwd` and `explicitPr` in scope. */
function runFence(
  fence: string,
  explicitPr: number | undefined,
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
      "process.stdout.write(outcome + '\\n')",
    ].join('\n'),
  )
  const out = spawnSync(REAL_BUN, [script], { cwd: box.root, env: box.env, encoding: 'utf8' })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

describe('a review start disarms the PR it reviews', () => {
  it("dev-review's step 0, run for an existing armed PR whose head moved, removes the label and auto-merge", () => {
    const { head, older } = armedPrWithMovedHead()
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
})
