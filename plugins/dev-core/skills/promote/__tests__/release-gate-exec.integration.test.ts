import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Executes the release-consistency gate's shipped shell against real git
 * fixtures.
 *
 * The gate's logic lives inside a YAML block scalar, so the only way to assert
 * on its BEHAVIOUR rather than on its spelling is to extract that block and run
 * it. Two contracts are proven here, both of which a source-grep can only
 * approximate (#385 items 1 and 3):
 *
 *   AUTHORITY — the deriver that executes is the PINNED copy under .gate-tools/,
 *     never the price.sh sitting in the checkout. On a pull_request the checkout
 *     is the merge ref, so a PR that rewrites price.sh would otherwise dictate
 *     its own verdict. The fixture plants a LYING price.sh in the checkout that
 *     agrees with the PR's witnesses; if it ran, the gate would be green.
 *
 *   D15c AT JOB GRANULARITY — an unavailable deriver must be fatal only where a
 *     version is actually derived. Every early green (trunk, head != staging,
 *     `version_files: []`) must still reach its `exit 0` with no pinned copy at
 *     all. Hoisting the `[ -f "$PRICE" ]` guard above them — the P1 defect the
 *     #374 review killed — deadlocks main in every provisioned repo, and turns
 *     the three EARLY-GREEN cases below red.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const REUSABLE = path.join(REPO_ROOT, '.github/workflows/release-consistency.yml')
const REAL_PRICE = path.join(REPO_ROOT, 'plugins/dev-core/skills/promote/price.sh')

/** Where the workflow expects the pinned clone to land, relative to the workspace. */
const PINNED_PRICE = '.gate-tools/plugins/dev-core/skills/promote/price.sh'

/**
 * Extract a step's `run: |` body. The indent is taken from the first non-empty
 * line (the YAML block-scalar rule) rather than a hardcoded column, so a
 * re-indent of the workflow cannot rot this.
 */
function extractRunBlock(yaml: string, stepName: string): string {
  const lines = yaml.split('\n')
  const nameIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`)
  if (nameIdx < 0) throw new Error(`step "${stepName}" not found`)
  const runIdx = lines.findIndex((l, i) => i > nameIdx && /^\s*run: \|\s*$/.test(l))
  if (runIdx < 0) throw new Error(`no block-scalar run: under "${stepName}"`)
  const body: string[] = []
  let indent = -1
  for (let i = runIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') {
      body.push('')
      continue
    }
    const lead = l.length - l.trimStart().length
    if (indent < 0) indent = lead
    if (lead < indent) break
    body.push(l.slice(indent))
  }
  return `${body.join('\n').replace(/\s+$/, '')}\n`
}

const GATE_SRC = extractRunBlock(fs.readFileSync(REUSABLE, 'utf8'), 'Gate')

/**
 * The gate needs a YAML reader for release.model / release.component. Loud
 * under CI: a gate suite that silently skips is an illusory gate (#371 B5).
 */
function hasYamlReader(): boolean {
  if (spawnSync('yq', ['--version']).status === 0) return true
  return spawnSync('python3', ['-c', 'import yaml']).status === 0
}

const tmpDirs: string[] = []
let gateSh: string

beforeAll(() => {
  if (!hasYamlReader() && process.env.CI) {
    throw new Error(
      'release-gate-exec: neither yq nor python3+PyYAML present under CI — the gate suite would silently skip',
    )
  }
  const d = scratch('gate-sh-')
  gateSh = path.join(d, 'gate.sh')
  fs.writeFileSync(gateSh, GATE_SRC)
})

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

/**
 * Strip every GIT_* location variable so an ambient GIT_DIR (a pre-push hook,
 * a parent harness) cannot redirect fixture commits into the real worktree.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {}
  // GIT_* would leak the runner's repo state. GH_*/GITHUB_* are stripped for a
  // sharper reason: every `gh` in these tests is meant to be the stub, and the
  // stub is only *prepended* to PATH. If resolution ever misses it, the real
  // `gh` runs — and with the runner's token still in the environment it runs
  // AUTHENTICATED, against live repos, from a unit test. Removing the credentials
  // means a fall-through can only fail, never act.
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('GH_') || k.startsWith('GITHUB_')) continue
    e[k] = v
  }
  e.GIT_CONFIG_GLOBAL = '/dev/null'
  e.GIT_CONFIG_SYSTEM = '/dev/null'
  e.GIT_AUTHOR_NAME = 'Fixture'
  e.GIT_AUTHOR_EMAIL = 'fixture@example.invalid'
  e.GIT_COMMITTER_NAME = 'Fixture'
  e.GIT_COMMITTER_EMAIL = 'fixture@example.invalid'
  e.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z'
  e.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z'
  return e
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

interface Fixture {
  /** `.dev/stack.yml` body committed on main; null = the file is absent. */
  baseStack: string | null
  /** `<component>/vX.Y.Z` tags created on the main tip. */
  baseTags?: string[]
  /** Conventional subjects committed on the head branch. */
  headCommits?: string[]
  /** CHANGELOG.md content present in the merge tree (a head witness). */
  changelog?: string
  headBranch?: string
  /** Version-file path + content committed on main (push path). */
  versionFile?: { path: string; body: string }
  /** Plant the pinned deriver under .gate-tools/ (default true). */
  pinned?: boolean
  /**
   * Plant a LYING price.sh in the checkout at the path the pre-#385 gate used.
   * Prints this version and exits 0 whatever it is asked.
   */
  headPriceLies?: string
  /**
   * THE ATTACK. Commit a lying price.sh at the PINNED path — `.gate-tools/…` is
   * a directory inside the head's own tree, so the head can simply put a file
   * there. Committed on the head branch, so it is in the merge tree exactly as
   * `actions/checkout` would materialise it on a pull_request.
   */
  headPlantsGateTools?: string
}

interface Built {
  repo: string
  headSha: string
  mainSha: string
}

function build(f: Fixture): Built {
  const repo = scratch('gate-fixture-')
  git(repo, ['init', '-q', '-b', 'main', '.'])

  fs.mkdirSync(path.join(repo, '.dev'), { recursive: true })
  if (f.baseStack !== null) fs.writeFileSync(path.join(repo, '.dev/stack.yml'), f.baseStack)
  if (f.versionFile) fs.writeFileSync(path.join(repo, f.versionFile.path), f.versionFile.body)
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), f.changelog ?? '# Changelog\n')
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'chore: base'])

  for (const t of f.baseTags ?? []) git(repo, ['tag', t])
  const mainSha = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['update-ref', 'refs/remotes/origin/main', mainSha])

  let headSha = mainSha
  const headBranch = f.headBranch ?? 'staging'
  if (f.headCommits?.length) {
    git(repo, ['checkout', '-q', '-b', headBranch])
    // THE ATTACK, committed on the head branch: `.gate-tools/` is a path inside
    // the PR author's own tree, so nothing stops a PR from putting a file there.
    if (f.headPlantsGateTools) {
      const dst = path.join(repo, PINNED_PRICE)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, `#!/usr/bin/env bash\necho "${f.headPlantsGateTools}"\n`)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'chore: plant .gate-tools'])
    }
    for (const subject of f.headCommits) git(repo, ['commit', '-q', '--allow-empty', '-m', subject])
    headSha = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['update-ref', `refs/remotes/origin/${headBranch}`, headSha])
    // The PR merge ref: base + head in the worktree, which is what
    // actions/checkout materialises on a pull_request.
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['merge', '--no-ff', '--no-commit', headBranch])
  } else if (f.headPlantsGateTools) {
    // Push path: the same file materialised in the checkout of main (it landed
    // through some earlier PR). The gate reads the workspace, so this is what a
    // committed `.gate-tools/…/price.sh` looks like from the Gate step.
    const dst = path.join(repo, PINNED_PRICE)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, `#!/usr/bin/env bash\necho "${f.headPlantsGateTools}"\n`)
  }

  // The head-supplied deriver: present in the checkout, and a liar.
  if (f.headPriceLies) {
    const dir = path.join(repo, 'plugins/dev-core/skills/promote')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'price.sh'), `#!/usr/bin/env bash\necho "${f.headPriceLies}"\n`)
  }

  // The pinned deriver: the real price.sh, where the pinned checkout puts it.
  if (f.pinned !== false) {
    const dst = path.join(repo, PINNED_PRICE)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(REAL_PRICE, dst)
  }

  return { repo, headSha, mainSha }
}

interface GateResult {
  status: number
  stdout: string
  stderr: string
}

function runGate(repo: string, env: Record<string, string>, script = gateSh): GateResult {
  const r = spawnSync('bash', [script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...gitEnv(), GATE_TOOLS_OUTCOME: 'success', GATE_PIN: 'Roxabi/roxabi-plugins@deadbeef', ...env },
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** A copy of the gate with one line rewritten — the falsifier harness. */
function mutated(replace: (src: string) => string): string {
  const src = replace(GATE_SRC)
  if (src === GATE_SRC) throw new Error('mutation was a no-op — the targeted line has moved')
  const p = path.join(scratch('gate-mut-'), 'gate.sh')
  fs.writeFileSync(p, src)
  return p
}

const STACK_STAGING_TRAIN = 'release:\n  model: staging-train\n  component: fixture\n  version_files: []\n'
const STACK_TRUNK = 'release:\n  model: trunk\n  component: fixture\n  version_files: []\n'

const PR_ENV = {
  EVENT_NAME: 'pull_request',
  PR_BASE_REF: 'main',
  PR_HEAD_REF: 'staging',
}

// ─── #385 item 1 — the PINNED deriver is what executes ────────────────────────

describe('release-consistency — the deriver is the pinned copy, not the checkout (#385 item 1)', () => {
  it('reds a promote PR whose own price.sh would have agreed with its own witnesses', () => {
    // The checkout carries a price.sh that prints 9.9.9; the PR title and the
    // CHANGELOG heading also say 9.9.9. Run the head copy and all three agree →
    // green. The pinned copy prices the real payload (1.2.3 + one `fix:`) at
    // 1.2.4 and the three-way disagrees → red. Only the SOURCE of the deriver
    // separates the two outcomes.
    const { repo, headSha } = build({
      baseStack: STACK_STAGING_TRAIN,
      baseTags: ['fixture/v1.2.3'],
      headCommits: ['fix: something small'],
      changelog: '## 9.9.9\n\n- lies\n',
      headPriceLies: '9.9.9',
    })
    const r = runGate(repo, {
      ...PR_ENV,
      PR_HEAD_SHA: headSha,
      PR_TITLE: 'chore: promote staging to main (fixture/v9.9.9)',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/three-way DISAGREEMENT/)
    expect(r.stdout).toMatch(/re-price=1\.2\.4/)
  })

  it('INVERTED: pointing $PRICE back at the checkout makes that same PR green', () => {
    // The falsifier for the assertion above. With PRICE restored to the
    // pre-#385 in-checkout path the lying deriver runs, the three-way agrees on
    // 9.9.9, and the gate certifies the PR's own claim. If this ever stops being
    // green the test above has stopped proving anything.
    const script = mutated((s) =>
      s.replace(
        'PRICE=".gate-tools/plugins/dev-core/skills/promote/price.sh"',
        'PRICE="plugins/dev-core/skills/promote/price.sh"',
      ),
    )
    const { repo, headSha } = build({
      baseStack: STACK_STAGING_TRAIN,
      baseTags: ['fixture/v1.2.3'],
      headCommits: ['fix: something small'],
      changelog: '## 9.9.9\n\n- lies\n',
      headPriceLies: '9.9.9',
    })
    const r = runGate(
      repo,
      { ...PR_ENV, PR_HEAD_SHA: headSha, PR_TITLE: 'chore: promote staging to main (fixture/v9.9.9)' },
      script,
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/three-way agreement on 9\.9\.9/)
  })

  it('refuses rather than falling back when the pinned copy is missing, even with a usable head copy', () => {
    // The pin failed (private repo, revoked token, outage). A fallback to the
    // checkout would be a silent restoration of the hole, so this is a red —
    // and it names the pin so the operator can tell it from a real disagreement.
    const { repo, headSha } = build({
      baseStack: STACK_STAGING_TRAIN,
      baseTags: ['fixture/v1.2.3'],
      headCommits: ['fix: something small'],
      changelog: '## 9.9.9\n',
      headPriceLies: '9.9.9',
      pinned: false,
    })
    const r = runGate(repo, {
      ...PR_ENV,
      PR_HEAD_SHA: headSha,
      PR_TITLE: 'chore: promote staging to main (fixture/v9.9.9)',
      GATE_TOOLS_OUTCOME: 'failure',
      GATE_PIN: 'Roxabi/roxabi-plugins@abc123',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/pinned deriver is unavailable/)
    expect(r.stderr).toMatch(/does NOT fall back/)
    expect(r.stderr).toMatch(/Roxabi\/roxabi-plugins@abc123/)
    // Not a three-way verdict: nothing was derived, so nothing was compared.
    expect(r.stderr).not.toMatch(/three-way/)
  })
})

// ─── #385 item 1 (re-opened): the head can WRITE the pinned path ─────────────
//
// `.gate-tools/` is a directory inside the checkout, i.e. inside the PR author's
// own tree. The pinned checkout step clears and fills it ONLY WHEN IT RUNS —
// its `if:` exists precisely because job.workflow_* may be unpopulated (they are
// documented as unavailable on GHES), and its `continue-on-error: true` exists
// precisely so a failed clone does not deadlock main. On both of those outcomes
// nothing touches the path, so a `.gate-tools/…/price.sh` COMMITTED BY THE PR is
// what `[ -f "$PRICE" ]` finds and what `bash "$PRICE"` runs.
//
// Presence at that path is therefore not authority. The gate decides on
// PROVENANCE: `steps.gate_tools.outcome` is the one witness the head cannot
// write, and only `success` blesses the bytes.
describe('release-consistency — a head-planted .gate-tools/ is not the pinned deriver (#385 item 1)', () => {
  const PLANTED_PR = {
    baseStack: STACK_STAGING_TRAIN,
    baseTags: ['fixture/v1.2.3'],
    headCommits: ['fix: something small'],
    changelog: '## 9.9.9\n\n- lies\n',
    headPlantsGateTools: '9.9.9',
    pinned: false as const,
  }
  const PLANTED_PUSH = {
    baseStack: 'release:\n  model: staging-train\n  component: fixture\n  version_files: [pkg.json]\n',
    baseTags: ['fixture/v1.2.3'],
    versionFile: { path: 'pkg.json', body: '{ "version": "1.2.2" }\n' },
    // A floor of 1.0.0 makes the BEHIND file (1.2.2 < the real tag 1.2.3) read
    // as ahead — the push path's own version of dictating the verdict.
    headPlantsGateTools: '1.0.0',
    pinned: false as const,
  }

  for (const outcome of ['skipped', 'failure']) {
    it(`reds a promote PR that planted its own .gate-tools (pin ${outcome})`, () => {
      const { repo, headSha } = build(PLANTED_PR)
      const r = runGate(repo, {
        ...PR_ENV,
        PR_HEAD_SHA: headSha,
        PR_TITLE: 'chore: promote staging to main (fixture/v9.9.9)',
        GATE_TOOLS_OUTCOME: outcome,
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/pinned deriver is unavailable/)
      // The planted liar never ran: no derivation, so no three-way verdict.
      expect(r.stdout).not.toMatch(/9\.9\.9/)
      expect(r.stderr).not.toMatch(/three-way/)
    })

    it(`reds a push whose main carries a planted .gate-tools (pin ${outcome})`, () => {
      const { repo, mainSha } = build(PLANTED_PUSH)
      const r = runGate(repo, { EVENT_NAME: 'push', PUSH_SHA: mainSha, GATE_TOOLS_OUTCOME: outcome })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/pinned deriver is unavailable/)
      expect(r.stdout).not.toMatch(/ok: pkg\.json/)
    })
  }

  it('INVERTED: deciding on presence instead of provenance greens both attacks', () => {
    // The falsifier, and the shape of the defect this closes: `[ -f "$PRICE" ]`
    // alone is exactly what the gate used to ask, and it certifies a file the PR
    // wrote. If these ever stop being green the two assertions above have stopped
    // proving anything.
    const presenceOnly = mutated((s) =>
      s.replace('[ "${GATE_TOOLS_OUTCOME:-}" = "success" ] && [ -f "$PRICE" ]', '[ -f "$PRICE" ]'),
    )
    const pr = build(PLANTED_PR)
    const rpr = runGate(
      pr.repo,
      {
        ...PR_ENV,
        PR_HEAD_SHA: pr.headSha,
        PR_TITLE: 'chore: promote staging to main (fixture/v9.9.9)',
        GATE_TOOLS_OUTCOME: 'skipped',
      },
      presenceOnly,
    )
    expect(rpr.status).toBe(0)
    expect(rpr.stdout).toMatch(/three-way agreement on 9\.9\.9/)

    const push = build(PLANTED_PUSH)
    const rpush = runGate(
      push.repo,
      { EVENT_NAME: 'push', PUSH_SHA: push.mainSha, GATE_TOOLS_OUTCOME: 'failure' },
      presenceOnly,
    )
    expect(rpush.status).toBe(0)
    expect(rpush.stdout).toMatch(/ok: pkg\.json = 1\.2\.2 >= tag 1\.0\.0/)
  })

  it('a real pinned checkout is still trusted — the provenance check is not a blanket refusal', () => {
    // outcome=success + the real deriver under .gate-tools/ is the normal path,
    // and it must keep deriving. Otherwise "fail closed" would just be "fail".
    const { repo, headSha } = build({
      baseStack: STACK_STAGING_TRAIN,
      baseTags: ['fixture/v1.2.3'],
      headCommits: ['fix: something small'],
      changelog: '## 1.2.4\n',
    })
    const r = runGate(repo, {
      ...PR_ENV,
      PR_HEAD_SHA: headSha,
      PR_TITLE: 'chore: promote staging to main (fixture/v1.2.4)',
      GATE_TOOLS_OUTCOME: 'success',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/three-way agreement on 1\.2\.4/)
  })
})

// ─── #385 item 3 — guard placement, proven by reachability ────────────────────

describe('release-consistency — every early green survives an unavailable deriver (D15c)', () => {
  // These three are the whole safety argument for where the `[ -f "$PRICE" ]`
  // guard sits. With zero bypass actors a red on any of them is an unmergeable
  // branch, so a guard hoisted in front of them deadlocks main in every
  // provisioned repo. They run with NO pinned copy and must still exit 0.

  it('trunk mode still early-greens with no pinned deriver', () => {
    const { repo, headSha } = build({ baseStack: STACK_TRUNK, headCommits: ['feat: x'], pinned: false })
    const r = runGate(repo, { ...PR_ENV, PR_HEAD_SHA: headSha, PR_TITLE: 'feat: x', GATE_TOOLS_OUTCOME: 'failure' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/trunk mode/)
  })

  it('a non-promote PR still early-greens with no pinned deriver', () => {
    const { repo, headSha } = build({
      baseStack: STACK_STAGING_TRAIN,
      headBranch: 'feature/x',
      headCommits: ['feat: x'],
      pinned: false,
    })
    const r = runGate(repo, {
      ...PR_ENV,
      PR_HEAD_REF: 'feature/x',
      PR_HEAD_SHA: headSha,
      PR_TITLE: 'feat: x',
      GATE_TOOLS_OUTCOME: 'failure',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/not-a-promote/)
  })

  it('the push path still early-greens on version_files: [] with no pinned deriver', () => {
    const { repo, mainSha } = build({ baseStack: STACK_STAGING_TRAIN, pinned: false })
    const r = runGate(repo, { EVENT_NAME: 'push', PUSH_SHA: mainSha, GATE_TOOLS_OUTCOME: 'failure' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/version_files empty/)
  })

  it('INVERTED: hoisting the guard above the early greens reds all three', () => {
    // The P1 defect, executed. `[ -f "$PRICE" ]` moved to the top of the script
    // is the "obvious" fix, and it turns every PR and every push of a repo whose
    // pin is unavailable into a red — which is a deadlocked main, not a gate.
    // Inlined message rather than `price_unavailable`: the hoist lands above that
    // function's definition, and a 127 "command not found" would pass a `toBe(1)`
    // check for the wrong reason.
    const hoisted = mutated((s) =>
      s.replace(
        'STACK=".dev/stack.yml"',
        'STACK=".dev/stack.yml"\n[ -f "$PRICE" ] || { echo "hoisted guard" >&2; exit 1; }',
      ),
    )
    const trunk = build({ baseStack: STACK_TRUNK, headCommits: ['feat: x'], pinned: false })
    expect(runGate(trunk.repo, { ...PR_ENV, PR_HEAD_SHA: trunk.headSha, PR_TITLE: 'feat: x' }, hoisted).status).toBe(1)

    const nonPromote = build({
      baseStack: STACK_STAGING_TRAIN,
      headBranch: 'feature/x',
      headCommits: ['feat: x'],
      pinned: false,
    })
    expect(
      runGate(
        nonPromote.repo,
        { ...PR_ENV, PR_HEAD_REF: 'feature/x', PR_HEAD_SHA: nonPromote.headSha, PR_TITLE: 'feat: x' },
        hoisted,
      ).status,
    ).toBe(1)

    const push = build({ baseStack: STACK_STAGING_TRAIN, pinned: false })
    expect(runGate(push.repo, { EVENT_NAME: 'push', PUSH_SHA: push.mainSha }, hoisted).status).toBe(1)
  })

  it('a present .gate-tools with no price.sh in it is the same red, not a green', () => {
    // The guard is `[ -f "$PRICE" ]`, not "did the checkout step succeed": a
    // clone that lands but does not carry the deriver (path moved, sparse
    // checkout misconfigured) must not read as available.
    const { repo, headSha } = build({
      baseStack: STACK_STAGING_TRAIN,
      baseTags: ['fixture/v1.2.3'],
      headCommits: ['fix: x'],
      changelog: '## 1.2.4\n',
    })
    fs.rmSync(path.join(repo, PINNED_PRICE))
    const r = runGate(repo, { ...PR_ENV, PR_HEAD_SHA: headSha, PR_TITLE: 'chore: promote (fixture/v1.2.4)' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/pinned deriver is unavailable/)
  })
})

// ─── regression: the pinned deriver produces the same verdicts as before ──────

describe('release-consistency — verdicts through the pinned deriver', () => {
  it('greens a promote PR whose title and CHANGELOG match the pinned re-price', () => {
    const { repo, headSha } = build({
      baseStack: STACK_STAGING_TRAIN,
      baseTags: ['fixture/v1.2.3'],
      headCommits: ['feat: a thing'],
      changelog: '## 1.3.0\n',
    })
    const r = runGate(repo, {
      ...PR_ENV,
      PR_HEAD_SHA: headSha,
      PR_TITLE: 'chore: promote staging to main (fixture/v1.3.0)',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/three-way agreement on 1\.3\.0/)
  })

  it('reds a push whose version file is behind the newest reachable tag (D14)', () => {
    const { repo, mainSha } = build({
      baseStack: 'release:\n  model: staging-train\n  component: fixture\n  version_files: [pkg.json]\n',
      baseTags: ['fixture/v1.2.3'],
      versionFile: { path: 'pkg.json', body: '{ "version": "1.2.2" }\n' },
    })
    const r = runGate(repo, { EVENT_NAME: 'push', PUSH_SHA: mainSha })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/is BEHIND/)
  })

  it('greens a push whose version file is at or ahead of the tag (D14)', () => {
    const { repo, mainSha } = build({
      baseStack: 'release:\n  model: staging-train\n  component: fixture\n  version_files: [pkg.json]\n',
      baseTags: ['fixture/v1.2.3'],
      versionFile: { path: 'pkg.json', body: '{ "version": "1.3.0" }\n' },
    })
    const r = runGate(repo, { EVENT_NAME: 'push', PUSH_SHA: mainSha })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/ok: pkg\.json/)
  })
})

// ─── provisioner behaviour: #385 items 2 and 5, executed ─────────────────────
//
// The provisioner talks to GitHub through `gh` exclusively, so a stub `gh` on
// PATH makes the whole script runnable end to end with zero network and zero
// mutation. That is what makes "the residual is written where a provisioner
// reads it" a testable claim rather than a promise about a comment.

const PROVISIONER = path.join(REPO_ROOT, 'scripts/provision-release-gate.sh')

type StubMode = 'fail' | 'silent-ok' | 'stack-without-release'

/**
 * A directory containing a fake `gh` behaving as `mode` dictates.
 *
 * `silent-ok` answers every call with exit 0 and NO output, which is what a
 * 404 on the contents API looks like through `gh api … --jq` — the real state
 * of roxabi-factory / roxabi-live, whose main carries no .dev/stack.yml at all.
 * `stack-without-release` returns a base64 stack.yml that exists but declares no
 * `release:` block. The two are different states with OPPOSITE push verdicts.
 */
function ghStub(mode: StubMode): string {
  const dir = scratch('gh-stub-')
  let body: string
  if (mode === 'fail') body = '#!/bin/sh\nexit 1\n'
  else if (mode === 'silent-ok') body = '#!/bin/sh\nexit 0\n'
  else {
    const b64 = Buffer.from('schema_version: "1.0"\nruntime: bun\n').toString('base64')
    body = `#!/bin/sh\ncase "$*" in\n  *contents/.dev/stack.yml*) printf '%s\\n' '${b64}' ;;\nesac\nexit 0\n`
  }
  fs.writeFileSync(path.join(dir, 'gh'), body, { mode: 0o755 })
  return dir
}

/**
 * `merge: true` runs the script with stderr redirected onto stdout, so `stdout`
 * is the single stream an operator's terminal shows. Ordering claims MUST use
 * it: `print_residual_risk` writes to stderr while `stub:`/`ruleset:` write to
 * stdout, so searching one captured buffer for both can only ever find one of
 * them — an ordering assertion across two independent buffers is not an ordering
 * assertion at all, and cannot fail.
 */
function runProvisioner(args: string[], stub: StubMode, opts: { merge?: boolean } = {}): GateResult {
  const env = gitEnv()
  const stubDir = ghStub(stub)
  env.PATH = `${stubDir}:${env.PATH}`
  // The stub is prepended, not exclusive — the runner's real `gh` is still on
  // PATH behind it. Prove resolution reached the stub rather than assuming it:
  // a fall-through produces a *different* provisioner run, which shows up as a
  // confusing assertion failure somewhere downstream instead of here.
  const resolved = spawnSync('sh', ['-c', 'command -v gh'], { encoding: 'utf8', env })
  const ghPath = (resolved.stdout ?? '').trim()
  if (ghPath !== path.join(stubDir, 'gh')) {
    throw new Error(
      `gh stub not resolved: PATH lookup found ${ghPath || '<nothing>'}, expected ${path.join(stubDir, 'gh')}`,
    )
  }
  const r = opts.merge
    ? spawnSync('sh', ['-c', 'exec bash "$@" 2>&1', 'sh', PROVISIONER, ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env,
      })
    : spawnSync('bash', [PROVISIONER, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('provision-release-gate.sh — pin resolution (#385 item 5)', () => {
  it('fails loudly and provisions nothing when the pin cannot be resolved', () => {
    // No hardcoded tag to fall back to, and a branch fallback is what this
    // refuses on principle — so an unreachable host repo stops the run before
    // either artifact is touched.
    const r = runProvisioner(['Roxabi/fixture-target'], 'fail')
    expect(r.status).toBe(5)
    expect(r.stderr).toMatch(/could not resolve a pin/)
    expect(r.stderr).toMatch(/does NOT fall back to a hardcoded tag/)
    expect(r.stdout).not.toMatch(/stub: (created|updated)/)
    expect(r.stdout).not.toMatch(/ruleset: created/)
  })

  it('rejects a branch pin before doing anything at all', () => {
    const r = runProvisioner(['Roxabi/fixture-target', '--ref', 'main'], 'silent-ok')
    expect(r.status).toBe(4)
    expect(r.stderr).toMatch(/is not an immutable pin/)
    expect(r.stdout).toBe('')
  })

  it('accepts a tag pin and a full commit sha', () => {
    for (const ref of ['roxabi-plugins/v9.9.9', 'a'.repeat(40)]) {
      const r = runProvisioner(['Roxabi/fixture-target', '--ref', ref], 'silent-ok')
      expect(r.stderr).not.toMatch(/is not an immutable pin/)
      expect(r.status).toBe(0)
    }
  })

  it('--remove works with the host repo unreachable — it is the escape hatch', () => {
    // Removal is what an operator runs the day the gate misfires. Making it
    // depend on resolving a pin would make the recovery path fail exactly when
    // the thing it recovers from is on fire.
    const r = runProvisioner(['Roxabi/fixture-target', '--remove'], 'fail')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/== removing release-consistency gate/)
    expect(r.stdout).toMatch(/== done ==/)
    expect(r.stderr).not.toMatch(/could not resolve a pin/)
  })
})

describe('provision-release-gate.sh — residual risk is shown before arming (#385 item 2)', () => {
  it('prints the stub-tampering residual and its three controls', () => {
    const r = runProvisioner(['Roxabi/fixture-target', '--ref', 'roxabi-plugins/v9.9.9'], 'silent-ok')
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/RESIDUAL RISK — this gate is NOT tamper-proof/)
    expect(r.stderr).toMatch(/rewrite the `uses:` job to `run: exit 0`/)
    expect(r.stderr).toMatch(/file_path_restriction/)
    expect(r.stderr).toMatch(/CODEOWNERS/)
    expect(r.stderr).toMatch(/org-level required workflow/)
    expect(r.stderr).toMatch(/catches DRIFT and MISTAKES, not a determined/)
  })

  it('shows the residual BEFORE either mutation, in the one stream an operator reads', () => {
    // Ordering is the whole claim, and it is only checkable on a MERGED stream:
    // the residual goes to stderr, `stub:`/`ruleset:` go to stdout, so an
    // assertion that searched a single captured buffer for both could never
    // fail — it would be measuring one stream's order against nothing.
    const r = runProvisioner(['Roxabi/fixture-target', '--ref', 'roxabi-plugins/v9.9.9'], 'silent-ok', {
      merge: true,
    })
    expect(r.status).toBe(0)
    const residualAt = r.stdout.search(/RESIDUAL RISK — this gate is NOT tamper-proof/)
    const policyAt = r.stdout.search(/^policy: /m)
    const stubAt = r.stdout.search(/stub: (created|updated|up to date)/)
    const rulesetAt = r.stdout.search(/ruleset: (created|already present)/)
    for (const at of [residualAt, policyAt, stubAt, rulesetAt]) expect(at).toBeGreaterThan(-1)
    expect(policyAt).toBeGreaterThan(residualAt)
    expect(stubAt).toBeGreaterThan(policyAt)
    expect(rulesetAt).toBeGreaterThan(stubAt)
  })
})

// ─── #385 item 5, corrected: ABSENT ≠ PRESENT-WITHOUT-RELEASE ────────────────
//
// Two states the advisory used to collapse into one message, and their push
// verdicts are opposite. Executed against the gate itself (see the D15c suites
// above): an absent .dev/stack.yml hits the push path's fail-closed contract
// guard (`refusing to gate`, exit 1), while a present file with no `release:`
// block reads `version_files: []` and early-greens.
describe('provision-release-gate.sh — target policy, per state (#385 item 5)', () => {
  const ARGS = ['Roxabi/fixture-target', '--ref', 'roxabi-plugins/v9.9.9']

  it('says RED-on-push when the target has no .dev/stack.yml at all (factory / live)', () => {
    // `silent-ok` = the contents API answering with nothing, which is the 404
    // shape — the state roxabi-factory and roxabi-live are actually in.
    const r = runProvisioner(ARGS, 'silent-ok')
    expect(r.stderr).toMatch(/policy: WARN — no \.dev\/stack\.yml at all/)
    expect(r.stderr).toMatch(/every push to main\s+→ RED/)
    expect(r.stderr).toMatch(/refusing[\s\S]{0,60}to gate/)
    // The promise it must NOT make for this state.
    expect(r.stderr).not.toMatch(/every push to main\s+→ early GREEN/)
    // Still an onboarding WARN, still not a refusal.
    expect(r.stderr).toMatch(/early GREEN \(head != staging\)/)
    expect(r.stderr).toMatch(/ONBOARDING/)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/== done ==/)
  })

  it('says GREEN-on-push when the file exists but carries no release: block', () => {
    const r = runProvisioner(ARGS, 'stack-without-release')
    expect(r.stderr).toMatch(/policy: WARN — \.dev\/stack\.yml present[\s\S]{0,80}no release\.component/)
    expect(r.stderr).toMatch(/every push to main\s+→ early GREEN \(version_files: \[\]\)/)
    expect(r.stderr).toMatch(/intended onboarding REFUSE, not a deadlock/)
    expect(r.stderr).not.toMatch(/every push to main\s+→ RED/)
    expect(r.status).toBe(0)
  })

  it('INVERTED: one message for both states is wrong for at least one of them', () => {
    // The falsifier for the split. The two runs must not produce the same
    // push-path verdict — that sameness IS the defect, because the gate's
    // behaviour differs (exit 1 vs exit 0).
    const PUSH_VERDICT = /every push to main\s+→ (RED|early GREEN)/
    const absent = runProvisioner(ARGS, 'silent-ok').stderr.match(PUSH_VERDICT)?.[1]
    const present = runProvisioner(ARGS, 'stack-without-release').stderr.match(PUSH_VERDICT)?.[1]
    expect(absent).toBe('RED')
    expect(present).toBe('early GREEN')
    expect(absent).not.toBe(present)
  })
})

// ─── m7: the host repo is not a provisioning target ──────────────────────────
describe('provision-release-gate.sh — refuses to overwrite the reusable workflow', () => {
  // $STUB_PATH and the reusable workflow's own path are the same string, so
  // targeting the host repo PUTs a ~45-line caller stub over the gate's logic —
  // and --remove deletes it. Both directions must stop before any mutation.
  for (const target of ['Roxabi/roxabi-plugins', 'roxabi-plugins', 'roxabi/ROXABI-PLUGINS']) {
    it(`exits 7 for '${target}' without touching anything`, () => {
      const r = runProvisioner([target, '--ref', 'roxabi-plugins/v9.9.9'], 'silent-ok')
      expect(r.status).toBe(7)
      expect(r.stderr).toMatch(/HOSTS the reusable workflow/)
      expect(r.stdout).toBe('')
    })
  }

  it('refuses --remove on the host repo too — that direction DELETES the reusable', () => {
    const r = runProvisioner(['Roxabi/roxabi-plugins', '--remove'], 'silent-ok')
    expect(r.status).toBe(7)
    expect(r.stdout).not.toMatch(/== removing/)
  })

  it('an ordinary target is unaffected', () => {
    const r = runProvisioner(['Roxabi/fixture-target', '--ref', 'roxabi-plugins/v9.9.9'], 'silent-ok')
    expect(r.status).toBe(0)
    expect(r.stderr).not.toMatch(/HOSTS the reusable workflow/)
  })
})
