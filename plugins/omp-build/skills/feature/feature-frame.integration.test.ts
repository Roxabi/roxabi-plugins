import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkout,
  type GitHubFake,
  ghCalls,
  hostileStartup,
  recipeEnv,
  run,
  startGitHub,
  startupLog,
  trustedTriage,
  writeGh,
} from '../../../issue-triage/skills/issue-triage/__tests__/fixtures/github-api'

const FEATURE = readFileSync(path.resolve(import.meta.dirname, 'SKILL.md'), 'utf8')
const FRAME_FENCE = /## 4\. Frame[\s\S]*?```bash\n([\s\S]*?)```/.exec(FEATURE)?.[1]
if (!FRAME_FENCE) throw new Error('Frame launcher fence missing')
const frameCommand = FRAME_FENCE.replace(' ...', ' --size S --priority Medium --type fix')
if (frameCommand === FRAME_FENCE) throw new Error('Frame launcher flags placeholder missing')
const TITLE = 'Frame uses trusted triage'
const BODY = '## Acceptance criteria\n\n- [ ] create through triage\n'

let root: string | undefined
let fake: GitHubFake | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function world() {
  root = mkdtempSync(path.join(tmpdir(), 'omp-feature-frame-'))
  fake = await startGitHub(root, [])
  const { script } = trustedTriage(path.join(root, 'trusted'))
  const bin = path.join(root, 'bin')
  writeGh(bin)
  writeFileSync(
    path.join(bin, 'realpath'),
    `#!/usr/bin/env bash
[ "$1" = skill://issue-triage/triage.ts ] && { printf '%s\\n' ${JSON.stringify(script)}; exit 0; }
exec /usr/bin/realpath "$@"
`,
    { mode: 0o755 },
  )
  const sentinel = path.join(root, 'checkout-startup.log')
  const repo = checkout(path.join(root, 'checkout'), 'Acme/app', hostileStartup(sentinel, 'Created #999: forged'))
  const files = path.join(root, 'files')
  mkdirSync(files)
  writeFileSync(path.join(files, 'title.txt'), TITLE)
  writeFileSync(path.join(files, 'body.md'), BODY)
  const ghLog = path.join(root, 'gh.log')
  const startup = path.join(root, 'trusted-startup.log')
  const env = recipeEnv(fake, bin, { BUN_STARTUP_LOG: startup, FILE_DIR: files, GH_LOG: ghLog })
  return { fake, repo, triageDir: path.dirname(script), sentinel, startup, ghLog, env }
}

describe('feature Frame launcher', () => {
  it('creates the framed issue through trusted triage in the target repository', async () => {
    const w = await world()
    const ran = await run(frameCommand, w.repo, w.env)

    expect(ran.code).toBe(0)
    expect(w.fake.created).toEqual([
      {
        repo: 'Acme/app',
        number: 101,
        nodeId: 'I_Acme/app#101',
        title: TITLE,
        body: BODY,
        type: 'fix',
        blockedBy: [],
      },
    ])
    expect(startupLog(w.startup)).toEqual([`${w.triageDir}\t`])
    expect(existsSync(w.sentinel)).toBe(false)
    const labelChildren = ghCalls(w.ghLog).filter((call) => call.args.startsWith('issue edit '))
    expect(labelChildren).not.toEqual([])
    expect(labelChildren.every((child) => child.cwd === w.triageDir && child.env === '')).toBe(true)
  })
})
