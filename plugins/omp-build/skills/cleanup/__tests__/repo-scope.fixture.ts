import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'

let root: string | undefined

export function cleanupRepoScope(): void {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
}

export function tempRoot(tag: string): { root: string; home: string; base: string } {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), `omp-build-622-${tag}-`)))
  const home = path.join(root, 'home')
  mkdirSync(home)
  return { root, home, base: path.join(root, 'wt') }
}

export const pathOf = (line: string) => line.split('|')[0]

/** Kinds of the rows naming exactly `p`. */
export const kinds = (lines: string[], p: string) =>
  lines.map((line) => line.split('|')).flatMap(([rowPath, kind]) => (rowPath === p ? [kind] : []))

/** Rows naming `p` or anything below it. */
export const mentions = (lines: string[], p: string) =>
  lines.filter((line) => pathOf(line) === p || pathOf(line).startsWith(`${p}/`))

/** The `--yes` contract: every row is an empty_parent naming an empty, symlink-free real dir. */
export function expectAllowlisted(yesTargets: string[]): void {
  for (const line of yesTargets) {
    expect(line.split('|')[1]).toBe('empty_parent')
    expect(realpathSync(pathOf(line))).toBe(pathOf(line))
    expect(readdirSync(pathOf(line))).toEqual([])
  }
}
