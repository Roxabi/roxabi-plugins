import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import ompBuildExtension from '../index.ts'

const STACK = '{"release":{"model":"trunk"}}\n'
const GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  "repo view --json nameWithOwner")
    printf '%s' '{"nameWithOwner":"Acme/app"}' ;;
  "issue view 11 --repo Acme/app --json title,body,labels,updatedAt")
    printf '%s' '{"title":"feat(app): first child","body":"not authority","labels":[],"updatedAt":"2026-01-01T00:00:00Z"}' ;;
  "issue view 12 --repo Acme/app --json title,body,labels,updatedAt")
    printf '%s' '{"title":"fix(app): second child","body":"not authority","labels":[],"updatedAt":"2026-01-01T00:00:00Z"}' ;;
  "issue view 13 --repo Acme/app --json title,body,labels,updatedAt")
    echo missing >&2
    exit 1 ;;
  "api repos/Acme/app/issues/11")
    printf '%s' '{"number":11,"state":"open","body":"not authority"}' ;;
  "api repos/Acme/app/issues/12")
    printf '%s' '{"number":12,"state":"open","body":"not authority"}' ;;
  "api repos/Acme/app/issues/13")
    echo missing >&2
    exit 1 ;;
  "api repos/Acme/app/issues/7")
    printf '%s' '{"number":7,"state":"open","body":"not authority","pull_request":{"url":"https://example.invalid/7"}}' ;;
  "pr view 7 --repo Acme/app --json number,state,headRefOid,headRefName,baseRefName,baseRefOid,author")
    printf '%s' '{"number":7,"state":"OPEN","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRefName":"feat/7-existing","baseRefName":"main","baseRefOid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","author":{"login":"operator"}}' ;;
  *)
    echo "unexpected gh: $*" >&2
    exit 1 ;;
esac
`
const roots = new Set<string>()
const saved = {
  PATH: process.env.PATH,
  OMP_WORKTREE_DIR: process.env.OMP_WORKTREE_DIR,
  GH_LOG: process.env.GH_LOG,
}

type CheckoutTool = {
  name: string
  approval?: unknown
  execute: (id: string, params: unknown, ctx: { cwd: string }) => Promise<{ content: { text?: string }[] }>
}
type Fixture = { root: string; repo: string; checkouts: string; head: string; log: string }
type Preparation = {
  status: string
  path?: string
  cwd?: string
  reason?: string
  instruction?: string
  principal?: boolean
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=checkout@example.invalid',
      '-c',
      'user.name=Checkout',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim()
}

function principal(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'omp-prepare-checkout-'))
  roots.add(root)
  const origin = join(root, 'origin.git')
  const repo = join(root, 'principal')
  const checkouts = join(root, 'checkouts')
  const bin = join(root, 'bin')
  const log = join(root, 'gh.log')
  mkdirSync(checkouts)
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), GH)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(log, '')
  git(root, ['init', '-q', '-b', 'main', repo])
  mkdirSync(join(repo, '.dev'))
  writeFileSync(join(repo, '.dev', 'stack.yml'), STACK)
  git(repo, ['add', '--', '.dev/stack.yml'])
  git(repo, ['commit', '-qm', 'chore: stack'])
  git(root, ['init', '--bare', '-q', origin])
  git(repo, ['remote', 'add', 'origin', origin])
  git(repo, ['push', '-q', 'origin', 'main'])
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  process.env.PATH = `${bin}:${saved.PATH ?? ''}`
  process.env.OMP_WORKTREE_DIR = checkouts
  process.env.GH_LOG = log
  return { root, repo, checkouts, head: git(repo, ['rev-parse', 'HEAD']), log }
}

function registeredTool(messages: string[]): CheckoutTool {
  const tools = new Map<string, CheckoutTool>()
  ompBuildExtension(
    createExtensionApiStub({
      registerTool: (definition) => {
        tools.set(definition.name, {
          name: definition.name,
          approval: definition.approval,
          execute: async (id, params, ctx) => {
            const result = await definition.execute(
              id,
              params as Parameters<typeof definition.execute>[1],
              undefined,
              undefined,
              ctx as Parameters<typeof definition.execute>[4],
            )
            return result as { content: { text?: string }[] }
          },
        })
      },
      sendUserMessage: (message) => {
        messages.push(String(message))
      },
      sendMessage: (message) => {
        messages.push(String(message))
      },
    }),
  )
  const tool = tools.get('omp_build_prepare_checkout')
  if (tool === undefined) throw new Error('prepare checkout tool was not registered')
  return tool
}

async function prepare(tool: CheckoutTool, cwd: string, reference: string): Promise<Preparation> {
  const result = await tool.execute('call', { reference }, { cwd })
  return JSON.parse(result.content[0]?.text ?? '') as Preparation
}

function branchOf(path: string): string {
  return git(path, ['symbolic-ref', '--short', 'HEAD'])
}

function ghLog(log: string): string[] {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

describe('installed prepare-checkout entry', () => {
  const messages: string[] = []
  let tool: CheckoutTool

  beforeEach(() => {
    messages.length = 0
    tool = registeredTool(messages)
    vi.stubGlobal('Bun', {
      ...globalThis.Bun,
      YAML: { parse: (text: string) => JSON.parse(text) },
    })
  })

  afterEach(() => {
    process.env.PATH = saved.PATH
    process.env.OMP_WORKTREE_DIR = saved.OMP_WORKTREE_DIR
    process.env.GH_LOG = saved.GH_LOG
    vi.unstubAllGlobals()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots.clear()
  })

  it('prepares a real checkout from the principal and does not publish authority', async () => {
    const box = principal()
    const prepared = await prepare(tool, box.repo, '#11')
    const path = join(box.checkouts, 'app', 'feat-11-first-child')
    expect(prepared).toEqual({ status: 'move', path, instruction: `/move ${path}` })
    expect(existsSync(path)).toBe(true)
    expect(branchOf(path)).toBe('feat/11-first-child')
    expect(git(box.repo, ['rev-parse', 'HEAD'])).toBe(box.head)
    expect(git(box.repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main')
    expect(existsSync(join(git(path, ['rev-parse', '--git-dir']), 'omp-build-bootstrapped'))).toBe(false)
    expect(messages).toEqual([])
    expect(ghLog(box.log).some((line) => /comment|pr /.test(line))).toBe(false)
    expect(ghLog(box.log).filter((line) => line.startsWith('api '))).toEqual(['api repos/Acme/app/issues/11'])
  })

  it('reuses the same checkout and reports ready only from that checkout', async () => {
    const box = principal()
    const first = await prepare(tool, box.repo, '11')
    const second = await prepare(tool, box.repo, 'Acme/app#11')
    expect(second).toEqual(first)
    if (first.path === undefined) throw new Error('missing checkout path')
    expect(await prepare(tool, first.path, '#11')).toEqual({ status: 'ready', cwd: first.path, principal: false })
    expect(git(box.repo, ['worktree', 'list', '--porcelain']).match(/feat\/11-first-child/g)).toEqual([
      'feat/11-first-child',
    ])
  })

  it('prepares distinct checkouts for independent issues', async () => {
    const box = principal()
    const [first, second] = await Promise.all([prepare(tool, box.repo, '#11'), prepare(tool, box.repo, '#12')])
    expect(first.status).toBe('move')
    expect(second.status).toBe('move')
    expect(first.path).not.toBe(second.path)
    expect(branchOf(first.path ?? '')).toBe('feat/11-first-child')
    expect(branchOf(second.path ?? '')).toBe('fix/12-second-child')
  })

  it('converges concurrent preparation of one issue onto one checkout', async () => {
    const box = principal()
    const results = await Promise.all([prepare(tool, box.repo, '#11'), prepare(tool, box.repo, '#11')])
    const path = join(box.checkouts, 'app', 'feat-11-first-child')
    expect(results.every((item) => item.status === 'move' && item.path === path)).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(git(box.repo, ['worktree', 'list', '--porcelain']).match(/feat\/11-first-child/g)).toEqual([
      'feat/11-first-child',
    ])
  })

  it('checks out a pull request on its existing head instead of minting an issue branch', async () => {
    const box = principal()
    git(box.repo, ['checkout', '-q', '-b', 'feat/7-existing'])
    writeFileSync(join(box.repo, 'head.txt'), 'existing head\n')
    git(box.repo, ['add', '--', 'head.txt'])
    git(box.repo, ['commit', '-qm', 'feat: existing head'])
    const head = git(box.repo, ['rev-parse', 'HEAD'])
    git(box.repo, ['push', '-q', 'origin', 'feat/7-existing'])
    git(box.repo, ['checkout', '-q', 'main'])
    git(box.repo, ['branch', '-D', 'feat/7-existing'])
    const prepared = await prepare(tool, box.repo, '#7')
    const path = join(box.checkouts, 'app', 'feat-7-existing')
    expect(prepared).toEqual({ status: 'move', path, instruction: `/move ${path}` })
    expect(branchOf(path)).toBe('feat/7-existing')
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(head)
    expect(head).not.toBe(box.head)
    expect(git(box.repo, ['branch', '--list', 'feat/7-land-it'])).toBe('')
    expect(ghLog(box.log).some((line) => line.includes('issue view 7'))).toBe(false)
    expect(ghLog(box.log).some((line) => line.startsWith('pr view 7'))).toBe(true)
  })

  it('refuses an ambiguous reference, a foreign repository, a missing issue, and a non-checkout', async () => {
    const box = principal()
    expect(await prepare(tool, box.repo, 'not-an-issue')).toEqual({
      status: 'blocked',
      reason: 'issue-reference-ambiguous',
    })
    expect(ghLog(box.log)).toEqual([])
    expect(await prepare(tool, box.repo, 'Other/repo#11')).toEqual({
      status: 'blocked',
      reason: 'repository-mismatch',
    })
    expect(ghLog(box.log).some((line) => line.includes('issue view'))).toBe(false)
    expect(await prepare(tool, box.repo, '#13')).toEqual({ status: 'blocked', reason: 'issue-unreadable' })
    const empty = mkdtempSync(join(box.root, 'empty-'))
    expect(await prepare(tool, empty, '#11')).toEqual({ status: 'blocked', reason: 'session-not-a-worktree' })
    await expect(tool.execute('call', { reference: '#11', approve: true }, { cwd: box.repo })).rejects.toThrow(
      'invalid-omp-build-prepare-checkout-parameters',
    )
  })
})
