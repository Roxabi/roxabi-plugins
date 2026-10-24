import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkout,
  type GitHubFake,
  hostileStartup,
  recipeEnv,
  run,
  startGitHub,
  trustedTriage,
  writeGh,
} from './fixtures/github-api'

const pluginPath = (name: string, file: string) => path.resolve(import.meta.dirname, '../../../../', name, file)
const quoted = (value: string) => JSON.stringify(value)
let root: string | undefined
let fake: GitHubFake | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function world() {
  root = mkdtempSync(path.join(tmpdir(), 'parent-coordinate-'))
  fake = await startGitHub(root, ['Acme/app#70', 'Acme/app#80', 'Acme/app#81', 'Acme/planning#70'])
  const origin = fake.issues.get('Acme/app#80')
  const b = fake.issues.get('Acme/app#81')
  if (!origin || !b) throw new Error('parent fixture issues missing')
  origin.parent = 70
  origin.parentRepo = 'Acme/planning'
  const { script } = trustedTriage(path.join(root, 'trusted'))
  const bin = path.join(root, 'bin')
  writeGh(bin)
  writeFileSync(
    path.join(bin, 'realpath'),
    `#!/usr/bin/env bash\n[ "$1" = skill://issue-triage/triage.ts ] && { printf '%s\\n' ${quoted(script)}; exit 0; }\nexec /usr/bin/realpath "$@"\n`,
    { mode: 0o755 },
  )
  const sentinel = path.join(root, 'preload-fired')
  const repo = checkout(path.join(root, 'target'), 'Acme/app', hostileStartup(sentinel, 'Created #999'))
  const files = path.join(root, 'files')
  mkdirSync(files)
  writeFileSync(path.join(files, 'title.txt'), 'Fictional qualified-parent follow-up\n')
  writeFileSync(path.join(files, 'body.md'), '**Origin:** #80\n\n## Acceptance criteria\n\n- [ ] Correct sibling.\n')
  const env = recipeEnv(fake, bin, {
    GITHUB_REPO: 'Acme/app',
    GH_PARENT: '70',
    GH_PARENT_REPO: 'Acme/planning',
    GH_LOG: path.join(root, 'gh.log'),
    BUN_STARTUP_LOG: path.join(root, 'startup.log'),
    FILE_DIR: files,
  })
  return { root, fake, b, origin, script, repo, sentinel, env }
}

describe('qualified parent coordinates', () => {
  it('issue-triage parent reader retains the foreign repository and distinguishes no parent', async () => {
    const w = await world()
    const program = path.join(w.root, 'reader.ts')
    writeFileSync(
      program,
      `import { getParentRef } from ${quoted(pluginPath('issue-triage', 'skills/shared/adapters/github-adapter.ts'))}\nconsole.log(JSON.stringify({parent:await getParentRef(80),topLevel:await getParentRef(81)}))\n`,
    )

    const ran = await run(`bun --no-env-file ${quoted(program)}`, w.root, w.env)

    expect(ran.code).toBe(0)
    expect(JSON.parse(ran.stdout)).toEqual({ parent: { number: 70, repo: 'Acme/planning' }, topLevel: null })
    expect(w.fake.calls.filter((call) => call.op === 'parent')).toHaveLength(2)
  })

  it('removes the actual foreign parent, not a same-number local relationship', async () => {
    const w = await world()
    w.b.parent = 70
    w.b.parentRepo = 'Acme/planning'

    const ran = await run(`bun --no-env-file ${quoted(w.script)} set 81 --rm-parent`, path.dirname(w.script), w.env)

    expect(ran.code).toBe(0)
    expect(w.b.parent).toBeUndefined()
    expect(w.b.parentRepo).toBeUndefined()
    expect(w.origin).toMatchObject({ parent: 70, parentRepo: 'Acme/planning' })
    expect(ran.stdout.trim()).toBe('RemovedParent=Acme/planning#70 #81')
    expect(w.fake.calls.some((call) => call.path === '/repos/Acme/planning/issues/70')).toBe(true)
    expect(w.fake.calls.some((call) => call.path === '/repos/Acme/app/issues/70')).toBe(false)
    expect(existsSync(w.sentinel)).toBe(false)
  })
})
