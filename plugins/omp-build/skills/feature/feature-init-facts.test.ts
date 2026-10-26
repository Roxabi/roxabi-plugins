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
  recordedArgv,
  recordedGh,
  recordedParseYaml,
  scratchCopy,
} from './feature-init.fixture'
import type { Gh } from './feature-init-facts'
import { ownerRepoFromRemote, plan, readFacts } from './feature-init-facts'
import { applyStack } from './feature-init-stack'
import { type MigrateLabel, resolveMigrateLabel } from './feature-init-triage'

let staged = ''
let scratch: string | undefined
beforeAll(() => {
  staged = fixtureRoot()
})
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})
describe('feature init on the fictional acme fixture', () => {
  it('lists the adoption gaps', async () => {
    expect(plan(await factsFor('acme'))).toEqual([
      'tracker contract',
      'label migration',
      'landing = merge-on-green (every check; gates: widget-audit ; (widget-build|widget-build-full) ; Widget scan, nightly|widget-scan)',
      'worktree block',
      'release.post_merge asked',
    ])
  })

  it('ignores residual Semctx and AssertLedger configuration', async () => {
    const facts = await factsFor('acme')
    const lines = plan(facts)
    expect(facts).not.toHaveProperty('hasSemctx')
    expect(lines).not.toContain('semctx hooks')
    expect(lines).not.toContain('CI job semctx-working-empty')
    expect(lines).not.toContain('assertledger')
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
    applyStack(dir, await factsIn(dir, 'acme'), recordedParseYaml('acme'))
    const stack = readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')
    expect(stack).toMatch(/^landing:\n {2}mode: merge-on-green\n/m)
    expect(stack).not.toContain('required_checks')
  })

  it('creates .dev before writing the stack', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-mkdir-'))
    applyStack(
      scratch,
      { ...(await factsFor('acme')), hasWorktree: false, hasLanding: false, mergeOnGreen: true },
      () => ({ schema_version: '1.0' }),
    )
    expect(readFileSync(path.join(scratch, '.dev', 'stack.yml'), 'utf8')).toContain('mode: merge-on-green')
  })

  it('preserves a declared setup command without adding an empty worktree override', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-setup-'))
    mkdirSync(path.join(scratch, '.dev'))
    const stackPath = path.join(scratch, '.dev', 'stack.yml')
    const stack = 'commands:\n  worktree_setup: tools/worktree-setup.sh # adopted script\n'
    writeFileSync(stackPath, stack)

    applyStack(scratch, { ...baseFacts(), hasWorktree: false, mergeOnGreen: false }, () => ({
      commands: { worktree_setup: 'tools/worktree-setup.sh' },
    }))

    expect(readFileSync(stackPath, 'utf8')).toBe(stack)
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

describe('issue-triage lookup', () => {
  it('names why the grammar is unusable', async () => {
    await expect(resolveMigrateLabel(async () => null as unknown as MigrateLabel)).rejects.toThrow(
      'issue-triage missing (migrateLabel is not a function)',
    )
  })

  it('blocks fact gathering when migrateLabel is not a function', async () => {
    await expect(
      readFacts(path.join(staged, 'acme'), {
        gh: recordedGh('acme'),
        gitRemoteUrl: originAcme,
        migrateLabel: null as unknown as MigrateLabel,
        parseYaml: recordedParseYaml('acme'),
      }),
    ).rejects.toThrow('issue-triage missing (migrateLabel is not a function)')
  })
})
