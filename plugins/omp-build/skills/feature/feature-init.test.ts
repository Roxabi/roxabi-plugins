import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { migrateLabel } from '../../../issue-triage/skills/issue-triage/lib/migrate-labels'
import { stageFixture } from './__fixtures__/feature-init/stage'
import {
  applyStack,
  type Facts,
  type Gh,
  hasSemctxGitHooks,
  IssueTriageMissing,
  type MigrateLabel,
  migrateLabelCandidates,
  ownerRepoFromRemote,
  type ParseYaml,
  plan,
  readFacts,
  resolveMigrateLabel,
  semctxHooks,
} from './feature-init'

const NAMES = ['acme', 'kept', 'pr-only', 'hooks-ok']

let staged = ''
beforeAll(() => {
  staged = mkdtempSync(path.join(tmpdir(), 'omp-init-fixtures-'))
  for (const name of NAMES) stageFixture(name, path.join(staged, name))
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
  const text = fixtureFile(name, 'lefthook.yml')
  const doc = JSON.parse(fixtureFile(name, 'lefthook.parsed.json'))
  return (input) => {
    if (input !== text) throw new Error(`unexpected YAML input for fixture ${name}`)
    return doc
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
      'CI job semctx-working-empty',
      '3 orphan contracts',
      'assertledger + vitest adapter',
      'landing = merge-on-green (every check; gates: widget-audit ; (widget-build|widget-build-full) ; Widget scan, nightly|widget-scan)',
      'worktree block',
      'release.post_merge asked',
    ])
  })

  it('counts a contract only on an anchored status: active line of a .sem file', async () => {
    // Decoys: `status: active` mid-line, `status: activated`, and a non-.sem file.
    expect((await factsFor('acme')).activeContracts).toBe(3)
  })

  it('ignores a ci.yml comment and a package script that only mention the tools', async () => {
    const facts = await factsFor('acme')
    expect(facts.hasWorkingEmptyJob).toBe(false)
    expect(facts.hasAssertledger).toBe(false)
  })

  it('decides label migration with issue-triage grammar', async () => {
    const facts = await factsFor('acme')
    expect(facts.legacyLabels).toEqual(['size: M', 'priority: high', 'ready-for-agent'])
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
    expect(seen.flat()).not.toContain('acme/kit-upstream')
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
    ['git@ghe.acme.test:acme/app.git', 'ghe.acme.test/acme/app'],
    ['https://ghe.acme.test/acme/app', 'ghe.acme.test/acme/app'],
    ['/srv/git/app.git', null],
    ['../app', null],
    ['file:///srv/git/acme/app.git', null],
    ['file://nas/acme/app.git', null],
    ['https://gitlab.acme.test/group/sub/app.git', null],
    ['https://github.com/acme', null],
    ['', null],
    [null, null],
  ])('%s → %s', (url, repo) => {
    expect(ownerRepoFromRemote(url)).toBe(repo)
  })

  it('passes -R host/owner/repo for a remote that is not on github.com', async () => {
    const seen: string[][] = []
    await readFacts(path.join(staged, 'acme'), {
      gh: (args) => {
        seen.push(args)
        return ''
      },
      gitRemoteUrl: () => 'git@ghe.acme.test:acme/app.git',
      migrateLabel,
      parseYaml: recordedParseYaml('acme'),
    })
    expect(seen[0]?.slice(0, 4)).toEqual(['label', 'list', '-R', 'ghe.acme.test/acme/app'])
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

  it('reports extends as unknown unless a local hook already runs semctx', () => {
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
  async function keptWithLanding(landing: unknown) {
    const dir = scratchCopy('kept')
    const stack = readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')
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
    const { dir, stack, facts } = await keptWithLanding({ mode: 'merge-on-green', required_checks: ['widget-build'] })
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

  it('falls back to the merge-on-green workflow when the landing names no mode', async () => {
    const { facts } = await keptWithLanding({ required_checks: ['widget-build'] })
    expect(facts.landingHidesChecks).toBe(true)
  })
})

describe('issue-triage lookup', () => {
  it('tries this repository sibling before any node_modules', () => {
    const candidates = migrateLabelCandidates(path.join(import.meta.dirname, 'feature-init.ts'))
    expect(candidates[0]).toBe(
      path.resolve(import.meta.dirname, '../../../issue-triage/skills/issue-triage/lib/migrate-labels.ts'),
    )
    expect(candidates.slice(1).every((file) => file.includes(`${path.sep}node_modules${path.sep}issue-triage`))).toBe(
      true,
    )
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
    hasWorkingEmptyJob: true,
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
