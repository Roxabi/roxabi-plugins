import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { runHeadAuthorization } from './head-authorization-cli.js'
import { PR, reviewHistory } from './review-record-fixture.js'
import { base, dispose, openState, pull } from './testing/gh-simulator/sim-transport-fixture.ts'

const head = 'a'.repeat(40)
const scope = {
  repositoryId: 1,
  pullRequestId: 2,
  pullRequest: 7,
  headSha: head,
  baseRef: 'main',
  baseSha: 'b'.repeat(40),
  authorId: 3,
}
function fixture() {
  const snapshot = { scope, previous: 10 }
  const policy = { operatorIds: [5] }
  const repo = { owner: 'acme', repo: 'app' }
  const api = {
    policyFromRepository: vi.fn(async () => policy),
    resolveRepository: vi.fn(async () => repo),
    captureAuthorization: vi.fn(async () => snapshot),
    readAuthorization: vi.fn(async () => ({ allowed: false })),
    issueAuthorization: vi.fn(async () => ({ id: 11 })),
    withdrawAuthorization: vi.fn(async () => ({ id: 12 })),
  }
  const options = {
    cwd: '/repo',
    authorization: api,
    gh: vi.fn(),
    operationId: () => 'operation',
  }
  return { api, options, snapshot, policy, repo }
}

const manual = ['issue-manual', '--pr', '7', '--head', head, '--evidence', 'opaque://review/1']

describe('head authorization CLI', () => {
  it.each(['ordinary', 'native-history'] as const)('issues, inspects and withdraws for a %s PR', (kind) => {
    const history = reviewHistory(kind === 'native-history' ? [{ head, verdict: 'Request changes' }] : [])
    expect(history.operations.length > 0).toBe(kind === 'native-history')
    const comments = history.source.comments.map(({ body, author }) => ({ body, author }))
    const box = openState(
      base({
        remoteRefs: { main: scope.baseSha },
        prs: { [PR]: pull(PR, 'feature', head, { baseRefOid: scope.baseSha, comments }) },
      }),
    )
    try {
      const bin = join(box.root, 'bin')
      mkdirSync(bin)
      const executable = join(bin, 'gh')
      const simulator = join(import.meta.dirname, 'testing/gh-simulator/gh-simulator.ts')
      writeFileSync(executable, `#!/bin/sh\nexec bun '${simulator}' "$@"\n`)
      chmodSync(executable, 0o755)
      const cli = join(import.meta.dirname, 'head-authorization-cli.js')
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_SIM_STATE: box.file,
      }
      const invoke = (args: string[]) => spawnSync('bun', [cli, ...args], { cwd: box.root, env, encoding: 'utf8' })
      const read = (args: string[]) => {
        const result = invoke(args)
        expect(result.status, result.stderr).toBe(0)
        return JSON.parse(result.stdout)
      }
      const pr = String(PR)
      const wrongHead = invoke(['issue-manual', '--pr', pr, '--head', scope.baseSha, '--evidence', 'review:human'])
      expect(wrongHead.status).toBe(1)
      expect(wrongHead.stderr).toContain('reviewed head does not match current PR head')
      expect(read(['inspect', '--pr', pr])).toMatchObject({ allowed: false, receipt: null })
      const issued = read(['issue-manual', '--pr', pr, '--head', head, '--evidence', 'review:human'])
      expect(issued.record).toMatchObject({ kind: 'grant', source: 'manual', headSha: head, evidence: 'review:human' })
      expect(read(['inspect', '--pr', pr])).toMatchObject({ allowed: true, receipt: { id: issued.id } })
      const withdrawal = read(['withdraw', '--pr', pr, '--reason', 'operator stop'])
      expect(withdrawal.record).toMatchObject({ kind: 'withdraw', evidence: 'operator stop' })
      expect(read(['inspect', '--pr', pr])).toMatchObject({ allowed: false, receipt: { id: withdrawal.id } })
    } finally {
      dispose(box.root)
    }
  })

  it.each([['inspect', '--pr', '7'], ['withdraw', '--pr', '7', '--reason', 'stop'], manual])(
    'refuses an unconfigured repository policy for %s',
    async (...args) => {
      const f = fixture()
      f.api.policyFromRepository.mockResolvedValueOnce(null as never)
      await expect(runHeadAuthorization(args, f.options)).rejects.toThrow(
        'repository authorization policy is not configured',
      )
      expect(f.api.captureAuthorization).not.toHaveBeenCalled()
      expect(f.api.readAuthorization).not.toHaveBeenCalled()
      expect(f.api.withdrawAuthorization).not.toHaveBeenCalled()
    },
  )

  it('rejects a malformed invocation through the executable entry point', () => {
    const cli = fileURLToPath(new URL('./head-authorization-cli.js', import.meta.url))
    const result = spawnSync('bun', [cli, 'issue-manual', '--pr', '7', '--head', 'BAD', '--evidence', 'ref'], {
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('head must be a lowercase 40-character SHA')
  })

  it('reports uncertainty when a possibly accepted manual grant cannot be withdrawn', async () => {
    const f = fixture()
    f.api.issueAuthorization.mockRejectedValueOnce(new Error('readback unavailable'))
    f.api.withdrawAuthorization.mockRejectedValueOnce(new Error('withdrawal unavailable'))
    await expect(runHeadAuthorization(manual, f.options)).rejects.toMatchObject({
      attempt: expect.objectContaining({ operationId: 'operation', snapshot: f.snapshot }),
      withdrawalOperationId: expect.any(String),
    })
    expect(f.api.withdrawAuthorization).toHaveBeenCalledOnce()
  })

  it('refuses a different or malformed reviewed head before publication', async () => {
    const f = fixture()
    await expect(
      runHeadAuthorization(['issue-manual', '--pr', '7', '--head', 'b'.repeat(40), '--evidence', 'ref'], f.options),
    ).rejects.toThrow('does not match')
    await expect(
      runHeadAuthorization(['issue-manual', '--pr', '7', '--head', 'BAD', '--evidence', 'ref'], f.options),
    ).rejects.toThrow('lowercase')
    expect(f.api.issueAuthorization).not.toHaveBeenCalled()
  })

  it('routes inspection and withdrawal without capturing a grant snapshot', async () => {
    const f = fixture()
    await expect(runHeadAuthorization(['inspect', '--pr', '7'], f.options)).resolves.toEqual({ allowed: false })
    await expect(
      runHeadAuthorization(['withdraw', '--pr', '7', '--reason', 'operator stop'], f.options),
    ).resolves.toEqual({ id: 12 })
    expect(f.api.withdrawAuthorization).toHaveBeenCalledWith({
      cwd: '/repo',
      gh: f.options.gh,
      repo: f.repo,
      prNumber: 7,
      policy: f.policy,
      operationId: 'operation',
      reason: 'operator stop',
    })
    expect(f.api.captureAuthorization).not.toHaveBeenCalled()
  })
})
