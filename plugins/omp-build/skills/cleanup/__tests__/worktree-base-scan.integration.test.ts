import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initRepo, scanRaw } from './fixture'

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('OMP worktree base orphan scan', () => {
  it('reports a shell under this repo and never another repository', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-build-wt-scan-'))
    const repo = path.join(root, 'repo')
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt-base')
    mkdirSync(home)
    initRepo(repo, home)
    const ours = path.join(base, 'repo', 'feat-orphan')
    const theirs = path.join(base, 'other-repo', 'secret')
    mkdirSync(path.join(ours, 'node_modules'), { recursive: true })
    mkdirSync(path.join(theirs, 'node_modules'), { recursive: true })
    const out = scanRaw(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(out).toContain(ours)
    expect(out).not.toContain('other-repo')
    expect(out).not.toContain(theirs)
  })
})
