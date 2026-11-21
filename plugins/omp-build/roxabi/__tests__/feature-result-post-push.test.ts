import { expect, it, vi } from 'vitest'
import type { NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import type { FeatureNativePublication } from '../feature-contract.ts'
import { disarmBranchBeforePush } from '../feature-disarm.ts'
import { publishRecord } from '../feature-engine.ts'
import { admitImplementationEvidence } from '../feature-implementation-admission.ts'
import { implementationEffectAuthority } from '../feature-implementation-authorization.ts'
import { publishFeatureNativeResult } from '../feature-result.ts'
import { bindImplementationResult } from '../feature-result-binding.ts'
import { readFreshUwCausalContext } from '../fix-uw-histories.ts'

vi.mock('../feature-engine.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishRecord: vi.fn(),
  defaultGh: vi.fn(),
}))
vi.mock('../feature-disarm.ts', () => ({ disarmBranchBeforePush: vi.fn() }))
vi.mock('../feature-implementation-admission.ts', () => ({ admitImplementationEvidence: vi.fn() }))
vi.mock('../feature-implementation-authorization.ts', () => ({ implementationEffectAuthority: vi.fn() }))
vi.mock('../feature-result-binding.ts', () => ({ bindImplementationResult: vi.fn() }))
vi.mock('../fix-uw-histories.ts', () => ({ readFreshUwCausalContext: vi.fn() }))

type Failure =
  | 'authority'
  | 'fence'
  | 'publication'
  | 'throw'
  | 'already-denied'
  | 'already-throw'
  | 'already-retention-failed'
  | 'already-retention-throw'
  | 'already-resolved'

function configureFailures(failure: Failure, already: boolean, authorityError: Error, publicationError: Error) {
  const authority = vi.mocked(implementationEffectAuthority).mockReset()
  if (failure === 'already-throw') authority.mockRejectedValueOnce(authorityError)
  else if (already)
    authority.mockResolvedValueOnce({
      ok: false,
      reason: failure === 'already-resolved' ? 'implementation-start-resolved' : 'implementation-authority-unreadable',
    })
  else
    authority
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(
        failure === 'authority' ? { ok: false, reason: 'implementation-authority-unreadable' } : { ok: true },
      )
  vi.mocked(publishRecord)
    .mockReset()
    .mockResolvedValue(
      (failure === 'publication' || failure === 'already-retention-failed'
        ? { ok: false, reason: 'record-invalid' }
        : { ok: true }) as never,
    )
  if (failure === 'throw' || failure === 'already-retention-throw')
    vi.mocked(publishRecord).mockRejectedValue(publicationError)
}

function assertRefusal(failure: Failure, published: FeatureNativePublication, branch: string, tip: string) {
  expect(published).toMatchObject({
    published: false,
    retained: failure === 'authority' || failure === 'already-denied',
    reason:
      failure === 'publication' || failure === 'already-retention-failed'
        ? 'record-invalid'
        : failure === 'already-resolved'
          ? 'implementation-start-resolved'
          : 'implementation-authority-unreadable',
    confirmedRemote: { branch, tip },
  })
  if (failure === 'authority' || failure === 'already-denied') {
    expect(publishRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({
          admission: expect.objectContaining({
            admitted: false,
            published: true,
            remoteBranch: branch,
            remoteTip: tip,
            reason: 'implementation-authority-unreadable',
          }),
        }),
      }),
      expect.anything(),
      '/checkout',
      [],
    )
  } else if (failure === 'fence' || failure === 'already-resolved') expect(publishRecord).not.toHaveBeenCalled()
  else expect(publishRecord).toHaveBeenCalledOnce()
}

async function assertThrown(
  publish: () => Promise<FeatureNativePublication>,
  cause: Error,
  already: boolean,
  branch: string,
  tip: string,
) {
  try {
    await publish()
    throw new Error('Expected publication failure')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ cause })
    if (already) expect(error).toMatchObject({ confirmedRemote: { branch, tip } })
    expect(String(error)).toContain(cause.message)
    expect(String(error)).toContain(branch)
    expect(String(error)).toContain(tip)
  }
}

it.each([
  'authority',
  'fence',
  'publication',
  'throw',
  'already-denied',
  'already-throw',
  'already-retention-failed',
  'already-retention-throw',
  'already-resolved',
] as const)('preserves the confirmed remote tip on %s failure', async (failure) => {
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const start = { scope, recordId: 'start-1', kind: 'action-receipt' as const }
  const mandate = { ...scope, recordId: 'mandate-1', kind: 'mandate' as const }
  const mandateRef = { scope, recordId: mandate.recordId, kind: 'mandate' as const }
  const branch = 'feat/42-save'
  const tip = 'a'.repeat(40)
  const already = failure.startsWith('already-')
  const history = { source: { scope }, operations: [{ status: 'complete', record: mandate }] }
  const child = {
    id: 'child',
    expectedId: 'child',
    submissions: [],
    proofEvidence: null,
    raw: { exitCode: 0, structuredOutput: null },
    partialText: null,
    structured: { outcome: 'implemented', commitSHAs: [tip], commands: [], criteria: [], reason: 'done' },
    usable: true,
    reason: null,
  }
  let pushed = false
  const loaded = {
    readComposedWorkflowHistory: async () =>
      failure === 'fence' && pushed ? { ok: false, reason: 'unreadable' } : { ok: true, histories: [history] },
    startResolution: () => ({ ok: true, value: null }),
  }
  vi.mocked(bindImplementationResult).mockResolvedValue({
    loaded,
    gh: vi.fn(),
    history,
    receiptScope: scope,
    start: {
      recordId: start.recordId,
      payload: { actionId: 'action-1', inputs: { manifest: { deliveryData: [] } } },
    },
    mandate: mandateRef,
    branch,
    exactInputs: { mandateId: mandate.recordId, planActionId: 'plan-1' },
    publicationParents: [],
    child,
  } as never)
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({ ok: true, value: { histories: [history] } } as never)
  vi.mocked(admitImplementationEvidence).mockResolvedValue({
    admitted: true,
    commits: [tip],
    paths: ['file.ts'],
    commands: [],
    remoteBranch: null,
    remoteTip: null,
    published: false,
    reason: 'done',
  } as never)
  vi.mocked(disarmBranchBeforePush).mockResolvedValue(true)
  const authorityError = new Error('authority read exploded')
  const publicationError = new Error('publication exploded')
  configureFailures(failure, already, authorityError, publicationError)
  const git = vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: args[1] === '--abbrev-ref' ? branch : tip, stderr: '' }
    if (args[0] === 'ls-remote')
      return { code: 0, stdout: `${already || pushed ? tip : 'b'.repeat(40)}\trefs/heads/${branch}\n`, stderr: '' }
    if (args[0] === 'push') {
      pushed = true
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
  const result: NativeBatchResult = {
    batch: {
      operationId: 'action-1',
      tasks: {
        context: '',
        tasks: [
          {
            name: 'child',
            agent: 'R-workflow-implement',
            task: '',
            solutionSpace: '',
            action: { inputs: { manifest: { purpose: 'implement' } } } as never,
          },
        ],
      },
    },
    children: [child],
    raw: null,
    complete: true,
  }
  if (failure === 'throw' || failure === 'already-throw' || failure === 'already-retention-throw') {
    await assertThrown(
      () =>
        publishFeatureNativeResult({
          cwd: '/checkout',
          start,
          result,
          git,
          gh: async () => '',
          startHead: 'c'.repeat(40),
        }),
      failure === 'already-throw' ? authorityError : publicationError,
      already,
      branch,
      tip,
    )
    expect(pushed).toBe(!already)
    expect(git.mock.calls.filter(([, args]) => args[0] === 'push')).toHaveLength(already ? 0 : 1)
    if (failure === 'already-throw') expect(publishRecord).not.toHaveBeenCalled()
    return
  }
  const published = await publishFeatureNativeResult({
    cwd: '/checkout',
    start,
    result,
    git,
    gh: async () => '',
    startHead: 'c'.repeat(40),
  })

  expect(pushed).toBe(!already)
  expect(git.mock.calls.filter(([, args]) => args[0] === 'push')).toHaveLength(already ? 0 : 1)
  assertRefusal(failure, published, branch, tip)
})
