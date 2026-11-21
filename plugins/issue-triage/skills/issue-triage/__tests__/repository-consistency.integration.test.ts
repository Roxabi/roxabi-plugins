import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkout, type GitHubFake, recipeEnv, run, startGitHub, trustedTriage, writeGh } from './fixtures/github-api'

let root: string | undefined
let fake: GitHubFake | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function world() {
  root = mkdtempSync(path.join(tmpdir(), 'triage-repo-consistency-'))
  fake = await startGitHub(root, ['Upstream/app#70', 'Upstream/app#80', 'Fork/app#70', 'Fork/app#80'])
  const checkoutDir = checkout(path.join(root, 'checkout'), 'Fork/app')
  const { script } = trustedTriage(path.join(root, 'trusted'))
  const bin = path.join(root, 'bin')
  writeGh(bin)
  const log = path.join(root, 'gh.log')
  const count = path.join(root, 'discovery')
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 \${2:-}" in
  'repo view')
    if [ ! -e "$DISCOVERY" ]; then touch "$DISCOVERY"; echo Upstream/app; exit 0; fi
    exit 1 ;;
  'label list'|'issue edit') exit 0 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  const env = recipeEnv(fake, bin, { GH_LOG: log, DISCOVERY: count })
  return { fake, checkoutDir, script, env, log }
}

describe('one repository per triage invocation', () => {
  it('create keeps the detected repository for type, creation, labels and a bare parent', async () => {
    const w = await world()
    const result = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} create --title test --type fix --size S --parent 70`,
      w.checkoutDir,
      w.env,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(w.fake.created).toHaveLength(1)
    expect(w.fake.created[0]).toMatchObject({ repo: 'Upstream/app', type: 'fix', parent: 70 })
    expect(w.fake.calls.filter((call) => call.op === 'read').map((call) => call.path)).toEqual([
      '/repos/Upstream/app/issues/101',
      '/repos/Upstream/app/issues/70',
    ])
    const calls = readFileSync(w.log, 'utf8').trim().split('\n')
    expect(calls.filter((line) => line.startsWith('repo view'))).toHaveLength(1)
    expect(calls.filter((line) => line.startsWith('issue edit'))).toEqual([
      expect.stringContaining('--repo Upstream/app'),
    ])
  })

  it('set keeps the detected repository for type, relation, labels and body', async () => {
    const w = await world()
    const result = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} set 80 --type fix --size S --parent 70 --body changed`,
      w.checkoutDir,
      w.env,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(w.fake.issues.get('Upstream/app#80')).toMatchObject({ type: 'fix', parent: 70, body: 'changed' })
    expect(w.fake.issues.get('Fork/app#80')).toMatchObject({ body: '', blockedBy: [] })
    const calls = readFileSync(w.log, 'utf8').trim().split('\n')
    expect(calls.filter((line) => line.startsWith('repo view'))).toHaveLength(1)
    expect(calls.filter((line) => line.startsWith('issue edit'))).toEqual([
      expect.stringContaining('--repo Upstream/app'),
    ])
  })

  it('uses an explicitly qualified subject without ambient repository discovery', async () => {
    const w = await world()
    const result = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} set Fork/app#80 --body explicit`,
      w.checkoutDir,
      w.env,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(w.fake.issues.get('Fork/app#80')?.body).toBe('explicit')
    expect(w.fake.issues.get('Upstream/app#80')?.body).toBe('')
    expect(w.fake.calls.some((call) => call.path === '/repos/Fork/app/issues/80' && call.method === 'PATCH')).toBe(true)
    expect(() => readFileSync(w.log, 'utf8')).toThrow()
  })
})
