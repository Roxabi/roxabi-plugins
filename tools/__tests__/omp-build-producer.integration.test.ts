import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../..')
const bun = process.platform === 'win32' ? 'bun.exe' : 'bun'
const outputRoots = ['agents', 'dist']
const retired = 'agents/R-retired-profile.md'
const oldDist = 'dist/.retired/nested/stale.js'

type TreeSnapshot = Map<string, { kind: 'directory' | 'link' | 'file'; value?: string }>

function put(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

// Physical walk: retain directories and links as well as file bytes so changes
// that don't alter the producer's reported inventory are still observable.
function snapshot(root: string, skip = new Set<string>()): TreeSnapshot {
  const entries: TreeSnapshot = new Map()
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const key = relative(root, path)
      if (skip.has(key)) continue
      const entry = lstatSync(path)
      if (entry.isDirectory()) {
        entries.set(key, { kind: 'directory' })
        walk(path)
      } else if (entry.isSymbolicLink()) entries.set(key, { kind: 'link', value: readlinkSync(path) })
      else entries.set(key, { kind: 'file', value: readFileSync(path).toString('base64') })
    }
  }
  walk(root)
  return entries
}

const managed = (root: string) =>
  new Map([...snapshot(root)].filter(([path]) => outputRoots.includes(path.split('/')[0])))

function capture(args: string[], cwd: string) {
  const result = spawnSync(bun, args, { cwd, encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  return result
}

function assertFailure(result: SpawnSyncReturns<string>, diagnostic: string) {
  expect(result.status, result.stderr).not.toBe(0)
  expect(result.stderr).toContain(diagnostic)
  expect(result.stdout.trim()).toBe('')
}

function assertReport(result: SpawnSyncReturns<string>, expected: TreeSnapshot) {
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout)
  const paths = [...expected]
    .filter(([, entry]) => entry.kind === 'file')
    .map(([path]) => path)
    .sort()
  expect(report.outputs).toEqual(paths)
  expect(new Set(report.inputs).size).toBe(report.inputs.length)
}

describe('omp-build producer', () => {
  let root: string
  let plugin: string
  let sentinels: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-build-producer-')))
    plugin = join(root, 'plugins/omp-build')
    sentinels = join(root, 'sentinels')
    expect(capture(['--version'], root).stdout.trim()).toBe(readFileSync(join(repo, '.bun-version'), 'utf8').trim())
    for (const path of [
      '.bun-version',
      'package.json',
      'plugins/omp-build',
      'plugins/issue-triage',
      'tools/build-omp-build-contracts.ts',
      'tools/omp-build-output-tree.ts',
      'tools/__tests__/omp-build-producer-prune-fault.ts',
    ]) {
      cpSync(join(repo, path), join(root, path), { recursive: true })
    }
    symlinkSync(realpathSync(join(repo, 'node_modules')), join(root, 'node_modules'), 'dir')
    put(join(sentinels, 'keep'), 'protected bytes')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function build(...args: string[]) {
    return capture(['run', 'build', ...args], root)
  }

  function seedOld(): string[] {
    const old = [retired, oldDist, 'agents/.old/deep/file.md', 'dist/issue-triage/.orphan']
    for (const path of old) put(join(plugin, path), `obsolete ${path}`)
    return old
  }

  it('prunes both physical trees to the exact fresh-build inventory and bytes, then stays identical', () => {
    seedOld()
    symlinkSync(sentinels, join(plugin, 'agents/.old-link'), 'dir')
    symlinkSync(join(sentinels, 'keep'), join(plugin, 'dist/.old-link'))
    const outside = snapshot(root, new Set(['fresh', 'plugins/omp-build/agents', 'plugins/omp-build/dist']))
    const initial = managed(plugin)
    const fresh = join(root, 'fresh')
    const freshRun = build('--output-root', fresh)
    const reference = managed(fresh)
    assertReport(freshRun, reference)
    expect(managed(plugin)).toEqual(initial)
    expect(snapshot(root, new Set(['fresh', 'plugins/omp-build/agents', 'plugins/omp-build/dist']))).toEqual(outside)
    const rootInodes = outputRoots.map((name) => lstatSync(join(plugin, name)).ino)
    for (let run = 0; run < 2; run++) {
      assertReport(build(), reference)
      expect(managed(plugin)).toEqual(reference)
      expect(outputRoots.map((name) => lstatSync(join(plugin, name)).ino)).toEqual(rootInodes)
      expect(snapshot(root, new Set(['fresh', 'plugins/omp-build/agents', 'plugins/omp-build/dist']))).toEqual(outside)
      expect(managed(fresh)).toEqual(reference)
    }
  })

  it.each(['agents', 'dist/issue-triage', 'dist/contracts.js'])('rejects a live output link at %s', (name) => {
    const path = join(plugin, name)
    rmSync(path, { recursive: true })
    const target = name.endsWith('.js') ? join(sentinels, 'keep') : sentinels
    symlinkSync(target, path)
    const stale = name === 'agents' ? oldDist : retired
    put(join(plugin, stale), 'must survive')
    const outside = snapshot(root, new Set(['plugins/omp-build/agents', 'plugins/omp-build/dist']))
    assertFailure(build(), path)
    expect(readlinkSync(path)).toBe(target)
    expect(readFileSync(join(plugin, stale), 'utf8')).toBe('must survive')
    expect(snapshot(root, new Set(['plugins/omp-build/agents', 'plugins/omp-build/dist']))).toEqual(outside)
  })

  it('rejects a live declaration linked to a protected inode', () => {
    const old = seedOld()
    const target = join(sentinels, 'keep')
    const path = join(plugin, 'dist/contracts.d.ts')
    rmSync(path)
    linkSync(target, path)
    const identity = (file: string) => {
      const { dev, ino, nlink } = lstatSync(file)
      return { dev, ino, nlink }
    }
    const initial = identity(target)
    expect(identity(path)).toEqual(initial)
    expect(initial.nlink).toBe(2)
    assertFailure(build(), path)
    for (const file of [target, path]) {
      expect(identity(file)).toEqual(initial)
      expect(readFileSync(file, 'utf8')).toBe('protected bytes')
    }
    for (const file of old) expect(readFileSync(join(plugin, file), 'utf8')).toBe(`obsolete ${file}`)
  })

  it('rejects every existing destination and fresh protected descendants, including aliases', () => {
    seedOld()
    put(join(root, 'file'), 'file destination')
    put(join(root, 'nonempty/keep'), 'directory destination')
    mkdirSync(join(root, 'empty'))
    symlinkSync(sentinels, join(root, 'linked'), 'dir')
    symlinkSync(join(root, 'missing'), join(root, 'dangling'))
    symlinkSync(join(plugin, 'agent-sources'), join(root, 'source-alias'), 'dir')
    const before = snapshot(root)
    for (const path of [
      join(root, 'file'),
      join(root, 'empty'),
      join(root, 'nonempty'),
      join(root, 'linked'),
      join(root, 'dangling'),
      plugin,
    ]) {
      assertFailure(build('--output-root', path), `temporary output root already exists: ${path}`)
    }
    for (const path of [join(plugin, 'dist/not-created/output'), join(root, 'source-alias/not-created/output')]) {
      assertFailure(build('--output-root', path), `temporary output root overlaps protected paths: ${path}`)
    }
    expect(snapshot(root)).toEqual(before)
  })

  it('does not prune on a late bundle failure and does not roll back earlier writes', () => {
    const old = seedOld()
    const name = readdirSync(join(plugin, 'agent-sources'))
      .sort()
      .find((file) => file.endsWith('.md'))
    if (!name) throw new Error('missing authored agent in producer fixture')
    const rewritten = join(plugin, 'agents', name)
    put(rewritten, 'old authored agent bytes')
    put(join(plugin, 'contracts.ts'), 'export {')
    const outside = snapshot(root, new Set(['plugins/omp-build/agents', 'plugins/omp-build/dist']))
    assertFailure(build(), 'omp-build contracts bundle failed')
    for (const file of old) expect(readFileSync(join(plugin, file), 'utf8')).toBe(`obsolete ${file}`)
    expect(readFileSync(rewritten)).toEqual(readFileSync(join(plugin, 'agent-sources', name)))
    expect(snapshot(root, new Set(['plugins/omp-build/agents', 'plugins/omp-build/dist']))).toEqual(outside)
  })

  it('stops on a prune error without rolling back earlier deletions', () => {
    seedOld()
    const [first, failed, later] = ['.01-prune-first', '.02-prune-fail', '.03-prune-later'].map((name) =>
      join(plugin, 'agents', name),
    )
    for (const path of [first, failed, later]) put(path, path)
    const outside = snapshot(root, new Set(['plugins/omp-build/agents', 'plugins/omp-build/dist']))
    assertFailure(
      capture(['tools/__tests__/omp-build-producer-prune-fault.ts'], root),
      `omp-build prune unlink failed: ${failed}`,
    )
    expect(existsSync(first)).toBe(false)
    expect(readFileSync(failed, 'utf8')).toBe(failed)
    expect(readFileSync(later, 'utf8')).toBe(later)
    expect(snapshot(root, new Set(['plugins/omp-build/agents', 'plugins/omp-build/dist']))).toEqual(outside)
  })
})
