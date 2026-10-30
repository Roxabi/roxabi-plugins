import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract.ts'
import { runInstalledFeatureCommand } from '../../roxabi/feature-entry.ts'
import { continueFeature } from '../../roxabi/workflow.ts'
import { defaultGit } from '../../roxabi/workflow-checkout.ts'
import { normalizationHandoffFixture } from '../../testing/normalization-handoff-fixture.ts'

let root: string | undefined
afterEach(() => {
  vi.unstubAllGlobals()
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

it.each([false, true])('refuses a Principal destination when invoked from another worktree: %s', async (linked) => {
  root = mkdtempSync(join(tmpdir(), 'omp-normalization-principal-'))
  const stack = JSON.stringify({ schema_version: '1.0', runtime: 'bun', release: { model: 'trunk' } })
  mkdirSync(join(root, '.dev'))
  writeFileSync(join(root, '.dev', 'stack.yml'), stack)
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  }
  const gitCommand = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' })
  gitCommand('init', '-q', '-b', 'fix/910-principal-normalization-handoff')
  gitCommand('add', '.dev/stack.yml')
  gitCommand('commit', '-q', '-m', 'fixture')
  gitCommand('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const cwd = linked ? join(root, 'other') : root
  if (linked) gitCommand('worktree', 'add', '-q', '-b', 'other', cwd)
  // The test runner is Node; the fixture document is JSON, a YAML subset.
  vi.stubGlobal('Bun', { ...globalThis.Bun, YAML: { parse: JSON.parse } })

  const fixture = normalizationHandoffFixture()
  const messages: string[] = []
  const results: ContinueFeatureResult[] = []
  const attempted: string[] = []
  let workflowCalls = 0
  const forbidden = (name: string): never => {
    attempted.push(name)
    throw new Error(`unexpected ${name}`)
  }
  const workflow: FeatureWorkflow = {
    continueFeature: async (input) => {
      workflowCalls++
      const result = await continueFeature({ ...input, git: defaultGit(), gh: fixture.gh, read: fixture.read })
      results.push(result)
      return result
    },
    consumeWatchExit: async () => forbidden('watch'),
    publishFeatureNativeResult: async () => forbidden('publication'),
    requestFeatureSessionPause: async () => forbidden('pause'),
  }
  const host: FeatureCommandHost = {
    key: {},
    cwd,
    principal: !linked,
    workflow,
    native: {
      activate: () => forbidden('activate'),
      inactive: () => forbidden('inactive'),
      stopOwned: async () => forbidden('stop'),
      announce: async () => forbidden('announce'),
    },
    send: async (message) => {
      messages.push(message)
    },
    status: () => {},
    inhibitFeatureContinuation: () => {},
    releaseFeatureContinuation: () => {},
    featureContinuationInhibited: () => false,
    markFeatureBatch: () => forbidden('batch'),
    startReview: async () => forbidden('review'),
    startFix: async () => forbidden('fix'),
    startAdmittedCiCorrection: async () => forbidden('correction'),
    prepareEpicRangeReview: async () => forbidden('epic-review'),
    exec: async () => forbidden('exec'),
  }
  await runInstalledFeatureCommand('#910', host)
  expect(results).toEqual([{ kind: 'blocked', reason: 'checkout-refused-principal' }])
  expect(messages[0]).toContain('checkout-refused-principal')
  expect(existsSync(join(root, '.git', 'omp-build-bootstrapped'))).toBe(false)
  expect(attempted).toEqual([])
  expect(fixture.rejected).toEqual([])
  expect(workflowCalls).toBe(1)
})
