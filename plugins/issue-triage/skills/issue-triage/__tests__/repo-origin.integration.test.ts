import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type GitHubFake, ghCalls, REAL_BUN, recipeEnv, run, startGitHub, writeGh } from './fixtures/github-api'
import {
  CREDENTIAL,
  commentsOnlyRepoYaml,
  GIT_ENV,
  invalidRepoYaml,
  PARENT,
  PRODUCT,
  type RepoFixtureOptions,
  refusedOrigins,
  repoFixture,
  supportedOrigins,
  validPinYaml,
} from './fixtures/repo-identity'

const TRIAGE = join(import.meta.dirname, '../triage.ts')
const HELPERS = join(import.meta.dirname, '../../shared/adapters/config-helpers.ts')
const INIT = join(import.meta.dirname, '../lib/init.ts')

let root: string | undefined
let fake: GitHubFake | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

type Fixture = { root: string; cwd: string; bin: string; log: string; env: Record<string, string> }

function setup(options?: RepoFixtureOptions, env: Record<string, string> = {}): Fixture {
  const fixture = repoFixture(options)
  root = fixture.root
  writeGh(fixture.bin)
  const log = join(root, 'gh.log')
  return {
    ...fixture,
    log,
    env: {
      ...GIT_ENV,
      PATH: `${fixture.bin}:${dirname(REAL_BUN)}:/usr/bin:/bin`,
      HOME: root,
      GH_LOG: log,
      GH_REPO_SLUG: PARENT,
      ...env,
    },
  }
}

function codeInRepo(fixture: Fixture, source: string) {
  const script = join(fixture.root, 'probe.ts')
  writeFileSync(script, `import { detectGitHubRepo } from ${JSON.stringify(HELPERS)}\n${source}\n`)
  return run(`${JSON.stringify(REAL_BUN)} --no-env-file ${JSON.stringify(script)}`, fixture.cwd, fixture.env)
}

function resolveRepo(fixture: Fixture) {
  return codeInRepo(fixture, 'console.log(detectGitHubRepo())')
}

async function commands(fixture: Fixture) {
  fake = await startGitHub(fixture.root, [`${PRODUCT}#5`, `${PARENT}#5`])
  const env = recipeEnv(fake, fixture.bin, fixture.env)
  return {
    github: fake,
    triage: (args: string) => run(`bun --no-env-file ${JSON.stringify(TRIAGE)} ${args}`, fixture.cwd, env),
  }
}

const repoProbes = (fixture: Fixture) => ghCalls(fixture.log).filter(({ args }) => args.startsWith('repo view'))

describe('origin-first tracker discovery (#614)', () => {
  it('prefers origin in a two-remote product clone when gh names the kit parent and says why', async () => {
    const fixture = setup()
    const result = await resolveRepo(fixture)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(PRODUCT)
    expect(result.stderr).toContain(`Using ${PRODUCT} from git remote "origin"`)
    expect(result.stderr).toContain(`preferring origin over gh repo view (${PARENT})`)
    expect(repoProbes(fixture)).toHaveLength(1)
  })

  it('keeps the single remote and stays quiet even if gh would return a different spelling or name', async () => {
    const fixture = setup({ single: true, origin: 'https://github.com/Acme/old-name.git' }, { GH_REPO_SLUG: PRODUCT })
    const result = await resolveRepo(fixture)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('Acme/old-name')
    expect(result.stderr).toBe('')
    expect(repoProbes(fixture)).toEqual([])
  })

  it('keeps origin spelling and suppresses a case-only disagreement with gh', async () => {
    const fixture = setup({ origin: 'https://github.com/acme/product.git' }, { GH_REPO_SLUG: PRODUCT })
    const result = await resolveRepo(fixture)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('acme/product')
    expect(result.stderr).toBe('')
    expect(repoProbes(fixture)).toHaveLength(1)
  })

  it('falls back to gh when origin is absent', async () => {
    const fixture = setup({ origin: null })
    const result = await resolveRepo(fixture)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(PARENT)
    expect(result.stderr).toBe('')
    expect(repoProbes(fixture)).toHaveLength(1)
  })

  it.each([
    ['GITHUB_REPO', `https://github.com/${PRODUCT}.git`, 'Pin/env', { GITHUB_REPO: 'Pin/env' }],
    ['github_repo', `https://github.com/${PRODUCT}.git`, 'Pin/yaml', {}],
    ['GITHUB_REPO', 'git@gitlab.com:acme/product.git', 'Pin/env', { GITHUB_REPO: 'Pin/env' }],
    ['github_repo', 'git@gitlab.com:acme/product.git', 'Pin/yaml', {}],
  ] as const)('honors the %s pin over %s', async (_name, origin, repo, env) => {
    const fixture = setup({ yamlPin: 'Pin/yaml', origin }, env)
    const result = await resolveRepo(fixture)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(repo)
    expect(result.stderr).toBe('')
    expect(repoProbes(fixture)).toEqual([])
  })

  it.each(['Pin/yaml', "'Pin/yaml'", '"Pin/yaml"'])(
    'accepts multiline YAML pin %s ahead of usable origin',
    async (pin) => {
      const fixture = setup({ yamlPin: 'unused' })
      writeFileSync(join(fixture.cwd, '.dev/dev-core.yml'), `github_repo:\n  ${pin}\n`)
      const result = await resolveRepo(fixture)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('Pin/yaml')
      expect(repoProbes(fixture)).toEqual([])
    },
  )

  it.each(invalidRepoYaml)('refuses an invalid YAML %s instead of falling through to origin', async (_name, yaml) => {
    const fixture = setup({ yaml })
    const result = await resolveRepo(fixture)
    expect(result.code).not.toBe(0)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr).toContain('.dev/dev-core.yml')
    expect(repoProbes(fixture)).toEqual([])
  })

  it('accepts one literal pin in a YAML flow mapping', async () => {
    const result = await resolveRepo(setup({ yaml: '{ "github_repo": Pin/yaml }\n' }))
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('Pin/yaml')
  })

  it.each(validPinYaml)('honors the YAML pin when %s', async (_name, yaml) => {
    const fixture = setup({ yaml })
    const result = await resolveRepo(fixture)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('Pin/yaml')
    expect(repoProbes(fixture)).toEqual([])
  })

  it.each(['unrelated: setting\n', commentsOnlyRepoYaml, ''])('uses origin when YAML has no pin (%j)', async (yaml) => {
    const result = await resolveRepo(setup({ single: true, yaml }))
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(PRODUCT)
  })

  it('honors the environment pin without reading invalid project YAML', async () => {
    const result = await resolveRepo(setup({ yaml: 'github_repo: "unterminated\n' }, { GITHUB_REPO: 'Pin/env' }))
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('Pin/env')
  })

  it('refuses an alias configured only through core.sshCommand without executing that command', async () => {
    const fixture = setup({ origin: 'git@profile-only:Acme/product.git', single: true })
    const marker = join(fixture.root, 'profile-ran')
    const ssh = join(fixture.bin, 'profile-ssh')
    writeFileSync(ssh, '#!/bin/sh\ntouch "$SSH_MARKER"\nprintf "hostname github.com\\n"\n', { mode: 0o755 })
    const command = `${JSON.stringify(ssh)} -F work-profile`
    execFileSync('git', ['config', 'core.sshCommand', command], { cwd: fixture.cwd, env: fixture.env, stdio: 'pipe' })
    fixture.env.SSH_MARKER = marker
    const result = await resolveRepo(fixture)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Set GITHUB_REPO or github_repo')
    expect(existsSync(marker)).toBe(false)
    expect(repoProbes(fixture)).toEqual([])
  })

  it('uses plain SSH even when Git SSH command and variant settings are present', async () => {
    const fixture = setup(
      { origin: 'git@github-work:Acme/product.git', single: true },
      { GIT_SSH_COMMAND: 'false', GIT_SSH: '/not-an-ssh-program', GIT_SSH_VARIANT: 'plink' },
    )
    const result = await resolveRepo(fixture)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(PRODUCT)
  })

  it('refuses a literal github.com SSH origin if the effective host is foreign', async () => {
    const fixture = setup({ origin: 'git@github.com:Acme/product.git' })
    writeFileSync(join(fixture.bin, 'ssh'), '#!/bin/sh\nprintf "hostname gitlab.com\\n"\n')
    const result = await resolveRepo(fixture)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Set GITHUB_REPO or github_repo')
    expect(repoProbes(fixture)).toEqual([])
  })

  it.each(['git@github.com:Acme/product.git', 'ssh://git@ssh.github.com:443/Acme/product.git'])(
    'resolves literal GitHub SSH origin %s with no ssh executable on PATH',
    async (origin) => {
      const fixture = setup({ origin, single: true })
      const minimalBin = join(fixture.root, 'no-ssh-bin')
      mkdirSync(minimalBin)
      for (const name of ['bash', 'git']) symlinkSync(`/usr/bin/${name}`, join(minimalBin, name))
      fixture.env.PATH = minimalBin
      const result = await resolveRepo(fixture)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe(PRODUCT)
      expect(result.stderr).toBe('')
    },
  )

  it('times out a stalled SSH alias probe, terminates its descendant, and does not call gh', async () => {
    const fixture = setup({ origin: 'git@github-work:Acme/product.git' })
    const pidFile = join(fixture.root, 'ssh-child.pid')
    fixture.env.CHILD_PID_FILE = pidFile
    writeFileSync(join(fixture.bin, 'ssh'), '#!/bin/sh\nsleep 30 &\nprintf "%s\\n" "$!" > "$CHILD_PID_FILE"\nwait\n')
    const result = await resolveRepo(fixture)
    expect(result.signal).toBeNull()
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Set GITHUB_REPO or github_repo')
    expect(repoProbes(fixture)).toEqual([])
    const pid = readFileSync(pidFile, 'utf8').trim()
    const child = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' })
    if (child.status === 0) expect(child.stdout.trim()).toMatch(/^Z/)
  })

  it('keeps origin without a disagreement notice when gh repo view times out', async () => {
    const fixture = setup()
    writeFileSync(join(fixture.bin, 'gh'), '#!/bin/sh\nexec sleep 30\n')
    const result = await resolveRepo(fixture)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(PRODUCT)
    expect(result.stderr).toBe('')
  })

  it.each(supportedOrigins)('resolves %s as a GitHub repository', async (_name, origin) => {
    const result = await resolveRepo(setup({ origin, single: true }))
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(PRODUCT)
    expect(result.stderr).toBe('')
  })

  it.each(refusedOrigins)('refuses %s without falling back to gh or disclosing credentials', async (_name, origin) => {
    const fixture = setup({ origin })
    const result = await resolveRepo(fixture)
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Cannot use git remote "origin"')
    expect(result.stderr).not.toContain(CREDENTIAL)
    expect(repoProbes(fixture)).toEqual([])
  })
})

describe('origin-first triage commands', () => {
  it('plans init --dry-run for the detected product with stubbed writers', async () => {
    const result = await codeInRepo(
      setup(),
      `import { initIssues } from ${JSON.stringify(INIT)}
       const cwdRepo = detectGitHubRepo()
       const writes = { ensure: 0, update: 0, contract: 0 }
       await initIssues(['--dry-run'], {
         cwdRepo,
         listLabelNames: async (repo) => { console.log('labels read from ' + repo); return ['bug', 'size: XS'] },
         listIssueLabelSets: async () => [{ number: 5, labels: ['size: M'], body: '' }],
         readContract: () => null,
         ensureLabel: async () => { writes.ensure++; return 'created' },
         updateLabels: async () => { writes.update++ },
         writeContract: () => { writes.contract++ },
       })
       console.log(JSON.stringify(writes))`,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`repo: ${PRODUCT}`)
    expect(result.stdout).toContain(`labels read from ${PRODUCT}`)
    expect(result.stdout).toContain('writes: 0')
    expect(result.stdout).toContain('{"ensure":0,"update":0,"contract":0}')
    expect(result.stdout).not.toContain(PARENT)
  })

  it('uses product for init --dry-run with no repo flag and accepts the local origin slug', async () => {
    const { triage } = await commands(setup())
    for (const flags of ['', `--repo ${PRODUCT}`]) {
      const result = await triage(`init --dry-run ${flags}`)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`repo: ${PRODUCT}`)
      expect(result.stdout).toContain('contract: write')
      expect(result.stdout).toContain('writes: 0')
      expect(result.stdout).not.toContain(PARENT)
    }
  })

  it('accepts a case-only init --repo mismatch while refusing a genuinely unrelated repo', async () => {
    const { triage } = await commands(setup({ origin: 'https://github.com/acme/product.git' }))
    const same = await triage(`init --dry-run --repo ${PRODUCT}`)
    expect(same.code).toBe(0)
    expect(same.stdout).toContain(`repo: ${PRODUCT}`)
    expect(same.stdout).toContain('contract: write')
    expect(same.stdout).not.toContain('is not the local repo')
    const other = await triage('init --dry-run --repo Other/unrelated')
    expect(other.stdout).toContain('contract: skip-other-repo')
    expect(other.stdout).toContain('Other/unrelated is not the local repo acme/product')
  })

  it('refuses a credential-bearing --repo before repository discovery or output', async () => {
    const fixture = setup()
    const { github, triage } = await commands(fixture)
    const value = `https://user:${CREDENTIAL}@github.com/Acme/product`
    const result = await triage(`init --dry-run --repo ${value}`)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('init: --repo needs owner/repo')
    expect(result.stdout + result.stderr).not.toContain(CREDENTIAL)
    expect(ghCalls(fixture.log)).toEqual([])
    expect(github.calls).toEqual([])
  })

  it('targets product, not the kit parent, in fresh create and set processes', async () => {
    const { github, triage } = await commands(setup())
    const created = await triage('create --title "Tracker identity" --type fix')
    expect(created.code).toBe(0)
    expect(github.created).toMatchObject([{ repo: PRODUCT, title: 'Tracker identity', type: 'fix' }])
    const updated = await triage('set 5 --body "Product only"')
    expect(updated.code).toBe(0)
    expect(github.issues.get(`${PRODUCT}#5`)?.body).toBe('Product only')
    expect(github.issues.get(`${PARENT}#5`)?.body).toBe('')
    expect(github.calls.filter(({ op }) => op === 'patch')).toMatchObject([
      { method: 'PATCH', path: `/repos/${PRODUCT}/issues/5` },
    ])
  })
})
