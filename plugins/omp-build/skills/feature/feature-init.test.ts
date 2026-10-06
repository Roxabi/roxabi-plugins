import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { migrateLabel } from '../../../issue-triage/skills/issue-triage/lib/migrate-labels'
import { FIXTURE_NAMES, stageFixture } from './__fixtures__/feature-init/stage'
import {
  applyStack,
  type Facts,
  type Gh,
  hasSemctxGitHooks,
  IssueTriageMissing,
  loadMigrateLabel,
  type MigrateLabel,
  migrateLabelCandidates,
  ownerRepoFromRemote,
  type ParseYaml,
  plan,
  readFacts,
  resolveMigrateLabel,
  semctxHooks,
  trustedDir,
} from './feature-init'

let staged = ''
beforeAll(() => {
  staged = mkdtempSync(path.join(tmpdir(), 'omp-init-fixtures-'))
  for (const name of FIXTURE_NAMES) stageFixture(name, path.join(staged, name))
})
afterAll(() => rmSync(staged, { recursive: true, force: true }))

let scratch: string | undefined
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

/** A fresh copy of fixture `name`, for tests that write into the target. */
function scratchCopy(name: string): string {
  scratch = mkdtempSync(path.join(tmpdir(), `omp-init-${name}-`))
  return stageFixture(name, path.join(scratch, name))
}

const originAcme = (remote: string) =>
  remote === 'origin'
    ? 'git@github.com:acme/app.git'
    : remote === 'upstream'
      ? 'git@github.com:acme/kit-upstream.git'
      : null

function fixtureFile(name: string, rel: string): string {
  return readFileSync(path.join(staged, name, rel), 'utf8')
}

function recordedArgv(name: string): string[] {
  return fixtureFile(name, 'gh/label-list.argv').trim().split('\n')
}

/** Answers only the exact recorded argv; anything else is a gh failure (null). */
function recordedGh(name: string, body: string | null = fixtureFile(name, 'gh/labels.txt')): Gh {
  const expected = recordedArgv(name).join('\0')
  return (args) => (args.join('\0') === expected ? body : null)
}

/**
 * Vitest has no Bun.YAML: answer with the Bun-parsed snapshot of the fixture's
 * lefthook.yml. The integration suite proves each snapshot equals Bun.YAML.parse.
 */
function recordedParseYaml(name: string): ParseYaml {
  const answers = new Map<string, unknown>([
    [fixtureFile(name, 'lefthook.yml'), JSON.parse(fixtureFile(name, 'lefthook.parsed.json'))],
    [fixtureFile(name, '.dev/stack.yml'), JSON.parse(fixtureFile(name, 'stack.parsed.json'))],
  ])
  return (input) => {
    if (!answers.has(input)) throw new Error(`unexpected YAML input for fixture ${name}`)
    return answers.get(input)
  }
}

function factsIn(dir: string, name: string, gh: Gh = recordedGh(name)) {
  return readFacts(dir, { gh, gitRemoteUrl: originAcme, migrateLabel, parseYaml: recordedParseYaml(name) })
}

function factsFor(name: string, gh?: Gh) {
  return factsIn(path.join(staged, name), name, gh)
}

describe('feature init on the fictional acme fixture', () => {
  it('lists the adoption gaps', async () => {
    expect(plan(await factsFor('acme'))).toEqual([
      'tracker contract',
      'label migration',
      'semctx hooks',
      '3 orphan contracts',
      'assertledger + vitest adapter',
      'landing = merge-on-green (every check; gates: widget-audit ; (widget-build|widget-build-full) ; Widget scan, nightly|widget-scan)',
      'worktree block',
      'release.post_merge asked',
    ])
  })

  it('counts a change block whose own status is active, in the real semctx grammar', async () => {
    // Decoys: an `invariant` block whose `status: active` is its own vocabulary, `status: active-draft`,
    // `note: was status: active` inside a verified change, a verified change that talks about active work,
    // and a non-.sem file.
    expect((await factsFor('acme')).activeContracts).toBe(3)
  })

  it('ignores a package script that only mentions the tool', async () => {
    expect((await factsFor('acme')).hasAssertledger).toBe(false)
  })

  const WIDGET = { name: 'widget-app', private: true }
  it.each([
    ['a root vitest dependency', { 'package.json': { ...WIDGET, devDependencies: { vitest: '1.0.0' } } }, true],
    [
      'only a scoped @vitest/* root dependency',
      { 'package.json': { ...WIDGET, devDependencies: { '@vitest/coverage-v8': '1.0.0' } } },
      true,
    ],
    [
      'a workspace package that depends on vitest',
      {
        'package.json': { ...WIDGET, workspaces: ['apps/*', 'packages/**'] },
        'packages/widget/core/package.json': { name: 'widget-core', devDependencies: { vitest: '1.0.0' } },
      },
      true,
    ],
    [
      'an excluded workspace package',
      {
        'package.json': { ...WIDGET, workspaces: ['apps/*', '!apps/legacy'] },
        'apps/legacy/package.json': { name: 'widget-legacy', devDependencies: { vitest: '1.0.0' } },
      },
      false,
    ],
    [
      'a package outside the workspaces globs',
      {
        'package.json': { ...WIDGET, workspaces: ['apps/*'] },
        'tools/bench/package.json': { name: 'widget-bench', devDependencies: { vitest: '1.0.0' } },
      },
      false,
    ],
    ['a vitest.config file', { 'package.json': WIDGET, 'vitest.config.ts': '' }, true],
    ['a vitest.workspace file', { 'package.json': WIDGET, 'vitest.workspace.json': '' }, true],
    [
      'a script that only mentions vitest',
      {
        'package.json': {
          ...WIDGET,
          scripts: { test: 'vitest run' },
          devDependencies: { 'widget-vitest-reporter': '1.0.0' },
        },
      },
      false,
    ],
  ])('vitest adapter for %s → %s', async (_row, files, adapter) => {
    const dir = scratchCopy('acme')
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body))
    }
    const lines = plan(await factsIn(dir, 'acme'))
    expect(lines).toContain(adapter ? 'assertledger + vitest adapter' : 'assertledger')
    expect(lines).not.toContain(adapter ? 'assertledger' : 'assertledger + vitest adapter')
  })

  it('decides label migration with issue-triage grammar', async () => {
    const facts = await factsFor('acme')
    expect(facts.legacyLabels).toEqual(['size: M', 'priority: high', 'ready-for-agent'])
  })

  it.each([
    ['a character class holding a slash', "probes.some((r) => /^widget[/]build$/.test(r.name || ''))"],
    ['an unbalanced group', "probes.some((r) => /(widget-build/.test(r.name || ''))"],
  ])('skips a gate literal with %s and keeps the others', async (_row, line) => {
    const dir = scratchCopy('acme')
    const workflow = path.join(dir, '.github', 'workflows', 'merge-on-green.yml')
    writeFileSync(workflow, `${readFileSync(workflow, 'utf8')}            const odd = ${line};\n`)
    const facts = await factsIn(dir, 'acme')
    expect(facts.gates).toEqual([
      'widget-audit',
      '(widget-build|widget-build-full)',
      'Widget scan, nightly|widget-scan',
    ])
  })

  it('prints gates: unknown when no gate can be parsed', async () => {
    const dir = scratchCopy('acme')
    writeFileSync(path.join(dir, '.github', 'workflows', 'merge-on-green.yml'), 'name: Widget Gate\njobs: {}\n')
    expect(plan(await factsIn(dir, 'acme'))).toContain('landing = merge-on-green (every check; gates: unknown)')
  })

  it('never calls gh without a GitHub origin', async () => {
    const seen: string[][] = []
    const facts = await readFacts(path.join(staged, 'acme'), {
      gh: (args) => {
        seen.push(args)
        return 'size: M\n'
      },
      gitRemoteUrl: () => null,
      migrateLabel,
      parseYaml: recordedParseYaml('acme'),
    })
    expect(seen).toEqual([])
    expect(facts.labels).toEqual([])
    expect(plan(facts)).toContain('labels unknown (no GitHub origin)')
    expect(plan(facts)).not.toContain('label migration')
  })

  const recorded = 'size: M\npriority: high\nready-for-agent\nbug\n'
  it.each([
    {
      row: 'recorded answer',
      gh: () => recordedGh('acme'),
      labels: ['size: M', 'priority: high', 'ready-for-agent', 'bug'],
      line: 'label migration',
    },
    { row: 'gh failure (null)', gh: () => recordedGh('acme', null), labels: [], line: 'labels unknown (gh failed)' },
    { row: 'empty label list', gh: () => recordedGh('acme', ''), labels: [], line: 'labels' },
    {
      row: 'CRLF answer',
      gh: () => recordedGh('acme', 'size: M\r\npriority: high\r\n'),
      labels: ['size: M', 'priority: high'],
      line: 'label migration',
    },
    {
      row: 'argv that is not the recorded one',
      gh: (): Gh => {
        const wrong = recordedArgv('acme').filter((arg) => arg !== '--jq' && arg !== '.[].name')
        return (args) => (args.join('\0') === wrong.join('\0') ? recorded : null)
      },
      labels: [],
      line: 'labels unknown (gh failed)',
    },
  ])('labels: $row', async ({ gh, labels, line }) => {
    const facts = await factsFor('acme', gh())
    const lines = plan(facts)
    expect(facts.labels).toEqual(labels)
    expect(lines).toContain(line)
    for (const other of ['label migration', 'labels', 'labels unknown (gh failed)']) {
      if (other !== line) expect(lines).not.toContain(other)
    }
  })

  it('passes -R owner/repo from origin, never the upstream remote', async () => {
    const seen: string[][] = []
    await factsFor('acme', (args) => {
      seen.push(args)
      return null
    })
    expect(seen).toEqual([recordedArgv('acme')])
    expect(seen.flat().join(' ')).not.toContain('kit-upstream')
  })

  it('writes a landing without required_checks under merge-on-green', async () => {
    const dir = scratchCopy('acme')
    applyStack(dir, await factsIn(dir, 'acme'))
    const stack = readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')
    expect(stack).toMatch(/^landing:\n {2}mode: merge-on-green\n/m)
    expect(stack).not.toContain('required_checks')
  })

  it('creates .dev before writing the stack', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-mkdir-'))
    applyStack(scratch, { ...(await factsFor('acme')), hasWorktree: false, hasLanding: false, mergeOnGreen: true })
    expect(readFileSync(path.join(scratch, '.dev', 'stack.yml'), 'utf8')).toContain('mode: merge-on-green')
  })
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
    ['acme', { hasAssertledger: false, landingHidesChecks: false }],
    ['kept', { hasAssertledger: true, landingHidesChecks: false }],
    ['kept-hidden', { hasAssertledger: true, landingHidesChecks: true }],
  ])('%s: assertledger and landing facts', async (name, expected) => {
    expect(await factsFor(name)).toMatchObject(expected)
  })

  it('names a recorded required_checks list in the kept line', async () => {
    const lines = plan(await factsFor('kept-hidden'))
    expect(lines).toContain('landing kept (existing; required_checks hides other checks)')
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

describe('an existing landing', () => {
  /** `kept` in a scratch copy, its stack.yml carrying `onDisk` lines, parsed as `landing`. */
  async function keptWithLanding(landing: unknown, onDisk = '') {
    const dir = scratchCopy('kept')
    const stackPath = path.join(dir, '.dev', 'stack.yml')
    if (onDisk) {
      const text = readFileSync(stackPath, 'utf8')
      if (!text.includes('  mode: merge-on-green\n')) throw new Error('kept fixture has no merge-on-green landing')
      writeFileSync(stackPath, text.replace('  mode: merge-on-green\n', `  mode: merge-on-green\n${onDisk}`))
    }
    const stack = readFileSync(stackPath, 'utf8')
    const lefthook = recordedParseYaml('kept')
    const facts = await readFacts(dir, {
      gh: recordedGh('kept'),
      gitRemoteUrl: originAcme,
      migrateLabel,
      parseYaml: (text) => (text === stack ? { landing } : lefthook(text)),
    })
    return { dir, stack, facts }
  }

  it('flags a merge-on-green required_checks list that hides other checks, and writes nothing', async () => {
    const { dir, stack, facts } = await keptWithLanding(
      { mode: 'merge-on-green', required_checks: ['widget-build'] },
      '  required_checks: [widget-build]\n',
    )
    expect(stack).toContain('  required_checks: [widget-build]\n')
    expect(plan(facts)).toContain('landing kept (existing; required_checks hides other checks)')
    applyStack(dir, facts)
    expect(readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')).toBe(stack)
  })

  it.each([
    ['an empty list', { mode: 'merge-on-green', required_checks: [] }],
    ['native mode', { mode: 'native', required_checks: ['widget-build'] }],
    ['no required_checks', { mode: 'merge-on-green' }],
  ])('keeps quiet for %s', async (_row, landing) => {
    const { facts } = await keptWithLanding(landing)
    expect(plan(facts)).toContain('landing kept (existing)')
  })

  it('reads the recorded stack answer, and keeps the landing quiet when the stack cannot be parsed', async () => {
    expect((await factsFor('kept')).landingHidesChecks).toBe(false)
    const dir = scratchCopy('kept')
    const stack = readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')
    const lefthook = recordedParseYaml('kept')
    const facts = await readFacts(dir, {
      gh: recordedGh('kept'),
      gitRemoteUrl: originAcme,
      migrateLabel,
      parseYaml: (text) => {
        if (text === stack) throw new Error('bad stack YAML')
        return lefthook(text)
      },
    })
    expect(facts.landingHidesChecks).toBe(false)
    expect(plan(facts)).toContain('landing kept (existing)')
  })

  it('falls back to the merge-on-green workflow when the landing names no mode', async () => {
    const { facts } = await keptWithLanding({ required_checks: ['widget-build'] })
    expect(facts.landingHidesChecks).toBe(true)
  })
})

describe('issue-triage lookup', () => {
  it('tries this repository sibling only, when no ancestor holds node_modules/omp-build', () => {
    expect(migrateLabelCandidates(path.join(import.meta.dirname, 'feature-init.ts'))).toEqual([
      path.resolve(import.meta.dirname, '../../../issue-triage/skills/issue-triage/lib/migrate-labels.ts'),
    ])
  })

  it('stops the installed-layout walk at the first ancestor holding node_modules/omp-build', () => {
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-init-walk-')))
    const plugins = path.join(scratch, 'plugins')
    const file = path.join(plugins, 'cache', 'omp-build', 'skills', 'feature', 'feature-init.ts')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '')
    mkdirSync(path.join(plugins, 'node_modules', 'omp-build'), { recursive: true })
    mkdirSync(path.join(scratch, 'node_modules', 'omp-build'), { recursive: true })
    const lib = path.join('issue-triage', 'skills', 'issue-triage', 'lib', 'migrate-labels.ts')
    expect(migrateLabelCandidates(file)).toEqual([
      path.join(plugins, 'cache', 'issue-triage', 'skills', 'issue-triage', 'lib', 'migrate-labels.ts'),
      path.join(plugins, 'node_modules', lib),
    ])
  })

  it('does not trust a directory owned by another user', () => {
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-init-owner-')))
    const me = statSync(scratch).uid
    expect(trustedDir(scratch, me)).toBe(true)
    expect(trustedDir(scratch, me + 1)).toBe(false)
  })

  it.each([
    ['a world-writable ancestor', 'plugins', 0o777],
    ['a sticky world-writable ancestor', 'plugins', 0o1777],
    ['a world-writable node_modules', 'plugins/node_modules', 0o777],
  ])('never trusts %s as the installed-layout stop', (_row, rel, mode) => {
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-init-trust-')))
    const plugins = path.join(scratch, 'plugins')
    const file = path.join(plugins, 'cache', 'omp-build', 'skills', 'feature', 'feature-init.ts')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '')
    mkdirSync(path.join(plugins, 'node_modules', 'omp-build'), { recursive: true })
    chmodSync(path.join(scratch, rel), mode)
    expect(trustedDir(path.join(scratch, rel))).toBe(false)
    expect(migrateLabelCandidates(file)).toEqual([
      path.join(plugins, 'cache', 'issue-triage', 'skills', 'issue-triage', 'lib', 'migrate-labels.ts'),
    ])
  })

  it('does not fall through to a later candidate after an import error', async () => {
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-init-fallthrough-')))
    const file = path.join(scratch, 'plugins', 'omp-build', 'skills', 'feature', 'feature-init.ts')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '')
    const lib = path.join('skills', 'issue-triage', 'lib', 'migrate-labels.ts')
    const sibling = path.join(scratch, 'plugins', 'issue-triage', lib)
    mkdirSync(path.dirname(sibling), { recursive: true })
    writeFileSync(sibling, "throw new Error('widget grammar exploded')\n")
    mkdirSync(path.join(scratch, 'node_modules', 'omp-build'), { recursive: true })
    const installed = path.join(scratch, 'node_modules', 'issue-triage', lib)
    mkdirSync(path.dirname(installed), { recursive: true })
    writeFileSync(installed, 'export const migrateLabel = () => ({ add: null, remove: false })\n')
    await expect(loadMigrateLabel(file)).rejects.toThrow('widget grammar exploded')
  })

  it('names why the grammar is unusable', async () => {
    await expect(resolveMigrateLabel(async () => null as unknown as MigrateLabel)).rejects.toThrow(
      'issue-triage missing (migrateLabel is not a function)',
    )
  })
})

function baseFacts(): Facts {
  return {
    hasTracker: true,
    labels: [],
    labelsState: 'ok',
    legacyLabels: [],
    hasSemctx: false,
    hooks: 'present',
    activeContracts: 0,
    hasAssertledger: true,
    vitest: true,
    hasCcc: true,
    hasCodegraph: true,
    mergeOnGreen: true,
    hasLanding: false,
    landingHidesChecks: false,
    gates: [],
    hasWorktree: true,
    hasPostMerge: true,
    hasReleaseModel: true,
    cccConsent: false,
    codegraphConsent: false,
  }
}
