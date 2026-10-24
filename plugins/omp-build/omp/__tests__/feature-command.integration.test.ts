import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { implementationOutputSchema } from '../../engine/workflow-output-schema.ts'
import { admitImplementationEvidence } from '../../roxabi/feature-implementation-admission.ts'
import type { Json, NativeProofBashCall } from '../review-runtime/contracts.ts'

const fixtureRoots = new Set<string>()
const proofCommand = 'git diff --quiet HEAD'
const fixtureEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  BASH_ENV: '/dev/null',
}

function allocateFixtureRoot(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-build-implementation-admission-'))
  fixtureRoots.add(cwd)
  return cwd
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: fixtureEnv,
  }).trim()
}

function admissionFixture(subject = 'feat(feature): admit qualified evidence (#42)'): {
  cwd: string
  start: string
  tip: string
} {
  const cwd = allocateFixtureRoot()
  git(cwd, ['init', '-q'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test User'])
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: absent\n')
  git(cwd, ['add', '--', 'src/guard.txt'])
  git(cwd, ['commit', '-qm', 'chore: base'])
  const start = git(cwd, ['rev-parse', 'HEAD'])
  writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: restored\n')
  git(cwd, ['add', '--', 'src/guard.txt'])
  git(cwd, ['commit', '-qm', subject])
  return { cwd, start, tip: git(cwd, ['rev-parse', 'HEAD']) }
}

function captured(
  cwd: string,
  toolCallId: string,
  command: string,
  extraDetails: Record<string, Json> = {},
): NativeProofBashCall {
  const run = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', env: fixtureEnv })
  const stdout = String(run.stdout ?? '')
  const stderr = String(run.stderr ?? '')
  return {
    toolCallId,
    input: { command },
    effectiveCwd: cwd,
    result: {
      content: [{ type: 'text', text: `${stdout}${stderr}` }],
      details: { stdout, stderr, ...extraDetails },
    },
    exitCode: run.status ?? 1,
  }
}

function observedExit(call: NativeProofBashCall): number {
  if (call.exitCode === null) throw new Error('capture exited without a status')
  return call.exitCode
}

function capturedProofs(
  cwd: string,
  greenDetails: Record<string, Json> = {},
): { red: NativeProofBashCall; green: NativeProofBashCall } {
  writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: temporarily removed\n')
  const red = captured(cwd, 'red-1', proofCommand)
  writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: restored\n')
  const green = captured(cwd, 'green-1', proofCommand, greenDetails)
  return { red, green }
}

function implementationClaim(tip: string, red: NativeProofBashCall, green: NativeProofBashCall) {
  return implementationOutputSchema.parse({
    outcome: 'implemented',
    commitSHAs: [tip],
    commands: [
      { toolCallId: red.toolCallId, command: proofCommand, exitCode: observedExit(red) },
      { toolCallId: green.toolCallId, command: proofCommand, exitCode: observedExit(green) },
    ],
    proofToolCallId: green.toolCallId,
    proofUnavailableReason: null,
    reason: 'the captured command exercises the changed path',
  })
}

afterEach(() => {
  for (const cwd of fixtureRoots) rmSync(cwd, { recursive: true, force: true })
  fixtureRoots.clear()
})

describe('implementation admission', () => {
  it('does not admit implemented commits when the command list is empty', async () => {
    const fixture = admissionFixture()
    const { red, green } = capturedProofs(fixture.cwd)
    const claim = implementationClaim(fixture.tip, red, green)

    const admission = await admitImplementationEvidence({
      cwd: fixture.cwd,
      startHead: fixture.start,
      ticket: 42,
      children: [{ structured: { ...claim, commands: [] }, bashCalls: [green] }],
    })

    expect(admission).toEqual({
      admitted: false,
      commits: [],
      paths: [],
      commands: [],
      remoteBranch: null,
      remoteTip: null,
      published: false,
      reason: claim.reason,
    })
  })

  it('does not confirm a deferred or nonzero proof, even when the same command text later exits zero', async () => {
    const fixture = admissionFixture()
    const { red, green: deferredGreen } = capturedProofs(fixture.cwd, { async: { state: 'running' } })
    const settledGreen = captured(fixture.cwd, 'green-1', proofCommand)
    const claim = implementationClaim(fixture.tip, red, settledGreen)

    const deferred = await admitImplementationEvidence({
      cwd: fixture.cwd,
      startHead: fixture.start,
      ticket: 42,
      children: [{ structured: claim, bashCalls: [red, deferredGreen] }],
    })
    const nonzero = await admitImplementationEvidence({
      cwd: fixture.cwd,
      startHead: fixture.start,
      ticket: 42,
      children: [
        {
          structured: { ...claim, proofToolCallId: red.toolCallId },
          bashCalls: [red, settledGreen],
        },
      ],
    })

    expect(deferred.admitted).toBe(false)
    expect(deferred.reason).toBe(claim.reason)
    expect(nonzero.admitted).toBe(false)
    expect(nonzero.reason).toBe(claim.reason)
    expect(nonzero.commands.map((command) => command.toolCallId)).toEqual(['red-1', 'green-1'])
  })

  it('binds the chosen foreground capture across red and green runs of the same command', async () => {
    const fixture = admissionFixture()
    const { red, green } = capturedProofs(fixture.cwd)
    const claim = implementationClaim(fixture.tip, red, green)

    const admission = await admitImplementationEvidence({
      cwd: fixture.cwd,
      startHead: fixture.start,
      ticket: 42,
      children: [{ structured: claim, bashCalls: [red, green] }],
    })

    expect(admission).toEqual({
      admitted: true,
      commits: [fixture.tip],
      paths: ['src/guard.txt'],
      commands: [
        { toolCallId: 'red-1', command: proofCommand, exitCode: 1, cwd: fixture.cwd },
        { toolCallId: 'green-1', command: proofCommand, exitCode: 0, cwd: fixture.cwd },
      ],
      remoteBranch: null,
      remoteTip: null,
      published: false,
      reason: claim.reason,
    })
  })

  it('requires observed conventional commit subjects to qualify the selected ticket', async () => {
    const admit = async (subject: string, ticket: number) => {
      const fixture = admissionFixture(subject)
      const { red, green } = capturedProofs(fixture.cwd)
      return admitImplementationEvidence({
        cwd: fixture.cwd,
        startHead: fixture.start,
        ticket,
        children: [{ structured: implementationClaim(fixture.tip, red, green), bashCalls: [red, green] }],
      })
    }

    expect((await admit('implemented evidence', 42)).admitted).toBe(false)
    expect((await admit('feat(feature): wrong issue (#7)', 42)).admitted).toBe(false)
    expect((await admit('feat(feature): qualified evidence (#42)', 42)).admitted).toBe(true)
  })
})
