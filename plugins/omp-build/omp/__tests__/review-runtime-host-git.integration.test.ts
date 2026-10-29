import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { batch, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { captureSubagentEvent } from '../review-runtime/capture.ts'
import { commandRunFromCapture } from '../review-runtime/criterion-grounding.ts'
import { observeHostGit } from '../review-runtime/host-git-observation.ts'
import { createActiveBatch } from '../review-runtime/state.ts'

const roots: string[] = []

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function cleanRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-host-git-'))
  roots.push(cwd)
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'host-git@example.invalid'])
  git(cwd, ['config', 'user.name', 'host-git'])
  writeFileSync(join(cwd, 'note.txt'), 'clean\n')
  git(cwd, ['add', 'note.txt'])
  git(cwd, ['commit', '-m', 'clean'])
  git(cwd, ['remote', 'add', 'origin', 'git@github.com:Roxabi/roxabi-plugins.git'])
  return cwd
}

afterEach(() => {
  cleanupFixtureActions()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('host git observation', () => {
  it('records the real clean identity at bash start and end, and omits a dirty tree', async () => {
    const cwd = cleanRepo()
    const expected = {
      repository: 'Roxabi/roxabi-plugins',
      commit: git(cwd, ['rev-parse', '--verify', 'HEAD']),
      tree: git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}']),
    }
    const prepared = batch(['child'])
    prepared.operationId = 'host-git'
    const active = createActiveBatch(
      prepared,
      { onComplete: async () => undefined, onStop: async () => undefined },
      cwd,
      null,
      observeHostGit,
    )
    captureSubagentEvent(
      active,
      {
        id: 'child',
        event: { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'bash-1', args: { command: 'true' } },
      },
      false,
    )
    captureSubagentEvent(
      active,
      {
        id: 'child',
        event: {
          type: 'tool_execution_end',
          toolName: 'bash',
          toolCallId: 'bash-1',
          isError: false,
          result: { details: { exitCode: 0 } },
        },
      },
      false,
    )
    const span = active.captures.get('child')?.hostGit.get('bash-1')
    expect(span).toEqual({ start: expected, end: expected })
    const completed = active.captures.get('child')?.completedBashCalls.get('bash-1')
    expect(completed).toBeDefined()
    if (completed === undefined || span === undefined) return
    completed.result = { content: [{ type: 'text', text: 'ok\n' }] }
    const equal = commandRunFromCapture(completed, {
      probeCwd: completed.effectiveCwd,
      start: span.start,
      end: span.end,
    })
    expect(equal?.command).toBe('true')
    expect(equal?.output).toEqual({
      kind: 'sdk-view',
      text: 'ok\n',
      source: 'native-tool-result',
      completeness: 'potentially-incomplete',
    })
    expect(equal).not.toHaveProperty('code')
    expect(equal?.context).toEqual({ probeCwd: cwd, start: expected, end: expected })
    writeFileSync(join(cwd, 'note.txt'), 'dirty\n')
    expect(observeHostGit(cwd)).toBeNull()
    const dirty = commandRunFromCapture(completed, {
      probeCwd: completed.effectiveCwd,
      start: expected,
      end: null,
    })
    expect(dirty?.output).toEqual({
      kind: 'sdk-view',
      text: 'ok\n',
      source: 'native-tool-result',
      completeness: 'potentially-incomplete',
    })
    expect(dirty?.context.end).toBeNull()
    expect(dirty).not.toHaveProperty('code')
  })
})
