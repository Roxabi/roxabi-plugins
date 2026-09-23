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
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) e[k] = v
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
    for (const subject of f.headCommits) git(repo, ['commit', '-q', '--allow-empty', '-m', subject])
    headSha = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['update-ref', `refs/remotes/origin/${headBranch}`, headSha])
    // The PR merge ref: base + head in the worktree, which is what
    // actions/checkout materialises on a pull_request.
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['merge', '--no-ff', '--no-commit', headBranch])
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

/** A directory containing a fake `gh` behaving as `mode` dictates. */
function ghStub(mode: 'fail' | 'silent-ok'): string {
  const dir = scratch('gh-stub-')
  const body = mode === 'fail' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\nexit 0\n'
  fs.writeFileSync(path.join(dir, 'gh'), body, { mode: 0o755 })
  return dir
}

function runProvisioner(args: string[], stub: 'fail' | 'silent-ok'): GateResult {
  const env = gitEnv()
  env.PATH = `${ghStub(stub)}:${env.PATH}`
  const r = spawnSync('bash', [PROVISIONER, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env })
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
  it('prints the stub-tampering residual and its three controls before either mutation', () => {
    const r = runProvisioner(['Roxabi/fixture-target', '--ref', 'roxabi-plugins/v9.9.9'], 'silent-ok')
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/RESIDUAL RISK — this gate is NOT tamper-proof/)
    expect(r.stderr).toMatch(/rewrite the `uses:` job to `run: exit 0`/)
    expect(r.stderr).toMatch(/file_path_restriction/)
    expect(r.stderr).toMatch(/CODEOWNERS/)
    expect(r.stderr).toMatch(/org-level required workflow/)
    expect(r.stderr).toMatch(/catches DRIFT and MISTAKES, not a determined/)

    // Ordering is the point: an operator who reads only the top of the output
    // has still read it before anything was armed.
    const stubAt = r.stdout.search(/stub: (created|updated|up to date)/)
    const rulesetAt = r.stdout.search(/ruleset: (created|already present)/)
    expect(stubAt).toBeGreaterThan(-1)
    expect(rulesetAt).toBeGreaterThan(stubAt)
  })

  it('reports the target\u2019s day-1 release policy and how to onboard, without blocking', () => {
    // The gh stub returns no .dev/stack.yml, which is the real state of
    // factory/live: no release: block on either branch. That must read as an
    // onboarding WARN with a path, not as a refusal — a blocking preflight would
    // stop a provisioning that is safe.
    const r = runProvisioner(['Roxabi/fixture-target', '--ref', 'roxabi-plugins/v9.9.9'], 'silent-ok')
    expect(r.stderr).toMatch(/policy: WARN — no release\.component/)
    expect(r.stderr).toMatch(/early GREEN \(head != staging\)/)
    expect(r.stderr).toMatch(/intended onboarding REFUSE, not a deadlock/)
    expect(r.stderr).toMatch(/ONBOARDING/)
    // Not blocking: the run completed and armed both artifacts.
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/== done ==/)
  })
})
