import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UwActionRequest } from './uw-action-contract.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'
import { discoverRepositoryReferences } from './uw-repository-refs.ts'

const git = vi.hoisted(() => ({
  checkoutRepository: vi.fn(),
  changedPaths: vi.fn(),
  gitTreePaths: vi.fn(),
  readGitFileBytes: vi.fn(),
}))
vi.mock('./uw-git-bytes.ts', () => git)

const reference = 'a'.repeat(40)
const head = 'b'.repeat(40)
const request: UwActionRequest = {
  actionId: 'review-7',
  purpose: 'review',
  subject: { kind: 'standalone-pr', pullRequest: { repository: 'acme/app', target: 'acme/app#7' } },
  code: { repository: 'acme/app', base: 'c'.repeat(40), head, referenceCommit: reference },
  stageSources: [],
  expandedContext: [],
}
const gh = async () => ''
const bytes = (value: string) => Buffer.from(value)

beforeEach(() => {
  vi.resetAllMocks()
  git.checkoutRepository.mockResolvedValue('acme/app')
  git.changedPaths.mockResolvedValue({ ok: true, value: ['src/file.ts', 'src/deleted.ts'] })
})

describe('discoverRepositoryReferences tree discovery', () => {
  it('lists each distinct commit once, reads cited and changed blobs, and refreshes on the next invocation', async () => {
    git.gitTreePaths.mockImplementation(async (_cwd: string, commit: string) => ({
      ok: true,
      value: commit === reference ? ['AGENTS.md'] : ['src/file.ts'],
    }))
    git.readGitFileBytes.mockImplementation(async ({ commit, path }: { commit: string; path: string }) => {
      const content = commit === reference && path === 'AGENTS.md' ? 'Glossary: docs/domain.md' : path
      return { ok: true, value: bytes(content) }
    })
    const expected = [
      {
        source: 'git-file',
        repository: 'acme/app',
        commit: reference,
        path: 'AGENTS.md',
        digest: sha256Bytes(bytes('Glossary: docs/domain.md')),
      },
      {
        source: 'git-file',
        repository: 'acme/app',
        commit: reference,
        path: 'docs/domain.md',
        digest: sha256Bytes(bytes('docs/domain.md')),
      },
      {
        source: 'git-file',
        repository: 'acme/app',
        commit: head,
        path: 'src/file.ts',
        digest: sha256Bytes(bytes('src/file.ts')),
      },
    ]
    expect(await discoverRepositoryReferences({ request, cwd: '/repo', gh })).toEqual({ ok: true, value: expected })
    expect(git.gitTreePaths.mock.calls).toEqual([
      ['/repo', reference],
      ['/repo', head],
    ])
    expect(await discoverRepositoryReferences({ request, cwd: '/repo', gh })).toEqual({ ok: true, value: expected })
    expect(git.gitTreePaths.mock.calls).toEqual([
      ['/repo', reference],
      ['/repo', head],
      ['/repo', reference],
      ['/repo', head],
    ])
  })

  it('shares one tree for equal commits but still rereads changed pinned blobs', async () => {
    git.changedPaths.mockResolvedValue({ ok: true, value: ['AGENTS.md'] })
    git.gitTreePaths.mockResolvedValue({ ok: true, value: ['AGENTS.md'] })
    git.readGitFileBytes.mockResolvedValue({ ok: true, value: bytes('instructions') })
    const same = { ...request, code: { ...request.code, head: reference } }
    expect(await discoverRepositoryReferences({ request: same, cwd: '/repo', gh })).toMatchObject({ ok: true })
    expect(git.gitTreePaths).toHaveBeenCalledTimes(1)
    expect(git.readGitFileBytes).toHaveBeenCalledTimes(2)
  })

  it('uses blob fallback for an unreadable tree and fails on an unreadable required citation', async () => {
    git.gitTreePaths.mockResolvedValue(actionFailure('pinned-file-unreadable', 'tree unavailable'))
    git.readGitFileBytes.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'AGENTS.md') return { ok: true, value: bytes('Glossary: docs/domain.md') }
      return actionFailure('pinned-file-incomplete', 'missing blob')
    })
    const result = await discoverRepositoryReferences({ request, cwd: '/repo', gh })
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'action-input-missing' }] })
    expect(git.gitTreePaths.mock.calls).toEqual([['/repo', reference]])
    expect(git.readGitFileBytes.mock.calls.some(([input]) => input.path === 'docs/domain.md')).toBe(true)
  })
  it('falls back to individual blobs when trees are unavailable', async () => {
    git.gitTreePaths.mockResolvedValue(actionFailure('pinned-file-unreadable', 'tree unavailable'))
    git.readGitFileBytes.mockImplementation(async ({ commit, path }: { commit: string; path: string }) => {
      if (commit === reference && path === 'AGENTS.md') return { ok: true, value: bytes('instructions') }
      if (commit === head && path === 'src/file.ts') return { ok: true, value: bytes('changed') }
      return actionFailure('pinned-file-incomplete', 'missing blob')
    })
    const result = await discoverRepositoryReferences({ request, cwd: '/repo', gh })
    expect(result).toEqual({
      ok: true,
      value: [
        {
          source: 'git-file',
          repository: 'acme/app',
          commit: reference,
          path: 'AGENTS.md',
          digest: sha256Bytes(bytes('instructions')),
        },
        {
          source: 'git-file',
          repository: 'acme/app',
          commit: head,
          path: 'src/file.ts',
          digest: sha256Bytes(bytes('changed')),
        },
      ],
    })
    expect(git.gitTreePaths.mock.calls).toEqual([
      ['/repo', reference],
      ['/repo', head],
    ])
  })
})
