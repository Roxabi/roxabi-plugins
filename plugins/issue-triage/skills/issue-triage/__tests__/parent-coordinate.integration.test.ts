import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkout,
  type GitHubFake,
  hostileStartup,
  recipeAfterWrite,
  recipeEnv,
  run,
  startGitHub,
  trustedTriage,
  writeGh,
} from './fixtures/github-api'

const pluginPath = (name: string, file: string) => path.resolve(import.meta.dirname, '../../../../', name, file)
const ompFix = readFileSync(pluginPath('omp-build', 'skills/fix/SKILL.md'), 'utf8')
const launcher = recipeAfterWrite(ompFix, '### Filing').slice(0, -1).join('\n')
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

function parentLookup(markdown: string): string {
  const command = /gh api graphql -f query='[^']*parent[^']*'\s*(?:\\\s*)?--jq '[^']*'/.exec(markdown)?.[0]
  if (!command) throw new Error('authored parent lookup missing')
  return command.replaceAll('<O>', 'Acme').replaceAll('<R>', 'app').replaceAll('<SOURCE_ISSUE>', '80')
}

function parentArgument(markdown: string): string {
  const argument = /- `(--parent "[^"]*")`/.exec(markdown)?.[1]
  if (!argument) throw new Error('authored parent argument missing')
  return argument
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

    const ran = await run(`${launcher}\ntriage set 81 --rm-parent`, w.repo, w.env)

    expect(ran.code).toBe(0)
    expect(w.b.parent).toBeUndefined()
    expect(w.b.parentRepo).toBeUndefined()
    expect(w.origin).toMatchObject({ parent: 70, parentRepo: 'Acme/planning' })
    expect(ran.stdout.trim()).toBe('RemovedParent=Acme/planning#70 #81')
    expect(w.fake.calls.some((call) => call.path === '/repos/Acme/planning/issues/70')).toBe(true)
    expect(w.fake.calls.some((call) => call.path === '/repos/Acme/app/issues/70')).toBe(false)
    expect(existsSync(w.sentinel)).toBe(false)
  })

  it.each([
    { name: 'omp-build', topLevel: false },
    { name: 'omp-build', topLevel: true },
  ])('$name authored lookup and filing preserve parent identity (top-level=$topLevel)', async ({ name, topLevel }) => {
    const w = await world()
    const markdown = readFileSync(pluginPath(name, 'skills/fix/SKILL.md'), 'utf8')
    if (topLevel) {
      delete w.origin.parent
      delete w.origin.parentRepo
    }
    const script = `${launcher}\nSOURCE_ISSUE=80\nSOURCE_PARENT=$(${parentLookup(markdown)}) && { parent=(); if [ -n "$SOURCE_PARENT" ]; then parent=(${parentArgument(markdown)}); fi; triage create --title-file "$FILE_DIR/title.txt" --body-file "$FILE_DIR/body.md" "\${parent[@]}" --blocked-by "#\${SOURCE_ISSUE}"; }`

    const ran = await run(script, w.repo, { ...w.env, GH_PARENT: topLevel ? '' : '70' })

    expect(ran.code).toBe(0)
    const created = w.fake.created[0]
    expect(created).toMatchObject({ repo: 'Acme/app', blockedBy: [80] })
    if (topLevel) {
      expect(created.parent).toBeUndefined()
      expect(created.parentRepo).toBeUndefined()
      expect(w.fake.calls.some((call) => /\/issues\/70$/.test(call.path))).toBe(false)
    } else {
      expect(created).toMatchObject({ parent: 70, parentRepo: 'Acme/planning' })
      expect(w.fake.calls.some((call) => call.path === '/repos/Acme/app/issues/70')).toBe(false)
    }
    expect(existsSync(w.sentinel)).toBe(false)
  })
})
