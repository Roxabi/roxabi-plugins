import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, sandbox, worktree } from './__fixtures__/proof/sandbox-repository'
import { plainSpec } from './__fixtures__/proof/sandbox-semctx-spec'
import type { Box } from './__fixtures__/proof/sandbox-types'
import { approve } from './testing/proof-integration/data'
import { land, UNARMED } from './testing/proof-integration/landing'
import { instrument, prepare } from './testing/proof-integration/setup'

describe('Semctx applicability is decided from the base, the candidate and the checkouts', () => {
  // The principal's directory name ends in a space and a newline; Git paths are kept byte for byte.
  const PRINCIPAL = 'principal \n'
  let box: Box
  let wt: string
  let malformedWt: string
  const head = () => box.sha['fix/5-plain'] as string
  const PR = 30
  // A candidate that commits a Semctx configuration that is not JSON.
  const MALFORMED = { pr: 31, branch: 'fix/5-malformed' }

  beforeAll(() => {
    const spec = plainSpec({ principalName: PRINCIPAL })
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        {
          name: MALFORMED.branch,
          from: 'fix/5-plain',
          commits: [{ message: 'chore: semctx (#5)', files: { '.semctx/config.json': '{"include": [\n' } }],
        },
      ],
      prs: [
        ...spec.prs,
        { number: MALFORMED.pr, branch: MALFORMED.branch, title: 'fix: plain', body: 'Closes #5\n', closes: [5] },
      ],
    })
    instrument(box)
    wt = worktree(box, 'plain', head())
    malformedWt = worktree(box, 'malformed', box.sha[MALFORMED.branch] as string)
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it.each([
    ['the worktree root', () => wt],
    ['a nested directory', () => path.join(wt, 'src')],
  ])('genuine absence, from %s, makes only Semctx non-applicable', (_label, cwd) => {
    prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
    const { result, gate } = land(box, cwd(), PR)
    expect(result).toMatchObject({ status: 'watching', proof: { semctx: 'absent', assertledger: 'not-applicable' } })
    expect(gate.labels).toEqual(['reviewed'])
  })

  it.each([
    ['the worktree root, from the root', () => wt, () => path.join(wt, '.semctx')],
    ['the worktree root, from a nested directory', () => path.join(wt, 'src'), () => path.join(wt, '.semctx')],
    ['the principal, whose path ends in a space and a newline', () => wt, () => path.join(box.principal, '.semctx')],
  ])('uncommitted Semctx state in %s is not absence', (_label, cwd, state) => {
    mkdirSync(state())
    try {
      prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
      const { result, gate } = land(box, cwd(), PR)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'ambiguous' })
      expect(result.error).toContain(JSON.stringify(state()))
      expect(gate).toEqual(UNARMED)
    } finally {
      rmSync(state(), { recursive: true })
    }
  })

  it('a local tip that cannot be read — an unborn HEAD — refuses with Git’s cause, never as absence', () => {
    const headFile = git(box, wt, ['rev-parse', '--git-path', 'HEAD'])
    const at = path.isAbsolute(headFile) ? headFile : path.join(wt, headFile)
    const detached = readFileSync(at, 'utf8')
    writeFileSync(at, 'ref: refs/heads/unborn\n')
    try {
      prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
      const { result, gate, producers } = land(box, wt, PR)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unreadable' })
      expect(result.error).toContain('the local tip cannot be read — git rev-parse --verify HEAD^{commit}')
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
    } finally {
      writeFileSync(at, detached)
    }
    prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
    expect(land(box, wt, PR).result).toMatchObject({ status: 'watching', proof: { semctx: 'absent' } })
  })

  it('a committed Semctx configuration that is not JSON refuses as unreadable, never as absence', () => {
    const candidate = box.sha[MALFORMED.branch] as string
    prepare(box, MALFORMED.pr, { comments: [approve(candidate)], body: 'Closes #5\n' })
    const { result, gate, producers } = land(box, malformedWt, MALFORMED.pr)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unreadable' })
    expect(result.error).toContain(`.semctx/config.json at ${candidate} is malformed`)
    expect(gate).toEqual(UNARMED)
    expect(producers).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)(
    'a principal root that loses search permission after Git reads its declarations refuses; restoring access admits',
    () => {
      const bin = path.join(box.root, 'fault-git')
      prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8', env: box.env }).trim()
      mkdirSync(bin)
      const shim = path.join(bin, 'git')
      // Run real Git unchanged, then inject the filesystem race immediately
      // before admission stats .semctx. No Git answer or absence is fabricated.
      writeFileSync(
        shim,
        `#!/bin/sh\n'${realGit}' "$@"\ncode=$?\nif [ "$3" = ls-tree ] && [ "$7" = '${box.sha.main}^{commit}' ]; then chmod 000 '${box.principal}'; fi\nexit "$code"\n`,
      )
      chmodSync(shim, 0o755)
      const originalPath = box.env.PATH
      box.env.PATH = `${bin}:${originalPath}`
      try {
        const { result, gate, producers } = land(box, wt, PR)
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unreadable' })
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
      } finally {
        chmodSync(box.principal, 0o755)
        box.env.PATH = originalPath
      }
      prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
      const admitted = land(box, wt, PR)
      expect(admitted.result).toMatchObject({ status: 'watching', proof: { semctx: 'absent' } })
      expect(admitted.producers).toEqual([])
    },
  )

  it('a candidate whose tree object is missing refuses with Git’s cause, never as absence', () => {
    const tree = git(box, wt, ['rev-parse', `${head()}^{tree}`])
    rmSync(path.join(box.principal, '.git', 'objects', tree.slice(0, 2), tree.slice(2)))
    prepare(box, PR, { comments: [approve(head())], body: 'Closes #5\n' })
    const { result, gate } = land(box, wt, PR)
    expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unreadable' })
    expect(result.error).toContain(`candidate ${head()} cannot be read — git ls-tree`)
    expect(result.error).toContain('fatal: not a tree object')
    expect(gate).toEqual(UNARMED)
  })
})
