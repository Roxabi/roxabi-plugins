import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NO_TEST_REASONS, type Proof, proofCheck, proofGate, readChangeContracts, readStack } from './proof-gate'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

const verified: Proof = {
  head: HEAD,
  verify: 'VERIFIED',
  gaps: [],
  noTest: {},
  assertledger: null,
  hasAdapter: false,
  typeFix: false,
}

const check = { steps: 'open the page, press save', url: '/settings', observed: 'the toast reads Saved' }
const uiPartial: Proof = {
  ...verified,
  verify: 'PARTIAL',
  gaps: ['ui'],
  noTest: { ui: 'ui-manual-only' },
  uiChecks: { ui: check },
}

describe('proofGate', () => {
  it('passes VERIFIED', () => {
    expect(proofGate(verified)).toEqual({ pass: true })
  })

  it('passes a PARTIAL whose every gap is a NO TEST row', () => {
    expect(
      proofGate({ ...verified, verify: 'PARTIAL', gaps: ['prompt'], noTest: { prompt: 'prompt-logic-only' } }),
    ).toEqual({ pass: true })
  })

  it.each(NO_TEST_REASONS.filter((reason) => reason !== 'ui-manual-only'))('accepts the enum reason %s', (reason) => {
    expect(proofGate({ ...verified, verify: 'PARTIAL', gaps: ['g'], noTest: { g: reason } })).toEqual({ pass: true })
  })

  it('stops a PARTIAL gap with no NO TEST row', () => {
    expect(proofGate({ ...verified, verify: 'PARTIAL', gaps: ['ui'] })).toEqual({
      pass: false,
      reason: 'unjustified PARTIAL: ui',
    })
  })

  it('stops a PARTIAL gap whose reason is outside the enum', () => {
    expect(proofGate({ ...verified, verify: 'PARTIAL', gaps: ['ci'], noTest: { ci: 'flaky-ci' } })).toEqual({
      pass: false,
      reason: 'unjustified PARTIAL: ci',
    })
  })

  it('has no way to widen the enum: acceptedReasons is an unknown key', () => {
    const widened = {
      ...verified,
      verify: 'PARTIAL',
      gaps: ['ci'],
      noTest: { ci: 'flaky-ci' },
      acceptedReasons: ['flaky-ci'],
    }
    expect(proofGate(widened)).toEqual({ pass: false, reason: 'malformed proof: unknown key "acceptedReasons"' })
  })

  it('stops a PARTIAL that names no gap', () => {
    expect(proofGate({ ...verified, verify: 'PARTIAL' })).toEqual({ pass: false, reason: 'PARTIAL names no gap' })
  })

  it('stops BLOCKED', () => {
    expect(proofGate({ ...verified, verify: 'BLOCKED' })).toEqual({ pass: false, reason: 'BLOCKED' })
  })

  it('stops WEAK_ORACLE on a fix ticket that has an adapter', () => {
    expect(proofGate({ ...verified, typeFix: true, hasAdapter: true, assertledger: 'WEAK_ORACLE' })).toEqual({
      pass: false,
      reason: 'WEAK_ORACLE',
    })
  })

  it('does not block when no adapter exists', () => {
    expect(proofGate({ ...verified, typeFix: true, hasAdapter: false, assertledger: 'WEAK_ORACLE' })).toEqual({
      pass: true,
    })
  })

  it.each([
    ['not an object', 'VERIFIED'],
    ['null', null],
    ['an array', []],
    ['a verify outside the set', { ...verified, verify: 'MAYBE' }],
    ['no verify', { ...verified, verify: undefined }],
    ['no gaps list', { ...verified, gaps: undefined }],
    ['a gaps list of numbers', { ...verified, gaps: [1] }],
    ['noTest as a list', { ...verified, noTest: [] }],
    ['a noTest value that is not text', { ...verified, noTest: { g: 7 } }],
    ['a short head', { ...verified, head: 'abc123' }],
    ['an upper-case head', { ...verified, head: 'A'.repeat(40) }],
    ['no head', { ...verified, head: undefined }],
    ['an assertledger outside the set', { ...verified, assertledger: 'ok' }],
    ['hasAdapter as text', { ...verified, hasAdapter: 'yes' }],
    ['typeFix missing', { ...verified, typeFix: undefined }],
    ['uiChecks as a list', { ...verified, uiChecks: [] }],
    ['a uiCheck without observed', { ...verified, uiChecks: { ui: { steps: 's', url: '/a' } } }],
    ['a uiCheck with an extra key', { ...verified, uiChecks: { ui: { ...check, note: 'x' } } }],
    ['an unknown key', { ...verified, extra: true }],
  ])('rejects %s as malformed, without throwing and without passing', (_name, input) => {
    const result = proofGate(input)
    expect(result.pass).toBe(false)
    expect(result.pass === false && result.reason.startsWith('malformed proof: ')).toBe(true)
  })

  describe('ui-manual-only (dev-review 5a)', () => {
    it('is refused when commands.test_e2e is declared, even with a recorded check', () => {
      expect(proofGate(uiPartial, { e2e: true })).toEqual({
        pass: false,
        reason: 'ui-manual-only refused for ui: commands.test_e2e is declared',
      })
    })

    it('needs a recorded browser check when there is no e2e command', () => {
      expect(proofGate({ ...uiPartial, uiChecks: undefined })).toEqual({
        pass: false,
        reason: 'ui-manual-only gap ui has no uiChecks entry',
      })
    })

    it('passes with steps, a path-shaped url and an observed result', () => {
      expect(proofGate(uiPartial)).toEqual({ pass: true })
    })

    it('passes with an absolute url', () => {
      const proof = { ...uiPartial, uiChecks: { ui: { ...check, url: 'https://app.example.test/settings' } } }
      expect(proofGate(proof)).toEqual({ pass: true })
    })

    it.each([
      ['empty steps', { ...check, steps: ' ' }, 'uiChecks.ui.steps is empty'],
      ['an empty observed result', { ...check, observed: '' }, 'uiChecks.ui.observed is empty'],
      [
        'a url that is neither a URL nor a path',
        { ...check, url: 'settings page' },
        'uiChecks.ui.url is not a URL or a path',
      ],
    ])('refuses %s', (_name, uiCheck, reason) => {
      expect(proofGate({ ...uiPartial, uiChecks: { ui: uiCheck } })).toEqual({ pass: false, reason })
    })
  })
})

describe('readChangeContracts', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function root(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'proof-contracts-'))
    dirs.push(dir)
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, '.semctx', 'semantic', 'changes'), { recursive: true })
      writeFileSync(join(dir, '.semctx', 'semantic', 'changes', name), content)
    }
    return dir
  }

  const MULTI_KIND = `goal goal.alpha
  statement: ship alpha
  status: active

invariant invariant.alpha.single-gate
  statement: one gate only
  status: declared
  tag: alpha

evidence evidence.alpha.gate-test
  status: tested
  link: tests/gate.test.ts

change change.42-alpha
  statement: build alpha
  status: active
  tag: issue-42
  tag: alpha

decision decision.alpha.store
  status: verified

change change.43-beta
  statement: a contract with no lifecycle
  tag: issue-43
`

  it('reads only change blocks of a multi-kind file, with their own lifecycle and tags', () => {
    expect(readChangeContracts(root({ 'alpha.sem': MULTI_KIND }))).toEqual([
      { id: 'change.42-alpha', lifecycle: 'active', tags: ['issue-42', 'alpha'], file: 'alpha.sem' },
      { id: 'change.43-beta', lifecycle: null, tags: ['issue-43'], file: 'alpha.sem' },
    ])
  })

  it('never takes the status of an invariant or evidence block for a lifecycle', () => {
    const decoys =
      'invariant invariant.a\n  status: active\n  tag: issue-9\n\nevidence evidence.a\n  status: runtime_verified\n'
    expect(readChangeContracts(root({ 'a.sem': decoys }))).toEqual([])
  })

  it('reads several change blocks across files, in file-name order', () => {
    const contracts = readChangeContracts(
      root({
        'b.sem': 'change change.b\n  status: partial\n  tag: issue-2\n',
        'a.sem':
          'change change.a1\n  status: verified\n  tag: issue-1\n\nchange change.a2\n  status: superseded\n  tag: issue-1\n',
        'notes.txt': 'change change.notes\n  status: active\n',
      }),
    )
    expect(contracts.map((contract) => [contract.file, contract.id, contract.lifecycle])).toEqual([
      ['a.sem', 'change.a1', 'verified'],
      ['a.sem', 'change.a2', 'superseded'],
      ['b.sem', 'change.b', 'partial'],
    ])
  })

  it('reads a CRLF file', () => {
    const crlf = 'change change.crlf\r\n  status: active\r\n  tag: issue-7\r\n'
    expect(readChangeContracts(root({ 'c.sem': crlf }))).toEqual([
      { id: 'change.crlf', lifecycle: 'active', tags: ['issue-7'], file: 'c.sem' },
    ])
  })

  it('does not read a field of a block it left, nor a header that is not at column 0', () => {
    const text =
      'change change.x\n  status: active\n unknownish\nnote something\n  status: verified\n  change change.nested\n'
    expect(readChangeContracts(root({ 'x.sem': text }))).toEqual([
      { id: 'change.x', lifecycle: 'active', tags: [], file: 'x.sem' },
    ])
  })

  it('does not count the old `change: <id>` header as a contract', () => {
    expect(readChangeContracts(root({ 'old.sem': 'change: acme-alpha\n  status: active\n' }))).toEqual([])
  })

  it('returns no contracts when there is no changes directory', () => {
    expect(readChangeContracts(root({}))).toEqual([])
  })
})

describe('proofCheck', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A temp directory holding `files` (relative path → content). */
  function tree(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'proof-check-'))
    dirs.push(dir)
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), content)
    }
    return dir
  }

  const contract = (id: string, lifecycle: string | null, tag = 'issue-42') =>
    `change change.${id}\n  statement: a fictional contract\n${lifecycle ? `  status: ${lifecycle}\n` : ''}  tag: ${tag}\n`
  const sem = (name: string, text: string) => ({ [`.semctx/semantic/changes/${name}.sem`]: text })

  /** A `git` stand-in: the answers a checkout at `root` (principal `principal`) would give. */
  function fakeGit({
    root,
    principal = root,
    head = HEAD,
    dirty = '',
    noRoot = false,
  }: {
    root: string
    principal?: string
    head?: string
    dirty?: string
    noRoot?: boolean
  }) {
    const calls: string[][] = []
    const git = async (_cwd: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        if (noRoot) throw new Error('fatal: not a git repository')
        return root
      }
      if (args[0] === 'worktree') return `worktree ${principal}\nHEAD ${head}\nbranch refs/heads/main\n`
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head
      if (args[0] === 'status') return dirty
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    return { git, calls }
  }

  const run = (
    root: string,
    over: Partial<Parameters<typeof proofCheck>[1]> & { gitOver?: Parameters<typeof fakeGit>[0] } = {},
  ) => {
    const { gitOver, ...rest } = over
    return proofCheck(root, {
      proof: verified,
      issue: 42,
      git: fakeGit({ root, ...gitOver }).git,
      parseYaml: JSON.parse,
      ...rest,
    })
  }

  const refused = (reason: string) => ({ applies: true, pass: false, reason })
  const OK = { applies: true, pass: true }

  it('refuses when there is no repository root, even with no .semctx to be found', async () => {
    const root = tree()
    expect(await run(root, { gitOver: { root, noRoot: true } })).toEqual(refused('no-repo-root'))
  })

  it('does not apply when neither this worktree nor the principal has a .semctx', async () => {
    const root = tree({ 'a.txt': 'x' })
    const principal = tree()
    expect(await run(root, { proof: undefined, gitOver: { root, principal } })).toEqual({ applies: false })
  })

  it('applies when only the principal has a .semctx, and the worktree then has no contract to show', async () => {
    const root = tree()
    const principal = tree(sem('a', contract('a', 'verified')))
    expect(await run(root, { gitOver: { root, principal } })).toEqual(refused('no change contract tagged issue-42'))
  })

  it('passes a VERIFIED proof with a verified contract tagged for the ticket', async () => {
    expect(await run(tree(sem('a', contract('a', 'verified'))))).toEqual(OK)
  })

  it('refuses a .semctx that is a symlink', async () => {
    const real = tree(sem('a', contract('a', 'verified')))
    const root = tree()
    symlinkSync(join(real, '.semctx'), join(root, '.semctx'))
    expect(await run(root)).toEqual(refused('.semctx is a symlink'))
  })

  it('refuses a .sem entry that is a symlink', async () => {
    const root = tree(sem('real', contract('a', 'verified')))
    symlinkSync(join(root, '.semctx/semantic/changes/real.sem'), join(root, '.semctx/semantic/changes/link.sem'))
    expect(await run(root)).toEqual(refused('.semctx/semantic/changes/link.sem is a symlink'))
  })

  it('refuses a .sem entry that is a directory', async () => {
    const root = tree(sem('a', contract('a', 'verified')))
    mkdirSync(join(root, '.semctx/semantic/changes/dir.sem'))
    expect(await run(root)).toEqual(refused('.semctx/semantic/changes/dir.sem is not a file'))
  })

  it('refuses when no proof is supplied', async () => {
    expect(await run(tree(sem('a', contract('a', 'verified'))), { proof: undefined })).toEqual(
      refused('no proof supplied'),
    )
  })

  it('refuses a malformed proof with the gate reason', async () => {
    const result = await run(tree(sem('a', contract('a', 'verified'))), { proof: { ...verified, acceptedReasons: [] } })
    expect(result).toEqual(refused('malformed proof: unknown key "acceptedReasons"'))
  })

  it('refuses a BLOCKED proof', async () => {
    expect(await run(tree(sem('a', contract('a', 'verified'))), { proof: { ...verified, verify: 'BLOCKED' } })).toEqual(
      refused('BLOCKED'),
    )
  })

  it('refuses when no contract carries the ticket tag', async () => {
    expect(await run(tree(sem('a', contract('a', 'verified', 'issue-41'))))).toEqual(
      refused('no change contract tagged issue-42'),
    )
  })

  it('matches the tag exactly: issue-4 is not issue-42', async () => {
    expect(await run(tree(sem('a', contract('a', 'verified', 'issue-4'))))).toEqual(
      refused('no change contract tagged issue-42'),
    )
  })

  it('refuses a ticket that is not a number', async () => {
    expect(await run(tree(sem('a', contract('a', 'verified'))), { issue: null })).toEqual(refused('no ticket number'))
  })

  it('ignores contracts of other tickets, whatever their lifecycle', async () => {
    const root = tree({
      ...sem('mine', contract('mine', 'verified')),
      ...sem('other', contract('other', 'active', 'issue-99')),
      ...sem('draft', contract('draft', 'draft', 'issue-98')),
      ...sem('bare', contract('bare', null, 'issue-97')),
    })
    expect(await run(root)).toEqual(OK)
  })

  it('refuses a contract still active when the proof claims VERIFIED', async () => {
    expect(await run(tree(sem('a', contract('a', 'active'))))).toEqual(
      refused('change contract change.a is active; a VERIFIED proof needs verified'),
    )
  })

  it('refuses a contract with no lifecycle', async () => {
    expect(await run(tree(sem('a', contract('a', null))))).toEqual(
      refused('change contract change.a is unset; a VERIFIED proof needs verified'),
    )
  })

  it('refuses a VERIFIED contract when the proof is PARTIAL, and a partial one when it is VERIFIED', async () => {
    const partial: Proof = { ...verified, verify: 'PARTIAL', gaps: ['p'], noTest: { p: 'prompt-logic-only' } }
    expect(await run(tree(sem('a', contract('a', 'verified'))), { proof: partial })).toEqual(
      refused('change contract change.a is verified; a PARTIAL proof needs partial'),
    )
    expect(await run(tree(sem('a', contract('a', 'partial'))))).toEqual(
      refused('change contract change.a is partial; a VERIFIED proof needs verified'),
    )
    expect(await run(tree(sem('a', contract('a', 'partial'))), { proof: partial })).toEqual(OK)
  })

  it('passes a superseded contract beside a verified one, and refuses superseded alone', async () => {
    const both = tree({ ...sem('old', contract('old', 'superseded')), ...sem('new', contract('new', 'verified')) })
    expect(await run(both)).toEqual(OK)
    const alone = tree(sem('old', contract('old', 'superseded')))
    expect(await run(alone)).toEqual(
      refused('no change contract tagged issue-42 is verified; a VERIFIED proof needs one'),
    )
  })

  it('refuses a proof built for another commit', async () => {
    const root = tree(sem('a', contract('a', 'verified')))
    expect(await run(root, { gitOver: { root, head: OTHER } })).toEqual(
      refused(`proof head ${HEAD.slice(0, 7)} is not HEAD ${OTHER.slice(0, 7)}`),
    )
  })

  it('refuses a tracked change under .semctx, asking git only about tracked files', async () => {
    const root = tree(sem('a', contract('a', 'verified')))
    const fake = fakeGit({ root, dirty: ' M .semctx/semantic/changes/a.sem' })
    expect(await proofCheck(root, { proof: verified, issue: 42, git: fake.git, parseYaml: JSON.parse })).toEqual(
      refused('tracked files under .semctx are modified; commit the contract change first'),
    )
    expect(fake.calls).toContainEqual(['status', '--porcelain', '--untracked-files=no', '--', '.semctx'])
  })

  describe('commands.test_e2e', () => {
    const files = sem('a', contract('a', 'partial'))
    const stack = (value: unknown) => ({
      ...files,
      '.dev/stack.yml': JSON.stringify({ commands: { test_e2e: value } }),
    })

    it('refuses ui-manual-only when test_e2e is a command string', async () => {
      expect(await run(tree(stack('bun run e2e')), { proof: uiPartial })).toEqual(
        refused('ui-manual-only refused for ui: commands.test_e2e is declared'),
      )
    })

    it('counts a test_e2e map with a run', async () => {
      expect(await run(tree(stack({ run: 'bun run e2e' })), { proof: uiPartial })).toEqual(
        refused('ui-manual-only refused for ui: commands.test_e2e is declared'),
      )
    })

    it.each([
      ['a map with skip: true', { run: 'bun run e2e', skip: true }],
      ['a map with no run', { timeout: 30 }],
      ['an empty string', ''],
    ])('does not count %s', async (_name, value) => {
      expect(await run(tree(stack(value)), { proof: uiPartial })).toEqual(OK)
    })

    it('passes ui-manual-only with a recorded check when there is no stack file', async () => {
      expect(await run(tree(files), { proof: uiPartial })).toEqual(OK)
    })

    it('refuses an unparseable stack file', async () => {
      const root = tree({ ...files, '.dev/stack.yml': '{ not yaml' })
      const result = await run(root, { proof: uiPartial })
      expect(result).toMatchObject({ applies: true, pass: false })
      expect(result.applies && !result.pass && result.reason).toMatch(/^\.dev\/stack\.yml is not valid YAML/)
    })

    it('refuses a stack document that is not a map', async () => {
      const root = tree({ ...files, '.dev/stack.yml': '["a"]' })
      expect(await run(root, { proof: uiPartial })).toEqual(refused('.dev/stack.yml: the document is not a map'))
    })
  })

  describe('the PR body', () => {
    const root = () => tree(sem('a', contract('a', 'partial')))

    it('must carry the url and observed result of every recorded check', async () => {
      const body = `## Proof\n- ui: ${check.url} — ${check.observed}`
      expect(await run(root(), { proof: uiPartial, body })).toEqual(OK)
    })

    it('refuses a body without the url', async () => {
      const result = await run(root(), { proof: uiPartial, body: `ui checked: ${check.observed}` })
      expect(result).toEqual(
        refused('the PR body does not record the browser check for ui (its url and observed result)'),
      )
    })

    it('refuses a body without the observed result', async () => {
      const result = await run(root(), { proof: uiPartial, body: `ui checked at ${check.url}` })
      expect(result).toMatchObject({ applies: true, pass: false })
    })

    it('is not read when none is given (landPr)', async () => {
      expect(await run(root(), { proof: uiPartial })).toEqual(OK)
    })
  })
})

describe('readStack', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const stackAt = (text?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'proof-stack-'))
    dirs.push(dir)
    if (text !== undefined) {
      mkdirSync(join(dir, '.dev'))
      writeFileSync(join(dir, '.dev', 'stack.yml'), text)
    }
    return dir
  }

  it('is null when the file is absent or blank', () => {
    expect(readStack(stackAt(), JSON.parse)).toBeNull()
    expect(readStack(stackAt('  \n'), JSON.parse)).toBeNull()
  })

  it('returns the parsed document', () => {
    expect(readStack(stackAt('{"a":1}'), JSON.parse)).toEqual({ a: 1 })
  })

  it('names the file when its text does not parse', () => {
    expect(() => readStack(stackAt('{'), JSON.parse)).toThrow(/^\.dev\/stack\.yml is not valid YAML: /)
  })
})
