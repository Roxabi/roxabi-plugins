import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  claimedRun,
  contentReading,
  criterionTarget,
  evidenceRef,
  passingTest,
  satisfied,
  solo,
} from '../../engine/__tests__/criterion-admission-fixture.ts'
import { assessCriterionReview } from '../../engine/criterion-admission.ts'
import { implementationOutputSchema, producerImplementationOutputSchema } from '../../engine/workflow-output-schema.ts'
import { admitImplementationEvidence } from '../../roxabi/feature-implementation-admission.ts'
import { hostCompletedStructured } from '../../roxabi/feature-implementation-receipt.ts'
import type { Json, NativeProofBashCall } from '../review-runtime/contracts.ts'

const fixtureRoots = new Set<string>()
const proofCommand = 'git diff --quiet HEAD'
const fixtureEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
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
    criteria: [
      {
        target: criterionTarget('C1'),
        verification: 'unverified',
        reason: 'command admission is under test; this declaration is not evidence',
      },
    ],
    reason: 'the captured command exercises the changed path',
  })
}

afterEach(() => {
  for (const cwd of fixtureRoots) rmSync(cwd, { recursive: true, force: true })
  fixtureRoots.clear()
})

describe('implementation admission', () => {
  it('admits an owned commit when content evidence cites no command', async () => {
    const fixture = admissionFixture()
    const claim = implementationOutputSchema.parse({
      outcome: 'implemented',
      commitSHAs: [fixture.tip],
      commands: [],
      criteria: [{ target: criterionTarget('C1'), verification: 'evidence', evidence: [contentReading()] }],
      reason: 'the owned commit is admitted from source-grounded content evidence',
    })

    const admission = await admitImplementationEvidence({
      cwd: fixture.cwd,
      startHead: fixture.start,
      ticket: 42,
      children: [{ structured: claim }],
    })

    expect(admission).toEqual({
      admitted: true,
      commits: [fixture.tip],
      paths: ['src/guard.txt'],
      commands: [],
      remoteBranch: null,
      remoteTip: null,
      published: false,
      reason: claim.reason,
    })
  })

  it('does not admit printed test evidence that has no captured command', async () => {
    const fixture = admissionFixture()
    const code = { repository: 'acme/app', commit: fixture.tip }
    const target = criterionTarget('C1')
    const claim = producerImplementationOutputSchema.parse({
      outcome: 'implemented',
      commitSHAs: [fixture.tip],
      commands: [],
      criteria: [
        {
          target,
          verification: 'evidence',
          evidence: [
            {
              id: 'printed-test',
              target,
              method: 'test',
              scenario: 'reload keeps the selected region',
              after: {
                toolCallId: 'uncaptured-test',
                versionClaim: { code, reason: 'the producer claims the candidate was exercised', references: [] },
              },
              before: null,
            },
          ],
        },
      ],
      reason: 'printed test evidence is not a captured command',
    })
    const completed = implementationOutputSchema.parse(hostCompletedStructured({ structured: claim }))
    expect(completed.criteria).toEqual([
      { target, verification: 'unverified', reason: 'host capture absent for uncaptured-test' },
    ])
    expect(
      producerImplementationOutputSchema.safeParse({
        ...claim,
        criteria: [{ target, verification: 'evidence', evidence: [passingTest('C1')] }],
      }).success,
    ).toBe(false)

    const admission = await admitImplementationEvidence({
      cwd: fixture.cwd,
      startHead: fixture.start,
      ticket: 42,
      children: [{ structured: claim }],
    })

    expect(admission.admitted).toBe(true)
    expect(admission.commits).toEqual([fixture.tip])
    const printed = passingTest('C1', { code, after: claimedRun(code, 0, 'printed PASS', 'uncaptured-test') })
    const assessment = assessCriterionReview({
      spec: solo,
      code,
      declarations: completed.criteria,
      verdicts: [satisfied(printed)],
      evidence: [{ ref: evidenceRef(printed), value: printed }],
    })
    expect(assessment.complete && !assessment.requiresChanges).toBe(false)
    expect(assessment.requiresChanges).toBe(true)
  })

  it('does not confirm a deferred proof, even when the same command text later exits zero', async () => {
    const fixture = admissionFixture()
    const { red, green: deferredGreen } = capturedProofs(fixture.cwd, { async: { state: 'running' } })
    const claim = implementationClaim(fixture.tip, red, deferredGreen)

    const deferred = await admitImplementationEvidence({
      cwd: fixture.cwd,
      startHead: fixture.start,
      ticket: 42,
      children: [{ structured: claim, bashCalls: [red, deferredGreen] }],
    })

    expect(deferred.admitted).toBe(false)
    expect(deferred.reason).toBe(claim.reason)
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
