/**
 * Pre-review proof readiness. An open pull request is not applicability, a Git
 * failure is not an applicable no-op, and a missing producer record is not admission.
 */
import { describe, expect, it } from 'vitest'
import { decodeHistory, githubScope, type History } from '../../dist/contracts.js'
import { CONFIG, type Gh, type Git, type GitResult } from './proof-base'
import { readProofReadiness } from './proof-readiness'

const REPOSITORY = 'acme/app'
const CANDIDATE = '1111111111111111111111111111111111111111'
const BASE_TIP = '3333333333333333333333333333333333333333'
const OID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const gitFailure: Git = async () => ({ code: 1, stdout: '', stderr: 'no repository' })
const gh: Gh = async () => {
  throw new Error('readiness must not ask GitHub when no producer can apply')
}

function emptyHistory(): History {
  return {
    scope: githubScope(REPOSITORY, 4),
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  }
}

/** Minimal committed Semctx config: a JSON object is enough for candidateFacts. */
const CONFIG_TEXT = '{"include":[]}\n'

const gitSuccess = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' })

function scriptedResponse(configured: boolean, args: string[]): GitResult | null {
  switch (args[0]) {
    case 'rev-parse':
      if (args[1] === '--show-toplevel') return gitSuccess('/repo\n')
      return args[1] === '--verify' && args[2] === 'HEAD^{commit}' ? gitSuccess(`${CANDIDATE}\n`) : null
    case 'ls-tree':
      return gitSuccess(configured && args.includes(`${CANDIDATE}^{commit}`) ? `100644 blob ${OID}\t${CONFIG}\0` : '')
    case 'cat-file':
      return args[1] === 'blob' && args[2] === OID ? gitSuccess(CONFIG_TEXT) : null
    case 'worktree':
      return gitSuccess('')
    default:
      return null
  }
}

function scriptedGit(configured: boolean): Git {
  return async (_cwd, args) =>
    scriptedResponse(configured, args) ?? { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
}

describe('readProofReadiness', () => {
  it('does not treat a missing pull request as an applicable no-op', async () => {
    const result = await readProofReadiness({
      cwd: '/repo',
      repository: REPOSITORY,
      pr: null,
      candidate: null,
      base: null,
      baseTip: null,
      history: null,
      git: gitFailure,
      gh,
    })
    expect(result).toEqual({
      status: 'ready',
      selector: {
        admission: null,
        candidateGitSHA: null,
        input: null,
        applicability: 'required',
        evidence: [],
      },
    })
  })

  it('refuses a pull request whose established base tip is missing', async () => {
    const result = await readProofReadiness({
      cwd: '/repo',
      repository: REPOSITORY,
      pr: 4,
      candidate: CANDIDATE,
      base: 'main',
      baseTip: null,
      history: decodeHistory(emptyHistory()),
      git: gitFailure,
      gh,
    })
    expect(result.status).toBe('unusable')
    if (result.status !== 'unusable') return
    expect(result.reason).toContain('refreshSelectedBase')
    expect(result.evidence[0]?.code).toBe('proof-unusable')
  })

  it('does not report an unreadable checkout as not-applicable', async () => {
    const result = await readProofReadiness({
      cwd: '/repo',
      repository: REPOSITORY,
      pr: 4,
      candidate: CANDIDATE,
      base: 'main',
      baseTip: BASE_TIP,
      history: decodeHistory(emptyHistory()),
      git: gitFailure,
      gh,
    })
    expect(result.status).toBe('unusable')
    expect(result).not.toMatchObject({ selector: { applicability: 'not-applicable' } })
    expect(result).not.toMatchObject({ selector: { admission: { ok: true } } })
  })

  it('reports an explicit no-op only when neither producer applies', async () => {
    const result = await readProofReadiness({
      cwd: '/repo',
      repository: REPOSITORY,
      pr: 4,
      candidate: CANDIDATE,
      base: 'main',
      baseTip: BASE_TIP,
      history: null,
      git: scriptedGit(false),
      gh,
    })
    expect(result).toEqual({
      status: 'ready',
      selector: {
        admission: null,
        candidateGitSHA: CANDIDATE,
        input: null,
        applicability: 'not-applicable',
        evidence: [],
      },
    })
  })

  it('keeps a configured producer required and unadmitted when no native record binds', async () => {
    const result = await readProofReadiness({
      cwd: '/repo',
      repository: REPOSITORY,
      pr: 4,
      candidate: CANDIDATE,
      base: 'main',
      baseTip: BASE_TIP,
      history: decodeHistory(emptyHistory()),
      git: scriptedGit(true),
      gh,
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.selector.applicability).toBe('required')
    expect(result.selector.admission).toBeNull()
    expect(result.selector.input).toBeNull()
    expect(result.selector.candidateGitSHA).toBe(CANDIDATE)
    expect(result.selector.evidence.map((item) => item.code)).toContain('proof-unbound')
  })
})
