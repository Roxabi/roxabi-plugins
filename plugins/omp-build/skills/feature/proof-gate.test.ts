import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assessContracts,
  type GateResult,
  type GitFn,
  landApplicability,
  openApplicability,
  type Proof,
  proofBody,
  proofGate,
} from './proof-gate'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'

const base = {
  head: HEAD,
  gaps: [] as string[],
  noTest: {} as Record<string, string>,
  assertledger: null as 'detection' | 'WEAK_ORACLE' | 'miss' | null,
  hasAdapter: false,
  typeFix: false,
}

const check = { steps: 'open the gate', url: 'https://example.test/gate', observed: 'the gate is shut' }

function proof(over: Partial<Proof> = {}): Proof {
  return { ...base, verify: 'VERIFIED', ...over }
}

function refusal(result: GateResult): string {
  if (result.pass) throw new Error('expected a refusal')
  return result.reason
}

/** Injected git. A missing answer is an operational fault, never a silent exemption. */
function gitDouble(root: string, behavior: string, branch = 'feat/751-proof'): GitFn {
  return async (_cwd, args) => {
    const fail = (code: number): never => {
      throw Object.assign(new Error(args.join(' ')), { exitCode: code })
    }
    if (behavior === 'no-repo' && args.includes('--show-toplevel')) fail(128)
    if (args.includes('--show-toplevel')) return root
    if (args[0] === 'worktree' && args[1] === 'list') return `worktree ${root}\n`
    if (args.at(-1) === 'HEAD^{commit}') {
      if (behavior === 'unborn' || behavior === 'corrupt') fail(behavior === 'corrupt' ? 128 : 1)
      return HEAD
    }
    if (args[0] === 'ls-tree' && args.includes('.semctx')) {
      if (behavior === 'missing-object') fail(128)
      if (behavior === 'commit-semctx') return `040000 tree ${OTHER}\t.semctx`
      return ''
    }
    if (args[0] === 'symbolic-ref') return `refs/heads/${branch}`
    if (args[0] === 'show-ref') fail(behavior === 'corrupt' ? 128 : 1)
    return fail(128)
  }
}

describe('proofGate', () => {
  it('passes VERIFIED', () => {
    expect(proofGate(proof())).toEqual({ pass: true })
  })

  it('passes a PARTIAL whose every gap is one of the four fixed reasons', () => {
    for (const reason of ['infra-not-wired', 'prompt-logic-only', 'out-of-scope'] as const) {
      expect(proofGate(proof({ verify: 'PARTIAL', gaps: ['gap'], noTest: { gap: reason } }))).toEqual({ pass: true })
    }
    expect(
      proofGate(
        proof({ verify: 'PARTIAL', gaps: ['gate'], noTest: { gate: 'ui-manual-only' }, uiChecks: { gate: check } }),
      ),
    ).toEqual({ pass: true })
  })

  it('stops an unjustified PARTIAL, including a reason a caller tried to add', () => {
    expect(proofGate(proof({ verify: 'PARTIAL', gaps: ['ui'] })).pass).toBe(false)
    expect(refusal(proofGate(proof({ verify: 'PARTIAL', gaps: ['ui'], noTest: { ui: 'invented' } })))).toMatch(
      /unjustified PARTIAL/,
    )
  })

  it('fails closed on an unknown key instead of widening the enum', () => {
    expect(proofGate({ ...proof(), acceptedReasons: ['invented'] })).toEqual({
      pass: false,
      reason: 'malformed proof: unknown key "acceptedReasons"',
    })
  })

  it('stops BLOCKED', () => {
    expect(proofGate(proof({ verify: 'BLOCKED' }))).toEqual({ pass: false, reason: 'BLOCKED' })
  })

  it('stops a missing or weak oracle on a fix ticket that has an adapter', () => {
    expect(proofGate(proof({ typeFix: true, hasAdapter: true, assertledger: 'WEAK_ORACLE' }))).toEqual({
      pass: false,
      reason: 'WEAK_ORACLE',
    })
    expect(proofGate(proof({ typeFix: true, hasAdapter: true, assertledger: null }))).toEqual({
      pass: false,
      reason: 'assertledger-missing',
    })
  })

  it('does not block when no adapter exists', () => {
    expect(proofGate(proof({ typeFix: true, hasAdapter: false, assertledger: 'WEAK_ORACLE' }))).toEqual({
      pass: true,
    })
  })

  it('refuses ui-manual-only without a recorded check, and whenever e2e is declared', () => {
    const partial = proof({ verify: 'PARTIAL', gaps: ['gate'], noTest: { gate: 'ui-manual-only' } })
    expect(refusal(proofGate(partial))).toMatch(/no uiChecks entry/)
    expect(refusal(proofGate({ ...partial, uiChecks: { gate: { ...check, url: 'not a url' } } }))).toMatch(/url/)
    expect(refusal(proofGate({ ...partial, uiChecks: { gate: check } }, { e2e: true }))).toMatch(/commands\.test_e2e/)
  })
})

describe('assessContracts', () => {
  const file = 'bind.sem'
  const tagged = (id: string, lifecycle: string | null) => ({
    id,
    lifecycle,
    tags: ['issue-751'],
    file,
  })

  it('accepts the claimed lifecycle plus a superseded sibling', () => {
    expect(assessContracts([tagged('bind', 'verified'), tagged('old', 'superseded')], 751, 'VERIFIED')).toEqual({
      pass: true,
    })
  })

  it('refuses an active or blocked sibling, and a set that never claims the lifecycle', () => {
    expect(refusal(assessContracts([tagged('bind', 'verified'), tagged('sib', 'active')], 751, 'VERIFIED'))).toMatch(
      /sib is active/,
    )
    expect(refusal(assessContracts([tagged('sib', 'blocked')], 751, 'VERIFIED'))).toMatch(/blocked/)
    expect(refusal(assessContracts([tagged('old', 'superseded')], 751, 'VERIFIED'))).toMatch(/needs one/)
  })

  it('maps PARTIAL to partial and does not treat it as terminal closure', () => {
    expect(assessContracts([tagged('bind', 'partial')], 751, 'PARTIAL')).toEqual({ pass: true })
    expect(refusal(assessContracts([tagged('bind', 'verified')], 751, 'PARTIAL'))).toMatch(/needs partial/)
    expect(refusal(assessContracts([tagged('bind', 'partial')], 751, 'VERIFIED'))).toMatch(/needs verified/)
  })

  it('ignores a contract that is not tagged for this issue', () => {
    expect(
      assessContracts(
        [tagged('bind', 'verified'), { id: 'other', lifecycle: 'active', tags: ['issue-999'], file }],
        751,
        'VERIFIED',
      ),
    ).toEqual({ pass: true })
    expect(refusal(assessContracts([tagged('bind', 'verified')], 999, 'VERIFIED'))).toMatch(/issue-999/)
  })
})

describe('proofBody', () => {
  it('requires each ui-manual-only field in the selected body and ignores other gaps', () => {
    const recorded = proof({
      verify: 'PARTIAL',
      gaps: ['gate', 'prompt'],
      noTest: { gate: 'ui-manual-only', prompt: 'prompt-logic-only' },
      uiChecks: { gate: check },
    })
    expect(proofBody(recorded, `note\n${check.steps}\n${check.url}\n${check.observed}`)).toEqual({ pass: true })
    expect(refusal(proofBody(recorded, `${check.steps}\n${check.url}`))).toMatch(/observed/)
    expect(proofBody(proof(), '')).toEqual({ pass: true })
  })
})

describe('applicability', () => {
  function root() {
    return mkdtempSync(join(tmpdir(), 'proof-unit-'))
  }

  it('exempts a commit that has no Semctx in the tree and none on disk', async () => {
    const cwd = root()
    expect(await openApplicability(cwd, 'feat/751-proof', gitDouble(cwd, 'commit-empty'))).toEqual({
      applies: false,
      oid: HEAD,
    })
    expect(await landApplicability(cwd, HEAD, gitDouble(cwd, 'commit-empty'))).toEqual({ applies: false, oid: HEAD })
  })

  it('applies when the commit tree contains .semctx even if the worktree entry is ENOENT', async () => {
    const cwd = root()
    expect(await openApplicability(cwd, 'feat/751-proof', gitDouble(cwd, 'commit-semctx'))).toEqual({
      applies: true,
      oid: HEAD,
    })
    expect(await landApplicability(cwd, HEAD, gitDouble(cwd, 'commit-semctx'))).toEqual({ applies: true, oid: HEAD })
  })

  it('exempts only a true unborn branch whose show-ref exits 1 and whose disk has no .semctx', async () => {
    const cwd = root()
    expect(await openApplicability(cwd, 'feat/751-proof', gitDouble(cwd, 'unborn'))).toEqual({
      applies: false,
      oid: null,
    })
  })

  it('refuses a corrupt ref at exit 128, a missing object, a not-repo, and disk Semctx on an unborn branch', async () => {
    const cwd = root()
    const corrupt = await openApplicability(cwd, 'feat/751-proof', gitDouble(cwd, 'corrupt'))
    expect(corrupt).toMatchObject({ applies: true, pass: false })
    const missing = await landApplicability(cwd, HEAD, gitDouble(cwd, 'missing-object'))
    expect(missing).toMatchObject({ applies: true, pass: false })
    const absent = await openApplicability(cwd, 'feat/751-proof', gitDouble(cwd, 'no-repo'))
    expect(absent).toMatchObject({ applies: true, pass: false })
    if ('reason' in absent) expect(absent.reason).toMatch(/no-repo-root/)
    mkdirSync(join(cwd, '.semctx'))
    const disk = await openApplicability(cwd, 'feat/751-proof', gitDouble(cwd, 'unborn'))
    expect(disk).toMatchObject({ applies: true, pass: false })
    if ('reason' in disk) expect(disk.reason).toMatch(/\.semctx/)
  })

  it('refuses an approved oid that is not a commit rather than reading symbolic HEAD', async () => {
    const cwd = root()
    const bad = await landApplicability(cwd, 'HEAD', gitDouble(cwd, 'commit-empty'))
    expect(bad).toMatchObject({ applies: true, pass: false })
    if ('reason' in bad) expect(bad.reason).toMatch(/not a commit/)
  })
})
