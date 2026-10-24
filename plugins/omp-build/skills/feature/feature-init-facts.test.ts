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
  recordedArgv,
  recordedGh,
  recordedParseYaml,
  scratchCopy,
} from './feature-init.fixture'
import type { Gh } from './feature-init-facts'
import { plan, readFacts } from './feature-init-facts'
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
      'semctx hooks',
      'CI job semctx-working-empty',
      '3 active semctx contracts',
      'assertledger + vitest adapter',
      'landing = merge-on-green (every check; gates: widget-audit ; (widget-build|widget-build-full) ; Widget scan, nightly|widget-scan)',
      'worktree block',
      'release.post_merge asked',
    ])
  })

  it('counts a contract only on an anchored status: active line of a .sem file', async () => {
    // Decoys: `note: was status: active` (only ^ rejects it), `status: active-draft` (only $ rejects it),
    // and a non-.sem file.
    expect((await factsFor('acme')).activeContracts).toBe(3)
  })

  it('ignores a ci.yml comment and a package script that only mention the tools', async () => {
    const facts = await factsFor('acme')
    expect(facts.hasWorkingEmptyJob).toBe(false)
    expect(facts.hasAssertledger).toBe(false)
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

describe('issue-triage lookup', () => {
  it('names why the grammar is unusable', async () => {
    await expect(resolveMigrateLabel(async () => null as unknown as MigrateLabel)).rejects.toThrow(
      'issue-triage missing (migrateLabel is not a function)',
    )
  })
})
