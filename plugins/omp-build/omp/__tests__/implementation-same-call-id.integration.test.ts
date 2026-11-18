import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import type { Json } from '../../contracts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { COMMIT_COMMAND, SAME_CALL_PROOF_COMMAND } from '../../testing/implementation-same-call-id-child.ts'
import { readSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { NativeProofBashCall } from '../review-runtime/contracts.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = resolve(import.meta.dirname, '../../testing/implementation-same-call-id-worker.ts')
const fault = resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts')

afterEach(cleanupFeatureRecoveryRoots)

function capturedText(captured: Json | null): string {
  if (captured === null || typeof captured !== 'object' || Array.isArray(captured) || !Array.isArray(captured.content))
    throw new Error('same-call-bash-output-missing')
  return captured.content
    .flatMap((block) =>
      block !== null &&
      typeof block === 'object' &&
      !Array.isArray(block) &&
      block.type === 'text' &&
      typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('\n')
}

function assertSameCall(call: NativeProofBashCall | undefined, command: string, checkout: string, completion: string) {
  if (call === undefined) throw new Error('same-call-bash-capture-missing')
  const text = capturedText(call.result)
  const marker = /(?:^|\n)OMP_TOOL_CALL_ID=([^\s]+)/.exec(text)?.[1]
  if (marker === undefined) throw new Error(`same-call-marker-missing:${text}`)
  expect(marker, text).toEqual(call.toolCallId)
  expect(text.split('\n')).toContain(completion)
  expect(call.exitCode).toBe(0)
  if (call.effectiveCwd === null) throw new Error('same-call-cwd-missing')
  expect(realpathSync(call.effectiveCwd)).toBe(realpathSync(checkout))
  expect(call.input).toEqual({ command })
  return { toolCallId: marker, command, exitCode: 0 }
}

it('admits an implementation command whose toolCallId came from the same Bash PI_TOOL_CALL_ID', () => {
  const { box, checkout } = featureFixture('plan')
  const gh = join(box.root, 'bin', 'gh')
  unlinkSync(gh)
  symlinkSync(fault, gh)
  mkdirSync(join(box.root, 'gh-config'))
  const env: NodeJS.ProcessEnv = {
    ...box.env,
    HOME: box.root,
    GH_CONFIG_DIR: join(box.root, 'gh-config'),
    GH_SIM_STATE: box.stateFile,
    RECOVERY_TEST_CREDENTIAL: 'fixture-model-only',
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'])
    delete env[key]
  const child = spawnSync(bun, [worker, checkout, box.root, box.stateFile], {
    cwd: checkout,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(child.status, `signal=${child.signal} error=${String(child.error)}\n${child.stderr}\n${child.stdout}`).toBe(0)
  const line = child.stdout
    .trim()
    .split('\n')
    .findLast((item) => item.startsWith('{"called"'))
  if (line === undefined) throw new Error(`same-call-worker-report-missing:\n${child.stderr}\n${child.stdout}`)
  const report = JSON.parse(line) as {
    called: boolean
    dispatches: string[]
    children: string[]
    errors: unknown[]
  }
  expect(report.called).toBe(true)
  expect(report.dispatches).toEqual(['same-call-native'])
  expect(report.children).toHaveLength(1)
  expect(report.errors).toEqual([])

  const history = decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
      locator: `${SCOPE.target}:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
  const result = history.operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === 'implement' &&
      operation.record.payload.phase === 'result',
  )?.record
  if (result?.kind !== 'action-receipt' || result.payload.action !== 'implement' || result.payload.phase !== 'result')
    throw new Error('same-call-implementation-result-missing')

  expect(result.payload).toMatchObject({
    native: { completion: 'completed', strict: 'valid' },
    structured: {
      outcome: 'implemented',
      criteria: [{ verification: 'unverified' }],
    },
    admission: { admitted: true, published: true },
  })

  const bashCalls = result.payload.native.bashCalls ?? []
  expect(bashCalls).toHaveLength(2)
  const claimed = [COMMIT_COMMAND, SAME_CALL_PROOF_COMMAND].map((command, index) =>
    assertSameCall(bashCalls[index], command, checkout, index === 0 ? 'COMMIT_OK' : 'APP_OK'),
  )

  if (result.payload.structured?.outcome !== 'implemented' || result.payload.admission?.admitted !== true)
    throw new Error('same-call-admission-shape-unexpected')
  expect(result.payload.structured.commands).toEqual(claimed)
  expect(result.payload.admission.commands).toEqual(
    claimed.map((command, index) => ({ ...command, cwd: bashCalls[index]?.effectiveCwd })),
  )
  expect(result.payload.admission.commits).toHaveLength(1)
  expect(result.payload.admission.commits[0]).toMatch(/^[0-9a-f]{40}$/)
})
