import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Json } from '../dist/contracts.js'
import type { CorrectionCause } from './fix-domain'

const roots = new Set<string>()
const environment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  BASH_ENV: '/dev/null',
}

export const cause: CorrectionCause = {
  id: 'RC-guard',
  title: 'restore the guard',
  mechanism: 'persisted value bypasses validation',
  fix: 'validate before persistence',
  failure: 'invalid value reaches persistence',
  restored: 'invalid value is rejected',
  paths: ['src/guard.txt'],
  proof: 'repository guard proof',
  findingIds: ['finding-1'],
}

export type Workspace = {
  cwd: string
  head: string
  binding: {
    pushUrl: string
    publicationRepository: string
    localBranch: string
    destinationRef: string
    localHead: string
    expectedRemoteSHA: string
    defaultBranch: string
    observed: Json
  }
}

export type Continuation = {
  signal: AbortSignal
  authorizeContinuation?(): Promise<{ ok: true; value: undefined } | { ok: false; diagnostics: string[] }>
}

export function cleanupWorkspaces(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: environment,
  }).trim()
}

export function bash(cwd: string, command: string): { exitCode: number; result: Json } {
  try {
    const stdout = execFileSync('bash', ['-c', command], { cwd, encoding: 'utf8', env: environment })
    return { exitCode: 0, result: { stdout } }
  } catch (error) {
    const detail = error as { status?: number; stdout?: string; stderr?: string }
    return {
      exitCode: detail.status ?? 1,
      result: { stdout: detail.stdout ?? '', stderr: detail.stderr ?? '' },
    }
  }
}

function allocate(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.add(path)
  return path
}

export function workspace(): Workspace {
  const cwd = allocate('omp-correction-execution-')
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test User'])
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: missing\n')
  git(cwd, ['add', '--', 'src/guard.txt'])
  git(cwd, ['commit', '-m', 'initial'])
  const defaultBranch = git(cwd, ['branch', '--show-current'])
  git(cwd, ['checkout', '-b', 'fix-smoke'])
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const pushUrl = allocate('omp-correction-remote-')
  git(pushUrl, ['init', '--bare'])
  git(cwd, ['remote', 'add', 'origin', pushUrl])
  git(cwd, ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/fix-smoke'])

  return {
    cwd,
    head,
    binding: {
      pushUrl,
      publicationRepository: 'Acme/app',
      localBranch: 'fix-smoke',
      destinationRef: 'refs/heads/fix-smoke',
      localHead: head,
      expectedRemoteSHA: head,
      defaultBranch,
      observed: { source: 'fixture' },
    },
  }
}
