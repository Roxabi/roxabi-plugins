import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkout,
  type GitHubFake,
  ghCalls,
  hostileStartup,
  recipeAfterWrite,
  recipeEnv,
  run,
  startGitHub,
  startupLog,
  trustedTriage,
  writeGh,
} from '../../../../issue-triage/skills/issue-triage/__tests__/fixtures/github-api'

/**
 * The ### Filing block after `# write … then:` is what an operator pastes in a
 * PR's checkout. It runs here as pasted, with the real Bun and the real triage
 * CLI, against GitHub isolated at the transport (#762): the checkout is hostile
 * (a tracked `bunfig.toml` preload that forges `Created #999` and exits 0, and a
 * `.env`), and triage's own directory observes where Bun started.
 */
const FIX = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')
const RECIPE = recipeAfterWrite(FIX, '### Filing')
const LAUNCH = RECIPE.slice(0, -1).join('\n')
const FLAGS = "--type fix --size S --parent '#70' --blocked-by '#80'"
const filingCommand = (flags = FLAGS) =>
  `${LAUNCH}\ntriage create --title-file "$FILE_DIR/title.txt" --body-file "$FILE_DIR/body.md" ${flags}`
/** The pre-#762 block: Bun started in the shell's cwd, the checkout. */
const PRE_762 = `T=$(realpath skill://issue-triage/triage.ts) && bun "$T" create --title-file "$FILE_DIR/title.txt" --body-file "$FILE_DIR/body.md" ${FLAGS}`
const FORGED = 'Created #999: forged'
const TITLE = 'Deferred non-blocking review findings'
const BODY = '**Origin:** PR #12\n\n## Acceptance criteria\n\n- [ ] a\n'

let root: string | undefined
let fake: GitHubFake | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** A hostile checkout of Acme/app, a trusted triage copy, stub gh and realpath. */
async function world(realpathOk = true) {
  root = mkdtempSync(path.join(tmpdir(), 'omp-fix-filing-'))
  fake = await startGitHub(root, ['Acme/app#70', 'Acme/app#80', 'Other/tracker#70', 'Other/tracker#80'])
  const { script } = trustedTriage(path.join(root, 'trusted'))
  const bin = path.join(root, 'bin')
  writeGh(bin)
  writeFileSync(
    path.join(bin, 'realpath'),
    realpathOk
      ? `#!/usr/bin/env bash\n[ "$1" = skill://issue-triage/triage.ts ] && { printf '%s\\n' ${JSON.stringify(script)}; exit 0; }\nexec /usr/bin/realpath "$@"\n`
      : '#!/usr/bin/env bash\necho "realpath: $1: No such file or directory" >&2\nexit 1\n',
    { mode: 0o755 },
  )
  const sentinel = path.join(root, 'checkout-startup.log')
  const repo = checkout(path.join(root, 'checkout'), 'Acme/app', hostileStartup(sentinel, FORGED))
  mkdirSync(path.join(repo, 'sub'))
  const files = path.join(root, 'files')
  mkdirSync(files)
  writeFileSync(path.join(files, 'title.txt'), TITLE)
  writeFileSync(path.join(files, 'body.md'), BODY)
  const ghLog = path.join(root, 'gh.log')
  const startup = path.join(root, 'trusted-startup.log')
  const env = recipeEnv(fake, bin, { FILE_DIR: files, GH_LOG: ghLog, BUN_STARTUP_LOG: startup })
  return { fake, script, triageDir: path.dirname(script), repo, sentinel, ghLog, startup, env, bin }
}

describe('fix Filing block', () => {
  it.each([
    ['the checkout', ''],
    ['a checkout subdirectory', 'sub'],
  ])('files from %s with Bun started in the triage directory', async (_where, sub) => {
    const w = await world()
    const ran = await run(filingCommand(), path.join(w.repo, sub), w.env)

    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)
    expect(ran.stdout.trim().split('\n')).toEqual([
      `Created #101: ${TITLE}`,
      'Type=fix #101',
      'Size=S #101',
      'Parent=#70 #101',
      'BlockedBy=#80 #101',
    ])
    const [created] = w.fake.created
    if (!created) throw new Error('filing fixture issue missing')
    expect(w.fake.created).toHaveLength(1)
    expect(created).toMatchObject({ repo: 'Acme/app', type: 'fix', parent: 70, blockedBy: [80] })
    // Bun started once, in the trusted triage directory, without its .env.
    expect(startupLog(w.startup)).toEqual([`${w.triageDir}\t`])
    expect(existsSync(w.sentinel)).toBe(false)
    expect(w.fake.calls.every((call) => call.authorization.endsWith('fixture'))).toBe(true)
    const labelChildren = ghCalls(w.ghLog).filter((call) => call.args.startsWith('issue edit '))
    expect(labelChildren).not.toEqual([])
    expect(labelChildren.every((child) => child.cwd === w.triageDir && child.env === '')).toBe(true)
    expect(labelChildren.at(-1)?.args).toBe('issue edit 101 --repo Acme/app --add-label size:S')
  })

  it('files into the operator’s exported GITHUB_REPO, not the checkout’s repository', async () => {
    const w = await world()
    const ran = await run(filingCommand(), w.repo, {
      ...w.env,
      GITHUB_REPO: 'Other/tracker',
    })

    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)
    const [created] = w.fake.created
    if (!created) throw new Error('filing fixture issue missing')
    expect(w.fake.created).toHaveLength(1)
    expect(created).toMatchObject({ repo: 'Other/tracker', type: 'fix', parent: 70, blockedBy: [80] })
    expect(ghCalls(w.ghLog).at(-1)?.args).toBe('issue edit 101 --repo Other/tracker --add-label size:S')
  })

  it('pre-#762 block: the checkout preload forges the receipt and nothing is filed', async () => {
    const w = await world()
    const ran = await run(PRE_762, w.repo, w.env)

    expect(ran.code).toBe(0)
    expect(ran.stdout.trim()).toBe(FORGED)
    expect(readFileSync(w.sentinel, 'utf8')).toBe(`${w.repo}\tcheckout-dotenv\n`)
    expect(w.fake.calls).toEqual([])
    expect(startupLog(w.startup)).toEqual([])
  })

  it('refuses before Bun starts when the repository does not resolve', async () => {
    const w = await world()
    const neutral = path.join(root ?? '', 'neutral')
    mkdirSync(neutral)
    const ran = await run(filingCommand(), neutral, w.env)

    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('repository unresolved')
    expect(startupLog(w.startup)).toEqual([])
    expect(w.fake.calls).toEqual([])
    expect(ghCalls(w.ghLog).map((call) => call.args)).toEqual(['repo view --json nameWithOwner --jq .nameWithOwner'])
  })

  it('refuses before Bun starts when issue-triage does not resolve', async () => {
    const w = await world(false)
    const marker = path.join(root ?? '', 'bun-ran')
    writeFileSync(
      path.join(w.bin, 'bun'),
      `#!/usr/bin/env bash\nprintf 'ran\\n' > ${JSON.stringify(marker)}\nexit 42\n`,
      { mode: 0o755 },
    )
    const ran = await run(filingCommand(), w.repo, w.env)

    expect(ran.code).not.toBe(0)
    expect(ran.code).not.toBe(42)
    expect(ran.stderr).toContain('issue-triage unresolved')
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(w.sentinel)).toBe(false)
    expect(w.fake.calls).toEqual([])
  })

  it('finishes a partial create with set, never a second create', async () => {
    const w = await world()
    w.fake.fail.add('addSubIssue')
    const partial = await run(filingCommand(), w.repo, w.env)

    expect(partial.code).not.toBe(0)
    expect(partial.stdout.trim().split('\n')).toEqual([`Created #101: ${TITLE}`, 'Type=fix #101', 'Size=S #101'])

    w.fake.fail.delete('addSubIssue')
    const recovered = await run(`${LAUNCH}\ntriage set 101 --parent '#70' --blocked-by '#80'`, w.repo, w.env)

    expect(recovered.code).toBe(0)
    expect(recovered.stdout).toContain('Parent=#70 #101')
    expect(recovered.stdout).toContain('BlockedBy=#80 #101')
    expect(w.fake.created.map((issue) => issue.number)).toEqual([101])
    expect(w.fake.issues.get('Acme/app#101')).toMatchObject({ type: 'fix', parent: 70, blockedBy: [80] })
    expect(startupLog(w.startup)).toEqual([`${w.triageDir}\t`, `${w.triageDir}\t`])
    expect(existsSync(w.sentinel)).toBe(false)
  })
})
