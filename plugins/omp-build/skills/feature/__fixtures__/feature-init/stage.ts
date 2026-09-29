import { cpSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/** Fictional target repositories for the feature-init tests. */
export const FIXTURES = import.meta.dirname

/** Every fixture repository under FIXTURES. */
export const FIXTURE_NAMES = ['acme', 'kept', 'kept-hidden', 'pr-only', 'hooks-ok'] as const

/**
 * Copies fixture `name` to `dest` and writes the one invented merge gate as its
 * merge-on-green workflow, so the four copies cannot drift apart.
 */
export function stageFixture(name: string, dest: string): string {
  cpSync(path.join(FIXTURES, name), dest, { recursive: true })
  mkdirSync(path.join(dest, '.github', 'workflows'), { recursive: true })
  cpSync(path.join(FIXTURES, 'merge-gate.template.yml'), path.join(dest, '.github', 'workflows', 'merge-on-green.yml'))
  return dest
}
