import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startAdmittedCiCorrection } from './fix-entry-ci.ts'
import { runDefaultFix } from './fix-entry-default.ts'
import { resolvePublishBinding } from './fix-entry-target-binding.ts'

const boxes: string[] = []
afterEach(() => {
  for (const box of boxes.splice(0)) rmSync(box, { recursive: true, force: true })
})

function setup() {
  const box = mkdtempSync(join(tmpdir(), 'fix-publish-binding-'))
  boxes.push(box)
  const cwd = join(box, 'work')
  const remote = join(box, 'origin.git')
  mkdirSync(cwd)
  const git = (directory: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
  git(box, 'init', '--bare', remote)
  git(cwd, 'init', '-b', 'fix/test')
  git(cwd, 'config', 'user.email', 'test@example.com')
  git(cwd, 'config', 'user.name', 'Test')
  git(cwd, 'commit', '--allow-empty', '-m', 'initial')
  git(cwd, 'remote', 'add', 'origin', remote)
  git(cwd, 'push', 'origin', 'HEAD:refs/heads/fix/test')
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const calls: string[][] = []
  const gh = async (_cwd: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'repo' && args[1] === 'view')
      return JSON.stringify({
        nameWithOwner: 'acme/app',
        defaultBranchRef: { name: 'main' },
        url: 'https://github.com/acme/app',
      })
    if (args[0] === 'pr' && args[1] === 'view')
      return JSON.stringify({
        state: 'OPEN',
        headRefOid: git(cwd, 'rev-parse', 'HEAD'),
        headRefName: 'fix/test',
        headRepository: { nameWithOwner: 'acme/app' },
        baseRefName: 'main',
      })
    throw new Error('unexpected GitHub operation')
  }
  const run = async (entry: 'ordinary' | 'ci') => {
    const common = {
      cwd,
      reference: '#7',
      gh,
      native: {} as never,
      workflow: {} as never,
      operations: {} as never,
      uw: {} as never,
    }
    return entry === 'ordinary'
      ? runDefaultFix({ ...common, args: 'correct the failure' }, {} as never, {} as never)
      : startAdmittedCiCorrection({ ...common, attributionRecordId: 'attribution-1', expectedUw: {} as never })
          .completion
  }
  return { box, cwd, remote, git, gh, calls, run }
}

describe('correction publish binding entry', () => {
  it.each(['ordinary', 'ci'] as const)('refuses absent and moved remote heads before %s publication', async (entry) => {
    const s = setup()
    s.git(s.remote, 'update-ref', '-d', 'refs/heads/fix/test')
    const absent = await s.run(entry)
    expect(absent).toEqual({ ok: false, diagnostics: ['fix-publish-remote-head-mismatch'] })
    s.git(s.cwd, 'push', 'origin', 'HEAD:refs/heads/fix/test')
    s.git(s.cwd, 'commit', '--allow-empty', '-m', 'new head')
    const moved = await s.run(entry)
    expect(moved).toEqual({ ok: false, diagnostics: ['fix-publish-remote-head-mismatch'] })
    expect(s.calls.every((args) => args[0] === 'repo' || args[0] === 'pr')).toBe(true)
  })

  it.each(['ordinary', 'ci'] as const)(
    'refuses credential-bearing effective push URLs before %s publication',
    async (entry) => {
      const s = setup()
      for (const url of [
        'https://fixture-token@github.com/acme/app.git',
        'https://x-access-token:fixture-secret@github.com/acme/app.git',
        'https://x\\:fixture-secret@github.com/acme/app.git',
        'x-access-token:fixture-secret@github.com:acme/app.git',
        'fixture-secret@github.com:acme/app.git',
        'https://github.com/acme/app.git?access_token=fixture-secret',
      ]) {
        s.git(s.cwd, 'config', 'remote.origin.pushurl', url)
        const result = await s.run(entry)
        expect(result).toEqual({ ok: false, diagnostics: ['fix-publish-remote-credential-refused'] })
        expect(JSON.stringify(result)).not.toMatch(/fixture-secret|fixture-token/)
      }
      expect(
        s.calls.every((args) => (args[0] === 'repo' || args[0] === 'pr') && !args.join(' ').includes('fixture-')),
      ).toBe(true)
      s.git(s.cwd, 'config', '--unset', 'remote.origin.pushurl')
      const head = s.git(s.cwd, 'rev-parse', 'HEAD')
      const binding = await resolvePublishBinding(s.cwd, s.gh, 'acme/app', {
        repository: 'acme/app',
        target: 'acme/app#7',
        number: 7,
        kind: 'pull-request',
        state: 'open',
        candidateGitSHA: head,
        baseGitSHA: head,
      })
      expect(binding.ok).toBe(true)
    },
  )
  it.each(['ordinary', 'ci'] as const)(
    'refuses Git-rewritten credential-bearing push URLs before %s publication',
    async (entry) => {
      for (const rewrite of ['insteadOf', 'pushInsteadOf']) {
        const s = setup()
        const effective = 'https://x-access-token:fixture-secret@github.com/acme/app.git'
        s.git(s.cwd, 'config', `url.${effective}.${rewrite}`, s.remote)
        expect(s.git(s.cwd, 'remote', 'get-url', '--push', 'origin')).toBe(effective)
        const result = await s.run(entry)
        expect(result).toEqual({ ok: false, diagnostics: ['fix-publish-remote-credential-refused'] })
        expect(JSON.stringify(result)).not.toContain('fixture-secret')
        expect(s.calls.every((args) => !args.join(' ').includes('fixture-secret'))).toBe(true)
        expect(s.calls.every((args) => args[0] === 'repo' || args[0] === 'pr')).toBe(true)
      }
    },
  )
})
