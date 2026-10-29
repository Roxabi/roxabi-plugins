import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Gh } from '../adapters/github/types.ts'
import { sha256Bytes } from './uw-action-result.ts'
import { createProductionInputPorts } from './uw-input-readers.ts'

function blobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

test('pinned catalogue preserves ordered bytes and refuses incomplete or mismatched blobs', async () => {
  const values = [Buffer.from('first\0binary'), Buffer.from('second')]
  const oids = values.map(blobSha)
  let missing = false
  let corrupt = false
  let graphError = false
  let calls = 0
  const gh: Gh = async (_cwd, args) => {
    calls++
    if (args.includes('graphql')) {
      return JSON.stringify({
        data: {
          repository: {
            f0: { oid: oids[0], byteSize: values[0].length, isBinary: true, isTruncated: false, text: null },
            f1: missing
              ? null
              : { oid: oids[1], byteSize: values[1].length, isBinary: null, isTruncated: false, text: null },
          },
        },
        ...(graphError ? { errors: [{ message: 'partial response' }] } : {}),
      })
    }
    if (args.some((arg) => arg.includes('/git/commits/'))) return JSON.stringify({ sha: 'a'.repeat(40) })
    const index = oids.findIndex((oid) => args.some((arg) => arg.endsWith(`/${oid}`)))
    const bytes = corrupt && index === 1 ? Buffer.from('wrong!') : values[index]
    return JSON.stringify({
      encoding: 'base64',
      content: bytes.toString('base64'),
      size: bytes.length,
      sha: oids[index],
    })
  }
  const ports = createProductionInputPorts({ cwd: '/nonexistent', gh })
  const refs = values.map((value, index) => ({
    source: 'git-file' as const,
    repository: 'owner/repo',
    commit: 'a'.repeat(40),
    path: `file${index}`,
    digest: sha256Bytes(value),
  }))
  const read = ports.readPinnedFiles
  if (read === undefined) throw new Error('Production pinned catalogue reader is unavailable')
  expect(await read([])).toEqual({ ok: true, value: [] })
  expect(calls).toBe(0)
  const result = await read(refs)
  expect(result.ok && result.value.map((value) => Buffer.from(value))).toEqual(values)
  missing = true
  expect((await read(refs)).ok).toBe(false)
  missing = false
  graphError = true
  expect((await read(refs)).ok).toBe(false)
  graphError = false
  corrupt = true
  expect((await read(refs)).ok).toBe(false)
  corrupt = false
  expect((await read([{ ...refs[0], digest: sha256Bytes(Buffer.from('other')) }, refs[1]])).ok).toBe(false)
  expect((await read([refs[0], { ...refs[1], commit: 'b'.repeat(40) }])).ok).toBe(false)
})

function catalogueGraphql(mode: string, values: Buffer[], oids: string[]): string {
  if (mode === 'private') return JSON.stringify({ data: { repository: null }, errors: [{ message: 'forbidden' }] })
  const first: Record<string, unknown> = {
    oid: oids[0],
    byteSize: values[0].length,
    isBinary: false,
    isTruncated: false,
    text: mode === 'wrong-text' ? '\ufeffx\r\n' : values[0].toString('utf8'),
  }
  if (mode === 'wrong-oid') first.oid = 'b'.repeat(40)
  if (mode === 'wrong-size') first.byteSize = 0
  if (mode === 'malformed') delete first.isTruncated
  return JSON.stringify({
    data: {
      repository: {
        f0: first,
        f1: { oid: oids[1], byteSize: 0, isBinary: false, isTruncated: false, text: '' },
        f2: { oid: oids[2], byteSize: values[2].length, isBinary: true, isTruncated: false, text: null },
        f3: { oid: oids[3], byteSize: values[3].length, isBinary: null, isTruncated: false, text: null },
        f4: { oid: oids[4], byteSize: values[4].length, isBinary: false, isTruncated: true, text: 'trunc' },
      },
    },
  })
}

function catalogueCommit(mode: string, pin: string): string {
  if (mode === 'denied') throw new Error('403 denied')
  return JSON.stringify(mode === 'missing-commit' ? {} : { sha: mode === 'wrong-commit' ? 'b'.repeat(40) : pin })
}

function catalogueRaw(mode: string, args: string[], values: Buffer[], oids: string[]): string {
  const index = oids.findIndex((oid) => args.some((arg) => arg.endsWith(`/${oid}`)))
  if (index < 0 || mode === 'raw-denied') throw new Error('raw unavailable')
  const bytes = values[index]
  return JSON.stringify({ sha: oids[index], size: bytes.length, encoding: 'base64', content: bytes.toString('base64') })
}

test('pinned catalogue releases only verified bytes after a fresh commit permission barrier', async () => {
  const values = [
    Buffer.from('\ufeffé\r\n'),
    Buffer.alloc(0),
    Buffer.from([0xff, 0, 0x61]),
    Buffer.from('unknown'),
    Buffer.from('truncated'),
  ]
  const oids = values.map(blobSha)
  const pin = 'a'.repeat(40)
  let mode = 'valid'
  const gh: Gh = async (_cwd, args) => {
    if (args.includes('graphql')) return catalogueGraphql(mode, values, oids)
    if (args.some((arg) => arg.includes('/git/commits/'))) return catalogueCommit(mode, pin)
    return catalogueRaw(mode, args, values, oids)
  }
  const read = createProductionInputPorts({ cwd: '/nonexistent', gh }).readPinnedFiles
  if (read === undefined) throw new Error('Production pinned catalogue reader is unavailable')
  const refs = values.map((bytes, index) => ({
    source: 'git-file' as const,
    repository: 'owner/repo',
    commit: pin,
    path: `file${index}`,
    digest: sha256Bytes(bytes),
  }))
  const valid = await read(refs)
  expect(valid.ok && valid.value.map((bytes) => Buffer.from(bytes))).toEqual(values)
  for (const refusal of [
    'denied',
    'wrong-commit',
    'missing-commit',
    'wrong-text',
    'wrong-oid',
    'wrong-size',
    'malformed',
    'private',
    'raw-denied',
  ]) {
    mode = refusal
    expect((await read(refs)).ok).toBe(false)
  }
  mode = 'valid'
  expect((await read([{ ...refs[0], digest: sha256Bytes(Buffer.from('different')) }, ...refs.slice(1)])).ok).toBe(false)
})

test('pinned diff ignores an ambient external diff and retains the real change', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pinned-diff-'))
  const previous = process.env.GIT_EXTERNAL_DIFF
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('remote', 'add', 'origin', 'https://github.com/owner/repo.git')
    writeFileSync(join(cwd, 'file.txt'), 'before\n')
    git('add', 'file.txt')
    git('commit', '-qm', 'before')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'file.txt'), 'after\n')
    git('commit', '-qam', 'after')
    const head = git('rev-parse', 'HEAD')
    const helper = join(cwd, 'external-diff')
    writeFileSync(helper, '#!/bin/sh\nprintf "FAKE DIFF\\n"\n', { mode: 0o755 })
    process.env.GIT_EXTERNAL_DIFF = helper
    const ports = createProductionInputPorts({ cwd, gh: async () => '' })
    const result = await ports.readCodeDiff({ repository: 'owner/repo', base, head })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = Buffer.from(result.value).toString('utf8')
    expect(diff).toContain('-before')
    expect(diff).toContain('+after')
    expect(diff).not.toContain('FAKE DIFF')
  } finally {
    if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF
    else process.env.GIT_EXTERNAL_DIFF = previous
    rmSync(cwd, { recursive: true, force: true })
  }
})
