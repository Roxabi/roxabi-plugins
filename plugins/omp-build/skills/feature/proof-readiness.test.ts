/**
 * Pre-review proof readiness. An open pull request is not applicability, a Git
 * failure is not an applicable no-op, and a missing producer record is not admission.
 */
import { describe, expect, it } from 'vitest'
import { decodeHistory, githubScope, type History } from '../../dist/contracts.js'
import { CONFIG, type Gh, type Git, readProofReadiness } from './proof'

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

function scriptedGit(configured: boolean): Git {
  return async (_cwd, args) => {
    const command = args[0]
    if (command === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: '/repo\n', stderr: '' }
    if (command === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD^{commit}') {
      return { code: 0, stdout: `${CANDIDATE}\n`, stderr: '' }
    }
    if (command === 'ls-tree') {
      const atCandidate = args.includes(`${CANDIDATE}^{commit}`)
      const body = configured && atCandidate ? `100644 blob ${OID}\t${CONFIG}\0` : ''
      return { code: 0, stdout: body, stderr: '' }
    }
    // candidateFacts must hash the committed config before readiness can report required+unbound.
    if (command === 'cat-file' && args[1] === 'blob' && args[2] === OID) {
      return { code: 0, stdout: CONFIG_TEXT, stderr: '' }
    }
    if (command === 'worktree') return { code: 0, stdout: '', stderr: '' }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  }
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
