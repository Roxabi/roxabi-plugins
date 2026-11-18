import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { dispose, git } from '../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { parentFixture } from '../testing/feature-parent-topology-fixture.ts'
import { observeParentSuccessorBaseline } from './feature-context-parent-successor.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

it('reobserves the canonical detached parent and refuses dirty, attached or unpublished candidates', async () => {
  const { cwd, before, parent, request } = await parentFixture()
  const authority = { scope: parent, context: { cwd, git: request.git, gh: request.gh } } as FeatureAuthority
  const observe = () => observeParentSuccessorBaseline({ authority, base: 'main', head: before })
  expect(await observe()).toBe(true)
  writeFileSync(join(cwd, 'untracked-successor-effect.txt'), 'unreconciled')
  expect(await observe()).toBe(false)
  git(cwd, ['clean', '-f', 'untracked-successor-effect.txt'])
  git(cwd, ['checkout', '-b', 'unexpected-parent-branch'])
  expect(await observe()).toBe(false)
  git(cwd, ['checkout', '--detach', before])
  expect(await observeParentSuccessorBaseline({ authority, base: 'main', head: '0'.repeat(40) })).toBe(false)
  expect(await observeParentSuccessorBaseline({ authority, base: 'missing', head: before })).toBe(false)
})
