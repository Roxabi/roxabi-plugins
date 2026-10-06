import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Proof, proofCheck } from './proof-gate'

/** No inherited `GIT_*` (a hook's `GIT_DIR` would redirect every call) and no user or system config. */
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

/** Real git, run hermetically in `cwd`. */
const run = (cwd: string, args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Real git against a throw-away repository: what the injected `git` of the unit tests only pretends. */
const git = async (cwd: string, args: string[]) => run(cwd, args)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SEM = 'change change.alpha\n  statement: a fictional contract\n  status: verified\n  tag: issue-42\n'

function put(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
}

/** A repository with one commit holding `files`. */
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'proof-git-')))
  dirs.push(root)
  run(root, ['init', '-q', '-b', 'main'])
  run(root, ['config', 'user.email', 'dev@example.test'])
  run(root, ['config', 'user.name', 'Dev'])
  put(root, files)
  run(root, ['add', '-A'])
  run(root, ['commit', '-q', '-m', 'init'])
  return root
}

async function proofFor(root: string, over: Partial<Proof> = {}): Promise<Proof> {
  return {
    head: await git(root, ['rev-parse', 'HEAD']),
    verify: 'VERIFIED',
    gaps: [],
    noTest: {},
    assertledger: null,
    hasAdapter: false,
    typeFix: false,
    ...over,
  }
}

const CONTRACT = '.semctx/semantic/changes/alpha.sem'

describe('proofCheck with real git', () => {
  it('passes a committed, verified contract at the proof head', async () => {
    const root = repo({ [CONTRACT]: SEM })
    expect(await proofCheck(root, { proof: await proofFor(root), issue: 42, git })).toEqual({
      applies: true,
      pass: true,
    })
  })

  it('does not apply to a repository without .semctx', async () => {
    const root = repo({ 'a.txt': 'x' })
    expect(await proofCheck(root, { issue: 42, git })).toEqual({ applies: false })
  })

  it('refuses outside a repository', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'proof-nogit-')))
    dirs.push(outside)
    expect(await proofCheck(outside, { issue: 42, git })).toEqual({
      applies: true,
      pass: false,
      reason: 'no-repo-root',
    })
  })

  it('reads the contract committed at HEAD, not the one edited on disk after the commit', async () => {
    const root = repo({ [CONTRACT]: SEM.replace('verified', 'active') })
    const proof = await proofFor(root)
    put(root, { [CONTRACT]: SEM })
    expect(await proofCheck(root, { proof, issue: 42, git })).toEqual({
      applies: true,
      pass: false,
      reason: 'change contract change.alpha is active at HEAD; a VERIFIED proof needs verified',
    })
  })

  it('refuses a verified contract that was never committed', async () => {
    const root = repo({ '.semctx/semantic/changes/other.sem': SEM.replace('issue-42', 'issue-7') })
    put(root, { [CONTRACT]: SEM })
    expect(await proofCheck(root, { proof: await proofFor(root), issue: 42, git })).toEqual({
      applies: true,
      pass: false,
      reason: 'no change contract tagged issue-42 is committed at HEAD',
    })
  })

  it('refuses a repository that ignores .semctx: its contract is never in the commit', async () => {
    const root = repo({ 'a.txt': 'x', '.gitignore': '.semctx/\n' })
    put(root, { [CONTRACT]: SEM })
    expect(await proofCheck(root, { proof: await proofFor(root), issue: 42, git })).toEqual({
      applies: true,
      pass: false,
      reason: 'no change contract tagged issue-42 is committed at HEAD',
    })
  })

  it('refuses a contract committed as a symlink', async () => {
    const root = repo({ '.semctx/real.txt': SEM })
    mkdirSync(join(root, '.semctx/semantic/changes'), { recursive: true })
    symlinkSync('../../real.txt', join(root, CONTRACT))
    run(root, ['add', '-A'])
    run(root, ['commit', '-q', '-m', 'link'])
    expect(await proofCheck(root, { proof: await proofFor(root), issue: 42, git })).toEqual({
      applies: true,
      pass: false,
      reason: `${CONTRACT} is not a regular file at HEAD`,
    })
  })

  it('refuses a proof whose head is not the checkout HEAD', async () => {
    const root = repo({ [CONTRACT]: SEM })
    const proof = await proofFor(root)
    put(root, { 'later.txt': 'x' })
    run(root, ['add', '-A'])
    run(root, ['commit', '-q', '-m', 'later'])
    const result = await proofCheck(root, { proof, issue: 42, git })
    expect(result).toMatchObject({ applies: true, pass: false })
    expect(result.applies && !result.pass && result.reason).toMatch(/^proof head [0-9a-f]{7} is not HEAD [0-9a-f]{7}$/)
  })

  it('applies in a linked worktree whose principal alone has .semctx, and refuses: the worktree has no contract', async () => {
    const principal = repo({ 'a.txt': 'x', '.gitignore': '.semctx/\n' })
    put(principal, { [CONTRACT]: SEM })
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'proof-linked-'))), 'wt')
    dirs.push(dirname(linked))
    run(principal, ['worktree', 'add', '-q', '-b', 'feat/42-alpha', linked])
    expect(await proofCheck(linked, { proof: await proofFor(linked), issue: 42, git })).toEqual({
      applies: true,
      pass: false,
      reason: 'no change contract tagged issue-42 is committed at HEAD',
    })
  })
})
