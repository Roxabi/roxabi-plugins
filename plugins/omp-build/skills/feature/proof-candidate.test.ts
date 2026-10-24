import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { semctxInputs } from './proof-association'
import type { Git } from './proof-base'
import { type CandidateFacts, candidateFacts, refreshSelectedBase } from './proof-candidate'
import { mergeBaseOf } from './proof-semctx-protocol'
import {
  BASE_TIP,
  C,
  CONTRACT,
  configured,
  OTHER,
  REPOSITORY,
  repoGit,
  SEMCTX_CONFIG,
  temp,
} from './proof-test-support'

describe('candidateFacts', () => {
  it('reads genuine absence when neither committed tree declares Semctx', async () => {
    const toplevel = temp()
    expect(await candidateFacts(toplevel, C, 'main', BASE_TIP, repoGit({ toplevel }))).toMatchObject({
      toplevel,
      base: 'main',
      semctx: 'absent',
      config: null,
      adapters: [],
    })
  })

  it.each([
    ['unresolved', undefined],
    ['an option', '-main'],
  ])('a PR base that is %s refuses before Git reads it', async (_label, base) => {
    const toplevel = temp()
    expect(await candidateFacts(toplevel, C, base, BASE_TIP, repoGit({ toplevel }))).toMatchObject({
      producer: 'candidate',
      reason: 'unreadable',
      error: expect.stringContaining('is not a branch name'),
    })
  })

  it('a failed HEAD probe refuses with its cause; it is never an unborn branch', async () => {
    const toplevel = temp()
    const tip = { code: 128, stdout: '', stderr: "fatal: ambiguous argument 'HEAD^{commit}': unknown revision" }
    const facts = await candidateFacts(toplevel, C, 'main', BASE_TIP, repoGit({ toplevel, tip }))
    expect(facts).toMatchObject({ ok: false, producer: 'candidate', reason: 'unreadable' })
    expect('error' in facts && facts.error).toContain('the local tip cannot be read')
    expect('error' in facts && facts.error).toContain('unknown revision')
  })

  it('a local tip that is not the candidate refuses as unbound', async () => {
    const toplevel = temp()
    const tip = { code: 0, stdout: `${OTHER}\n`, stderr: '' }
    expect(await candidateFacts(toplevel, C, 'main', BASE_TIP, repoGit({ toplevel, tip }))).toMatchObject({
      producer: 'candidate',
      reason: 'unbound',
    })
  })

  it('keeps a root whose path ends in a space and a newline byte for byte', async () => {
    const toplevel = path.join(temp(), 'wt \n')
    mkdirSync(toplevel)
    expect(await candidateFacts(toplevel, C, 'main', BASE_TIP, repoGit({ toplevel }))).toMatchObject({
      toplevel,
      semctx: 'absent',
    })
  })

  it('refuses committed Semctx state without a committed configuration', async () => {
    const toplevel = temp()
    const facts = await candidateFacts(
      toplevel,
      C,
      'main',
      BASE_TIP,
      repoGit({ toplevel, tree: [{ path: '.semctx/semantic/goals.sem' }] }),
    )
    expect(facts).toMatchObject({ producer: 'semctx', reason: 'ambiguous' })
    expect('error' in facts && facts.error).toContain('ignored local configuration cannot establish portable proof')
  })

  it.each([
    ['only a .gitkeep', '.semctx/working/.gitkeep', { semctx: 'configured' }],
    ['an active-change pointer', '.semctx/working/active-change.sem', { producer: 'semctx', reason: 'ambiguous' }],
  ])('committed working state with %s', async (_label, file, expected) => {
    const toplevel = temp()
    const repo = configured()
    const tree = [...(repo.tree ?? []), { path: file }]
    expect(await candidateFacts(toplevel, C, 'main', BASE_TIP, repoGit({ toplevel, ...repo, tree }))).toMatchObject(
      expected,
    )
  })

  it.each([
    ['a symlink', configured('x', '120000'), /not a regular file/],
    ['malformed JSON', configured('{'), /malformed/],
    ['a JSON array', configured('[]'), /not a JSON object/],
  ])('a config that is %s refuses as unreadable', async (_label, repo, error) => {
    const toplevel = temp()
    const facts = await candidateFacts(toplevel, C, 'main', BASE_TIP, repoGit({ toplevel, ...repo }))
    expect(facts).toMatchObject({ producer: 'semctx', reason: 'unreadable' })
    expect('error' in facts && facts.error).toMatch(error)
  })
})

// ---------------------------------------------------------------------------
// Selected base and merge-base reads on an injected Git
// ---------------------------------------------------------------------------

describe('refreshSelectedBase', () => {
  /** A Git whose fetch succeeds and whose fetched ref names `BASE_TIP`, logging every call. */
  const fetching =
    (calls: string[][]): Git =>
    async (_cwd, args) => {
      calls.push(args)
      if (args[0] === 'remote') return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${BASE_TIP}\n`, stderr: '' }
      return { code: 128, stdout: '', stderr: `fatal: no answer for ${args.join(' ')}` }
    }

  const repository = async () => JSON.stringify({ nameWithOwner: REPOSITORY })

  it('selects the tip the fetch reads', async () => {
    const calls: string[][] = []
    expect(await refreshSelectedBase(temp(), 'main', fetching(calls), repository)).toEqual({
      ok: true,
      tip: BASE_TIP,
    })
  })

  it('refuses an option-shaped base name before fetching it', async () => {
    const calls: string[][] = []
    expect(await refreshSelectedBase(temp(), '-main', fetching(calls), repository)).toMatchObject({
      producer: 'candidate',
      reason: 'unreadable',
    })
    expect(calls).toEqual([])
  })

  it('refuses a fork origin before reading its base as selected-repository policy', async () => {
    const calls: string[][] = []
    const gh = async (_cwd: string, args: string[]) =>
      JSON.stringify({ nameWithOwner: args[2] === '--json' ? REPOSITORY : 'fork/app' })
    expect(await refreshSelectedBase(temp(), 'main', fetching(calls), gh)).toMatchObject({
      ok: false,
      producer: 'candidate',
      reason: 'unbound',
    })
    expect(calls.some((args) => args[0] === 'fetch')).toBe(false)
  })

  it('fetches the verified URL even when origin changes after its repository lookup', async () => {
    const original = 'git@github.com:acme/app.git'
    let remote = original
    let tip = OTHER
    const git: Git = async (_cwd, args) => {
      if (args[0] === 'remote') return { code: 0, stdout: `${remote}\n`, stderr: '' }
      if (args[0] === 'fetch') {
        tip = args[3] === original ? BASE_TIP : OTHER
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: `${tip}\n`, stderr: '' }
    }
    const gh = async (_cwd: string, args: string[]) => {
      if (args[2] === original) remote = 'git@github.com:fork/app.git'
      return JSON.stringify({ nameWithOwner: REPOSITORY })
    }
    expect(await refreshSelectedBase(temp(), 'main', git, gh)).toEqual({ ok: true, tip: BASE_TIP })
  })
})

describe('mergeBaseOf', () => {
  const answering =
    (result: { code: number; stdout: string; stderr: string }): Git =>
    async () =>
      result

  it('returns the common ancestor Git names', async () => {
    expect(await mergeBaseOf(answering({ code: 0, stdout: `${OTHER}\n`, stderr: '' }), temp(), BASE_TIP, C)).toBe(OTHER)
  })

  it.each([
    ['no common ancestor', { code: 1, stdout: '', stderr: '' }],
    ['a failed read', { code: 128, stdout: '', stderr: 'fatal: shallow clone' }],
    ['a failed read that still printed a sha', { code: 128, stdout: `${OTHER}\n`, stderr: 'fatal: shallow clone' }],
    ['an empty answer', { code: 0, stdout: '\n', stderr: '' }],
  ])('%s is an error, never an empty range', async (_label, result) => {
    expect(await mergeBaseOf(answering(result), temp(), BASE_TIP, C)).toBeInstanceOf(Error)
  })
})

describe('historical contract source binding', () => {
  const historical = '.semctx/semantic/changes/change.fx.old.sem'
  const facts: CandidateFacts = {
    toplevel: '/srv/app',
    candidate: C,
    base: 'main',
    baseTip: BASE_TIP,
    semctx: 'configured',
    config: {
      source: 'committed',
      path: '.semctx/config.json',
      text: SEMCTX_CONFIG,
      sha256: createHash('sha256').update(SEMCTX_CONFIG).digest('hex'),
    },
    changeFiles: [CONTRACT, historical],
    stacks: [],
    adapters: [],
  }
  const oid = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const bytes = (comment: number, lifecycle: string) =>
    Buffer.concat([
      Buffer.from('# '),
      Buffer.from([comment]),
      Buffer.from(
        `\nchange change.fx.old\n  statement: Retain the original obligations\n  status: ${lifecycle}\n  provenance: author\n  preserves: invariant.fx.add-sum\n  requires_evidence: proof.fx.old-test\n  link: file:src/a.ts\n`,
      ),
    ])
  const inputs = (before: Buffer, after: Buffer) => {
    const beforeOid = oid(before)
    const afterOid = oid(after)
    const git: Git = async (_cwd, args) => {
      switch (args[0]) {
        case 'merge-base':
          return { code: 0, stdout: `${OTHER}\n`, stderr: '' }
        case 'diff':
          return { code: 0, stdout: `A\0${CONTRACT}\0M\0${historical}\0`, stderr: '' }
        case 'rev-parse':
          return { code: 0, stdout: `${beforeOid}\n${afterOid}\n`, stderr: '' }
        case 'cat-file':
          if (args[2] === beforeOid) return { code: 0, stdout: before.toString('utf8'), stderr: '' }
          if (args[2] === afterOid) return { code: 0, stdout: after.toString('utf8'), stderr: '' }
      }
      return { code: 128, stdout: '', stderr: 'unavailable Git object' }
    }
    return semctxInputs(facts, git)
  }

  it('qualifies a source-preserving lifecycle transition with exact UTF-8 Git blobs', async () => {
    const result = await inputs(bytes(0x61, 'active'), bytes(0x61, 'superseded'))
    if ('ok' in result) throw new Error(result.error)
    expect(result.historicalContracts.get(historical)).toBe('author')
  })

  it('refuses different invalid UTF-8 bytes even when decoding makes their comments identical', async () => {
    const before = bytes(0xff, 'active')
    const after = bytes(0xfe, 'superseded')
    expect(before.toString('utf8').replace('status: active', 'status: superseded')).toBe(after.toString('utf8'))
    expect(await inputs(before, after)).toMatchObject({ ok: false, producer: 'semctx', reason: 'unbound' })
  })
})
