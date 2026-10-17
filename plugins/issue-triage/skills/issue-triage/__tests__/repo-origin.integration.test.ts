import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkout, type GitHubFake, recipeEnv, run, startGitHub, writeGh } from './fixtures/github-api'

/**
 * #614: a product clone (`upstream` = kit parent, `origin` = product) resolves
 * its tracker to the product even when `gh repo view` names the parent. Every
 * row runs in a fresh process: `GITHUB_REPO` is a constant fixed at import time,
 * so only a fresh import proves the path `create` and `set` actually take.
 */
const PRODUCT = 'Acme/product'
const PARENT = 'Kit/parent'
const TRIAGE = path.resolve(import.meta.dirname, '..', 'triage.ts')
const HELPERS = path.resolve(import.meta.dirname, '..', '..', 'shared', 'adapters', 'config-helpers.ts')

let root: string | undefined
let fake: GitHubFake | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** `gh repo view` answers `GH_REPO_SLUG`; every other call is the shared stub's. */
function writeGhViewing(bin: string): void {
  const shared = path.join(path.dirname(bin), 'shared-bin')
  writeGh(shared)
  mkdirSync(bin, { recursive: true })
  const wrapper = path.join(bin, 'gh')
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'if [ "$1" = repo ] && [ "$2" = view ]; then',
      '  if [ -z "$GH_REPO_SLUG" ]; then echo "gh: no default repository" >&2; exit 1; fi',
      '  printf "%s\\n" "$GH_REPO_SLUG"',
      '  exit 0',
      'fi',
      `exec ${JSON.stringify(path.join(shared, 'gh'))} "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(wrapper, 0o755)
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'pipe',
  })
}

type World = { repo: string; env: Record<string, string>; ghLog: string; fake: GitHubFake }

/**
 * `origin` = PRODUCT. `upstream` = PARENT unless `single`. `ghSays` is what the
 * stub `gh repo view` returns (empty: it fails). `origin: false` drops the remote.
 */
async function world(
  opts: { single?: boolean; ghSays?: string; origin?: boolean; env?: Record<string, string> } = {},
): Promise<World> {
  root = mkdtempSync(path.join(tmpdir(), 'issue-triage-origin-'))
  fake = await startGitHub(root, [`${PRODUCT}#5`])
  const repo = checkout(path.join(root, 'product'), PRODUCT)
  if (opts.origin === false) git(repo, 'remote', 'remove', 'origin')
  if (!opts.single) git(repo, 'remote', 'add', 'upstream', `https://github.com/${PARENT}.git`)
  const bin = path.join(root, 'bin')
  writeGhViewing(bin)
  const ghLog = path.join(root, 'gh.log')
  const env = recipeEnv(fake, bin, { GH_LOG: ghLog, GH_REPO_SLUG: opts.ghSays ?? PARENT, ...opts.env })
  return { repo, env, ghLog, fake }
}

/** Resolve through `detectGitHubRepo()`, or the import-time `GITHUB_REPO` constant. */
function probe(w: World, via: 'detect' | 'constant' = 'detect') {
  const script = path.join(path.dirname(w.repo), `probe-${via}.ts`)
  const name = via === 'detect' ? 'detectGitHubRepo' : 'GITHUB_REPO'
  const value = via === 'detect' ? 'detectGitHubRepo()' : 'GITHUB_REPO'
  writeFileSync(script, `import { ${name} } from ${JSON.stringify(HELPERS)}\nprocess.stdout.write(String(${value}))\n`)
  return run(`bun --no-env-file ${JSON.stringify(script)}`, w.repo, w.env)
}

function triage(w: World, args: string) {
  return run(`bun --no-env-file ${JSON.stringify(TRIAGE)} ${args}`, w.repo, w.env)
}

describe('issue-triage prefers origin over gh repo view (#614)', () => {
  it('resolves a two-remote clone to origin when gh names the parent, and says why', async () => {
    const w = await world()
    const ran = await probe(w)

    expect(ran.code).toBe(0)
    expect(ran.stdout).toBe(PRODUCT)
    expect(ran.stderr).toContain(PRODUCT)
    expect(ran.stderr).toContain(PARENT)
    expect(ran.stderr).toContain('origin')
  })

  it('stays quiet and resolves to origin on a single-remote clone', async () => {
    const w = await world({ single: true, ghSays: PRODUCT })
    const ran = await probe(w)

    expect(ran.code).toBe(0)
    expect(ran.stdout).toBe(PRODUCT)
    expect(ran.stderr).toBe('')
  })

  it('falls back to gh repo view when origin is absent', async () => {
    const w = await world({ single: true, origin: false, ghSays: PARENT })
    const ran = await probe(w)

    expect(ran.code).toBe(0)
    expect(ran.stdout).toBe(PARENT)
    expect(ran.stderr).toBe('')
  })

  it('resolves the import-time GITHUB_REPO constant to origin', async () => {
    const w = await world()
    const ran = await probe(w, 'constant')

    expect(ran.code).toBe(0)
    expect(ran.stdout).toBe(PRODUCT)
  })

  it('lets a GITHUB_REPO pin win over origin and gh, silently', async () => {
    const w = await world({ env: { GITHUB_REPO: 'Pin/env' } })
    const ran = await probe(w)

    expect(ran.stdout).toBe('Pin/env')
    expect(ran.stderr).toBe('')
  })

  it('lets a dev-core.yml pin naming another repo win over origin and gh, silently', async () => {
    const w = await world()
    mkdirSync(path.join(w.repo, '.dev'))
    writeFileSync(path.join(w.repo, '.dev', 'dev-core.yml'), 'github_repo: Pin/yaml\n')
    const ran = await probe(w)

    expect(ran.stdout).toBe('Pin/yaml')
    expect(ran.stderr).toBe('')
  })

  it('lets the env pin win over the yaml pin', async () => {
    const w = await world({ env: { GITHUB_REPO: 'Pin/env' } })
    mkdirSync(path.join(w.repo, '.dev'))
    writeFileSync(path.join(w.repo, '.dev', 'dev-core.yml'), 'github_repo: Pin/yaml\n')
    const ran = await probe(w)

    expect(ran.stdout).toBe('Pin/env')
  })

  it('plans the product, not the parent, on init --dry-run', async () => {
    const w = await world()
    const ran = await triage(w, 'init --dry-run')

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain(`repo: ${PRODUCT}`)
    expect(ran.stdout).toContain('writes: 0')
    expect(ran.stdout).not.toContain('refused: init: --repo')
    expect(ran.stdout).not.toContain(PARENT)
  })

  it('accepts init --repo <origin slug> as the local repo', async () => {
    const w = await world()
    const ran = await triage(w, `init --dry-run --repo ${PRODUCT}`)

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain(`repo: ${PRODUCT}`)
    expect(ran.stdout).not.toContain('is not the local repo')
  })

  it('still refuses init --repo for an unrelated repository', async () => {
    const w = await world()
    const ran = await triage(w, 'init --dry-run --repo Other/unrelated')

    expect(ran.stdout).toContain(`refused: init: --repo Other/unrelated is not the local repo ${PRODUCT}`)
  })

  it('creates the issue in the product', async () => {
    const w = await world()
    const ran = await triage(w, "create --title 'Tracker identity' --type fix")

    expect(ran.code).toBe(0)
    expect(w.fake.created.map((issue) => issue.repo)).toEqual([PRODUCT])
    expect(w.fake.calls.map((call) => call.path).filter((p) => p.includes('Kit/parent'))).toEqual([])
  })

  it('sets the product issue, not the parent issue of the same number', async () => {
    const w = await world()
    const ran = await triage(w, 'set 5 --type fix')

    expect(ran.code).toBe(0)
    expect(w.fake.issues.get(`${PRODUCT}#5`)?.type).toBe('fix')
    const paths = w.fake.calls.map((call) => call.path)
    expect(paths).toContain('/repos/Acme/product/issues/5')
    expect(paths.filter((p) => p.includes('Kit/parent'))).toEqual([])
  })
})
