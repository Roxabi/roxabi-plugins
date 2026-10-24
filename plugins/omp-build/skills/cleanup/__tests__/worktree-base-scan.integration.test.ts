import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_ENV, git, initRepo, SCAN, scanRaw, scanStatus } from './fixture'

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function fixture(tag: string): { root: string; repo: string; home: string } {
  root = mkdtempSync(path.join(tmpdir(), `omp-build-wt-scan-${tag}-`))
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'home')
  mkdirSync(home)
  initRepo(repo, home)
  return { root, repo, home }
}

function writeStack(repo: string, stack: string): void {
  const dev = path.join(repo, '.dev')
  mkdirSync(dev, { recursive: true })
  writeFileSync(path.join(dev, 'stack.yml'), stack)
}

function shell(base: string, repoName: string, name: string): string {
  const dir = path.join(base, repoName, name)
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  return dir
}

describe('OMP worktree base orphan scan', () => {
  it('reports a shell under this repo and never another repository', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-build-wt-scan-'))
    const repo = path.join(root, 'repo')
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt-base')
    mkdirSync(home)
    initRepo(repo, home)
    const ours = path.join(base, 'repo', 'feat-orphan')
    const theirs = path.join(base, 'other-repo', 'secret')
    mkdirSync(path.join(ours, 'node_modules'), { recursive: true })
    mkdirSync(path.join(theirs, 'node_modules'), { recursive: true })
    const out = scanRaw(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(out).toContain(ours)
    expect(out).not.toContain('other-repo')
    expect(out).not.toContain(theirs)
  })
  it.each([
    [
      'plain scalar',
      (base: string) => `worktree:\n  base: ${base}\n`,
      (root: string, _home: string) => path.join(root, 'plain-base'),
    ],
    [
      'quoted scalar',
      (base: string) => `worktree:\n  base: "${base}"\n`,
      (root: string, _home: string) => path.join(root, 'quoted-base'),
    ],
    [
      'literal block scalar',
      (base: string) => `worktree:\n  base: |-\n    ${base}\n`,
      (root: string, _home: string) => path.join(root, 'literal-base'),
    ],
    [
      'folded block scalar',
      (base: string) => `worktree:\n  base: >-\n    ${base}\n`,
      (root: string, _home: string) => path.join(root, 'folded-base'),
    ],
    [
      'tilde scalar',
      (_base: string) => 'worktree:\n  base: ~/tilde-base\n',
      (_root: string, home: string) => path.join(home, 'tilde-base'),
    ],
  ])('uses a %s worktree.base', (_name, stackFor, baseFor) => {
    const { root: temp, repo, home } = fixture('scalar')
    const base = baseFor(temp, home)
    writeStack(repo, stackFor(base))
    const orphan = shell(base, 'repo', 'configured-orphan')

    expect(scanRaw(repo, { HOME: home })).toContain(orphan)
  })

  it.each([
    ['absent', 'worktree: {}\n'],
    ['null worktree', 'worktree: null\n'],
    ['null', 'worktree:\n  base: null\n'],
    ['empty', 'worktree:\n  base: ""\n'],
  ])('uses the default base when worktree.base is %s', (_name, stack) => {
    const { repo, home } = fixture('default')
    writeStack(repo, stack)
    const orphan = shell(path.join(home, '.omp', 'wt'), 'repo', 'default-orphan')

    expect(scanRaw(repo, { HOME: home })).toContain(orphan)
  })

  it('resolves a principal relative stack base rather than a differing worktree value', () => {
    const { root: temp, repo, home } = fixture('principal')
    const principalBase = path.join(temp, 'principal-base')
    const worktreeBase = path.join(temp, 'worktree-base')
    writeStack(repo, 'worktree:\n  base: ../principal-base\n')
    const worktree = path.join(temp, 'checked-out')
    git(repo, home, 'worktree', 'add', '-q', worktree, '-b', 'reader-principal-stack')
    writeStack(worktree, `worktree:\n  base: ${worktreeBase}\n`)
    const principalOrphan = shell(principalBase, 'repo', 'principal-orphan')
    const worktreeOrphan = shell(worktreeBase, 'repo', 'worktree-orphan')

    const out = scanRaw(worktree, { HOME: home })
    expect(out).toContain(principalOrphan)
    expect(out).not.toContain(worktreeOrphan)
  })

  it('uses a nonempty environment override without reading a malformed principal stack', () => {
    const { root: temp, repo, home } = fixture('override')
    const base = path.join(temp, 'override-base')
    writeStack(repo, 'worktree: [\n')
    const orphan = shell(base, 'repo', 'override-orphan')

    const result = scanStatus(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(orphan)
  })

  it.each([
    ['malformed YAML', 'worktree: [\n'],
    ['non-map document', '- worktree\n'],
    ['non-map worktree', 'worktree: []\n'],
    ['non-string base', 'worktree:\n  base: [not-a-path]\n'],
  ])('fails closed for %s', (_name, stack) => {
    const { repo, home } = fixture('invalid')
    const stackPath = path.join(repo, '.dev', 'stack.yml')
    writeStack(repo, stack)

    const result = scanStatus(repo, { HOME: home })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(stackPath)
  })

  it('ignores unrelated stack values while selecting worktree.base', () => {
    const { root: temp, repo, home } = fixture('unrelated')
    const base = path.join(temp, 'configured-base')
    writeStack(repo, `commands: not-a-map\nworktree:\n  base: ${base}\n`)
    const orphan = shell(base, 'repo', 'configured-orphan')

    expect(scanRaw(repo, { HOME: home })).toContain(orphan)
  })

  it('preserves a trailing newline in the configured base and keeps its unsafe rows non-selectable', () => {
    const { root: temp, repo, home } = fixture('newline')
    const base = path.join(temp, 'configured-base')
    writeStack(repo, `worktree:\n  base: |\n    ${base}\n`)
    const intended = shell(`${base}\n`, 'repo', 'chosen-shell')
    shell(base, 'repo', 'trimmed-neighbor')

    const out = scanRaw(repo, { HOME: home })
    const rows = out.trimEnd().split('\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('chosen-shell')
    expect(rows[0]).toContain('|unsafe_name|')
    expect(out).not.toContain(intended)
    expect(out).not.toContain('trimmed-neighbor')
    expect(scanRaw(repo, { HOME: home }, ['--yes-targets'])).toBe('')
  })

  it('fails closed when worktree.base contains a NUL byte', () => {
    const { repo, home } = fixture('nul')
    const stackPath = path.join(repo, '.dev', 'stack.yml')
    writeStack(repo, 'worktree:\n  base: "unsafe\\0base"\n')

    const result = scanStatus(repo, { HOME: home })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(stackPath)
  })

  it('fails before checkout Bun startup when the scanner directory disappears', () => {
    const { repo, home } = fixture('startup-directory')
    const forged = path.join(home, 'forged-base')
    shell(forged, 'repo', 'forged-shell')
    writeStack(repo, 'worktree:\n  base: ~/configured-base\n')
    const install = path.join(root as string, 'scanner-install')
    mkdirSync(install)
    const sourceRef = `${'$'}{BASH_SOURCE[0]}`
    const trustedEntry = `cd -- "$(dirname -- "${sourceRef}")"`
    writeFileSync(
      path.join(install, 'scan-orphan-worktree-shells.sh'),
      readFileSync(SCAN, 'utf8').replace(trustedEntry, `rmdir -- "$(dirname -- "${sourceRef}")" && ${trustedEntry}`),
    )
    chmodSync(path.join(install, 'scan-orphan-worktree-shells.sh'), 0o755)
    writeFileSync(path.join(repo, 'bunfig.toml'), 'preload = ["./preload.js"]\n')
    writeFileSync(
      path.join(repo, 'preload.js'),
      [
        'require("node:fs").appendFileSync(process.env.PRELOAD_MARKER, "ran\\n"); process.stdout.write("base\\0" + process.env.HOME + "/forged-base\\0"); process.exit(0)\n',
      ].join(''),
    )
    const marker = path.join(home, 'preload-ran')

    const result = spawnSync('bash', [path.join(install, 'scan-orphan-worktree-shells.sh')], {
      cwd: repo,
      env: { ...FIXTURE_ENV, HOME: home, PATH: process.env.PATH, PRELOAD_MARKER: marker },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(install)
    expect(result.stdout).not.toContain('forged-shell')
    expect(existsSync(marker)).toBe(false)
  })
})
