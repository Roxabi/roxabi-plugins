import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The unit tests stub `Bun.spawnSync` and call `main()`. These run the script as the
 * workflow does, against a real `bun audit`, and assert the process status — the only
 * thing the workflow routes on.
 */
const SCRIPT = resolve(__dirname, '..', 'dependency-audit.ts')

let dir: string
let server: Server | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dependency-audit-int-'))
})

afterEach(async () => {
  if (server) {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    await promise
  }
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

// Async on purpose: the fake registry answers from this process, which a sync spawn would block.
function runScript(): Promise<number | null> {
  const { promise, resolve, reject } = Promise.withResolvers<number | null>()
  const child = spawn('bun', [SCRIPT, '--report', join(dir, 'report.md')], {
    cwd: dir,
    // HOME and XDG_CONFIG_HOME point into the temp dir so no user bunfig can add a registry.
    env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, NO_COLOR: '1' },
    stdio: 'ignore',
  })
  child.on('error', reject)
  child.on('close', resolve)
  return promise
}

describe('dependency-audit.ts as a process', () => {
  it('exits 2 and writes no report when there is no bun.lock to audit', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true }))
    expect(await runScript()).toBe(2)
    expect(existsSync(join(dir, 'report.md'))).toBe(false)
  })

  it('exits 10 and lists every package when their registry does not answer the audit request', async () => {
    // bun exits 0 with `{}` here; only its stderr warning says nothing was audited.
    const fake = createServer((_, res) => res.writeHead(404).end())
    server = fake
    const listening = Promise.withResolvers<void>()
    fake.listen(0, '127.0.0.1', () => listening.resolve())
    await listening.promise
    const registry = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/`
    const names = ['@foo/bar', '@foo/baz', '@foo/qux']
    const deps = Object.fromEntries(names.map((n) => [n, '1.0.0']))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, dependencies: deps }))
    writeFileSync(join(dir, 'bunfig.toml'), `[install.scopes]\nfoo = "${registry}"\n`)
    const packages = Object.fromEntries(
      names.map((n) => [n, [`${n}@1.0.0`, `${registry}${n}/-/${n.split('/')[1]}-1.0.0.tgz`, {}, 'sha512-AAAA']]),
    )
    writeFileSync(
      join(dir, 'bun.lock'),
      JSON.stringify({ lockfileVersion: 1, workspaces: { '': { name: 'x', dependencies: deps } }, packages }),
    )
    expect(await runScript()).toBe(10)
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('\n- ` @foo/bar `\n- ` @foo/baz `\n- ` @foo/qux `\n')
  })
})
