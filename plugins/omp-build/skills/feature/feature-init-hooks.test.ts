import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { migrateLabel } from '../../../issue-triage/skills/issue-triage/lib/migrate-labels'
import {
  baseFacts,
  factsFor,
  factsIn,
  fixtureRoot,
  originAcme,
  recordedGh,
  recordedParseYaml,
  scratchCopy,
} from './feature-init.fixture'
import { ownerRepoFromRemote, plan, readFacts } from './feature-init-facts'
import { hasSemctxGitHooks, semctxHooks } from './feature-init-hooks'
import { applyStack } from './feature-init-stack'
import { IssueTriageMissing, type MigrateLabel, resolveMigrateLabel } from './feature-init-triage'

let staged = ''
let scratch: string | undefined
beforeAll(() => {
  staged = fixtureRoot()
})
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})
describe('semctx hooks: git-hook groups only', () => {
  it('still asks for semctx hooks when only a manual pr: group runs semctx', async () => {
    const facts = await factsFor('pr-only')
    expect(facts.hooks).toBe('absent')
    expect(plan(facts)).toContain('semctx hooks')
  })

  it('does not ask for semctx hooks when a pre-push command runs semctx', async () => {
    const facts = await factsFor('hooks-ok')
    expect(facts.hooks).toBe('present')
    expect(plan(facts)).not.toContain('semctx hooks')
  })

  it('reads the parsed document, not the text', () => {
    expect(hasSemctxGitHooks({ pr: { commands: { x: { run: 'semctx verify' } } } })).toBe(false)
    expect(hasSemctxGitHooks({ 'pre-commit': { commands: { x: { run: 'semctx verify' } } } })).toBe(true)
  })
})

describe('feature init when landing already exists', () => {
  it.each([
    ['acme', { hasWorkingEmptyJob: false, hasAssertledger: false, landingHidesChecks: false }],
    ['kept', { hasWorkingEmptyJob: true, hasAssertledger: true, landingHidesChecks: false }],
    ['kept-hidden', { hasWorkingEmptyJob: true, hasAssertledger: true, landingHidesChecks: true }],
  ])('%s: CI job, assertledger and landing facts', async (name, expected) => {
    expect(await factsFor(name)).toMatchObject(expected)
  })

  it('names a recorded required_checks list in the kept line', async () => {
    const lines = plan(await factsFor('kept-hidden'))
    expect(lines).toContain('landing kept (existing; required_checks hides other checks)')
    expect(lines).not.toContain('CI job semctx-working-empty')
    expect(lines).not.toContain('assertledger')
  })

  it('prints landing kept and leaves the stack alone', async () => {
    const dir = scratchCopy('kept')
    const before = readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')
    const facts = await factsIn(dir, 'kept')
    expect(plan(facts)).toContain('landing kept (existing)')
    expect(plan(facts).some((line) => line.startsWith('landing = merge-on-green'))).toBe(false)
    applyStack(dir, facts)
    expect(readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')).toBe(before)
  })
})

describe('issue-triage load', () => {
  it('blocks when migrateLabel is not a function', async () => {
    await expect(resolveMigrateLabel(async () => null as unknown as MigrateLabel)).rejects.toBeInstanceOf(
      IssueTriageMissing,
    )
    await expect(
      readFacts(path.join(staged, 'acme'), {
        gh: recordedGh('acme'),
        gitRemoteUrl: originAcme,
        migrateLabel: null as unknown as MigrateLabel,
        parseYaml: recordedParseYaml('acme'),
      }),
    ).rejects.toBeInstanceOf(IssueTriageMissing)
  })
})

describe('ownerRepoFromRemote', () => {
  it.each([
    ['git@github.com:acme/app.git', 'acme/app'],
    ['https://github.com/acme/app.git', 'acme/app'],
    ['ssh://git@github.com:22/acme/app', 'acme/app'],
    ['https://GitHub.com/acme/app', 'acme/app'],
    ['git@ghe.acme.test:acme/app.git', null],
    ['https://ghe.acme.test/acme/app', null],
    ['git@gitlab.acme.test:acme/app.git', null],
    ['https://github.com./acme/app', null],
    ['git@github.com.:acme/app.git', null],
    ['acme-alias:acme/app.git', null],
    ['ssh://git@10.0.0.7:2222/acme/app', null],
    ['https://[::1]/acme/app', null],
    ['/srv/git/app.git', null],
    ['../app', null],
    ['file:///srv/git/acme/app.git', null],
    ['file://nas/acme/app.git', null],
    ['https://gitlab.acme.test/group/sub/app.git', null],
    ['https://github.com/acme', null],
    ['git@GitHub.COM:acme/app.git', 'acme/app'],
    ['ftp://github.com/acme/app.git', null],
    ['https://github.com/acme/app/tree', null],
    ['', null],
    [null, null],
  ])('%s → %s', (url, repo) => {
    expect(ownerRepoFromRemote(url)).toBe(repo)
  })

  it.each([
    ['a GitLab-style two-segment origin', 'git@gitlab.acme.test:acme/app.git'],
    ['a GHE origin', 'https://ghe.acme.test/acme/app.git'],
    ['a trailing-dot github.com origin', 'https://github.com./acme/app'],
  ])('never calls gh for %s', async (_row, url) => {
    const seen: string[][] = []
    const facts = await readFacts(path.join(staged, 'acme'), {
      gh: (args) => {
        seen.push(args)
        return 'size: M\n'
      },
      gitRemoteUrl: (remote) => (remote === 'origin' ? url : null),
      migrateLabel,
      parseYaml: recordedParseYaml('acme'),
    })
    expect(seen).toEqual([])
    expect(plan(facts)).toContain('labels unknown (non-GitHub origin)')
    expect(plan(facts)).not.toContain('label migration')
  })
})

describe('semctx hook detection', () => {
  const hook = (body: unknown) => hasSemctxGitHooks({ 'pre-push': body })
  it.each([
    ['a command key', { commands: { 'widget-semctx': { run: 'echo ok' } } }, true],
    ['a command run', { commands: { guard: { run: 'semctx verify --diff' } } }, true],
    ['a skipped command', { commands: { guard: { run: 'semctx verify', skip: true } } }, false],
    ['a skipped group', { skip: true, commands: { guard: { run: 'semctx verify' } } }, false],
    ['a conditional skip', { commands: { guard: { run: 'semctx verify', skip: ['merge'] } } }, true],
    ['an exclude glob only', { commands: { lint: { run: 'bun lint', exclude: '.semctx/**' } } }, false],
    ['a scripts key', { scripts: { 'semctx-guard.sh': { runner: 'bash' } } }, true],
    ['a skipped script', { scripts: { 'semctx-guard.sh': { runner: 'bash', skip: true } } }, false],
    ['a job run', { jobs: [{ name: 'guard', run: 'semctx verify' }] }, true],
    ['a job name', { jobs: [{ name: 'widget-semctx-guard', run: 'bash scripts/guard.sh' }] }, true],
    ['a job script', { jobs: [{ script: 'semctx-guard.sh', runner: 'bash' }] }, true],
    ['a skipped job', { jobs: [{ run: 'semctx verify', skip: true }] }, false],
    ['a nested group job', { jobs: [{ group: { jobs: [{ run: 'semctx verify' }] } }] }, true],
    ['a skipped nested group', { jobs: [{ group: { skip: true, jobs: [{ run: 'semctx verify' }] } }] }, false],
  ])('%s → %s', (_row, body, expected) => {
    expect(hook(body)).toBe(expected)
  })

  function withLefthook(files: Record<string, unknown>) {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-lefthook-'))
    const docs = new Map<string, unknown>()
    for (const [rel, doc] of Object.entries(files)) {
      const text = `# ${rel}\n`
      mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true })
      writeFileSync(path.join(scratch, rel), text)
      docs.set(text, doc)
    }
    return semctxHooks(scratch, (text) => {
      if (!docs.has(text)) throw new Error('unreadable')
      return docs.get(text)
    })
  }

  const guarded = { 'pre-push': { commands: { guard: { run: 'semctx verify' } } } }
  it('reads a comment-only lefthook.yml (null document) as having no hook', () => {
    expect(withLefthook({ 'lefthook.yml': null })).toBe('absent')
  })

  it('prefers a YAML main config over a foreign file beside it', () => {
    expect(withLefthook({ 'lefthook.yml': guarded, 'lefthook.toml': null })).toBe('present')
  })

  it('reports a .config/lefthook.toml as unknown', () => {
    expect(withLefthook({ '.config/lefthook.toml': null })).toBe('lefthook.toml')
  })

  it('reads .config/lefthook.yml when it is the only config', () => {
    expect(withLefthook({ '.config/lefthook.yml': guarded })).toBe('present')
  })

  it('applies a local override that skips the command', () => {
    expect(
      withLefthook({
        'lefthook.yml': guarded,
        'lefthook-local.yml': { 'pre-push': { commands: { guard: { skip: true } } } },
      }),
    ).toBe('absent')
  })

  it('merges a local override key by key, keeping the main commands', () => {
    expect(withLefthook({ 'lefthook.yml': guarded, 'lefthook-local.yml': { 'pre-push': { parallel: true } } })).toBe(
      'present',
    )
  })

  it.each([
    ['a list document', []],
    ['a scalar document', 'widget'],
  ])('reports %s as unreadable', (_row, doc) => {
    expect(withLefthook({ 'lefthook.yml': doc })).toBe('unreadable')
  })

  it.each(['toml', 'json', 'jsonc'])('reports a lefthook.%s config as unknown, not absent', async (ext) => {
    const dir = scratchCopy('pr-only')
    rmSync(path.join(dir, 'lefthook.yml'))
    writeFileSync(path.join(dir, `lefthook.${ext}`), '')
    const facts = await factsIn(dir, 'pr-only')
    expect(facts.hooks).toBe(`lefthook.${ext}`)
    expect(plan(facts)).toContain(`semctx hooks unknown (lefthook.${ext})`)
    expect(plan(facts)).not.toContain('semctx hooks')
  })

  it('reports extends as unknown unless a local hook already runs semctx', () => {
    expect(withLefthook({ 'lefthook.yml': { remotes: [{ git_url: 'x' }] } })).toBe('extends')
    expect(withLefthook({ 'lefthook.yml': { extends: ['shared/lefthook.yml'] } })).toBe('extends')
    expect(withLefthook({ 'lefthook.yml': { ...guarded, remotes: [{ git_url: 'x' }] } })).toBe('present')
  })

  it('prints semctx hooks unknown when lefthook.yml cannot be parsed', async () => {
    const dir = scratchCopy('acme')
    const facts = await readFacts(dir, {
      gh: recordedGh('acme'),
      gitRemoteUrl: originAcme,
      migrateLabel,
      parseYaml: () => {
        throw new Error('bad YAML')
      },
    })
    expect(facts.hooks).toBe('unreadable')
    expect(plan(facts)).toContain('semctx hooks unknown (lefthook.yml unreadable)')
    expect(plan(facts)).not.toContain('semctx hooks')
  })

  it('prints extends as unknown in the plan', () => {
    expect(plan({ ...baseFacts(), hasSemctx: true, hooks: 'extends' })).toContain('semctx hooks unknown (extends)')
  })
})
