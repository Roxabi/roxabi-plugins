import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// ─── Paths ───────────────────────────────────────────────────────────────────

const CHECK_NO_CLAUDE_COMMENTS = path.resolve(import.meta.dirname, '../check-no-claude-comments.sh')
const CHECK_SKILL_VERSION = path.resolve(import.meta.dirname, '../check-skill-version.sh')

// ─── AI marker (never written as a literal contiguous sequence in this file) ──
// The regex (# | // | /\*)[[:space:]]*CLAUDE: must NOT match this source file.
// We construct the marker dynamically so the literal never appears in source.
const AI_MARKER = 'CLA' + 'UDE:'

// ─── Clean env (isolate from outer git context) ───────────────────────────────

const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runScript(scriptPath: string, cwd: string): number {
  try {
    execSync(`bash ${scriptPath}`, { cwd, stdio: 'pipe', env: CLEAN_ENV })
    return 0
  } catch (err: unknown) {
    const e = err as { status?: number }
    return e.status ?? 1
  }
}

function runScriptCapture(scriptPath: string, cwd: string): { code: number; stderr: string } {
  const result = spawnSync('bash', [scriptPath], { cwd, env: CLEAN_ENV })
  return {
    code: result.status ?? 1,
    stderr: result.stderr ? result.stderr.toString() : '',
  }
}

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', env: CLEAN_ENV })
}

// ─── R1 — check-no-claude-comments.sh ────────────────────────────────────────

describe('check-no-claude-comments.sh', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exits 1 when a tracked .ts file contains a comment-leader followed by the AI marker', () => {
    // Arrange
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-r1-ts-'))
    const plantedComment = `// ${AI_MARKER} resolve before merge`
    fs.writeFileSync(path.join(tmpDir, 'foo.ts'), `export const x = 1\n${plantedComment}\n`)
    git('git init -q', tmpDir)
    git('git add foo.ts', tmpDir)
    git('git -c user.email=t@t -c user.name=t commit -q -m init', tmpDir)

    // Act
    const code = runScript(CHECK_NO_CLAUDE_COMMENTS, tmpDir)

    // Assert
    expect(code).toBe(1)
  })

  it('exits 0 when the AI marker is in a .md file — extension filter exempts .md even when comment syntax matches the regex', () => {
    // Arrange — use a shell-style comment that WOULD match the gate regex if .md were scanned
    // (proves the extension filter is load-bearing, not comment syntax differences)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-r1-md-'))
    const markerInMd = `# ${AI_MARKER} resolve before merge`
    fs.writeFileSync(path.join(tmpDir, 'README.md'), `# Title\n${markerInMd}\n`)
    git('git init -q', tmpDir)
    git('git add README.md', tmpDir)
    git('git -c user.email=t@t -c user.name=t commit -q -m init', tmpDir)

    // Act
    const code = runScript(CHECK_NO_CLAUDE_COMMENTS, tmpDir)

    // Assert
    expect(code).toBe(0)
  })

  it('exits 0 when no AI marker is present in any file', () => {
    // Arrange
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-r1-clean-'))
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const greeting = "hello"\n')
    git('git init -q', tmpDir)
    git('git add index.ts', tmpDir)
    git('git -c user.email=t@t -c user.name=t commit -q -m init', tmpDir)

    // Act
    const code = runScript(CHECK_NO_CLAUDE_COMMENTS, tmpDir)

    // Assert
    expect(code).toBe(0)
  })
})

// ─── R2 — check-skill-version.sh ─────────────────────────────────────────────

describe('check-skill-version.sh', () => {
  let workDir: string
  let bareDir: string

  afterEach(() => {
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
    if (bareDir && fs.existsSync(bareDir)) {
      fs.rmSync(bareDir, { recursive: true, force: true })
    }
  })

  function setupOriginWithPlugin(opts: { pluginName: string; version?: string; skillContent?: string }): {
    work: string
    bare: string
  } {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-r2-bare-'))
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-r2-work-'))

    // Build initial commit in work dir, then push to bare as origin/main
    git('git init -q', work)

    const pluginDir = path.join(work, 'plugins', opts.pluginName, '.claude-plugin')
    fs.mkdirSync(pluginDir, { recursive: true })
    const pluginJson: Record<string, string> = {}
    if (opts.version !== undefined) pluginJson.version = opts.version
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginJson))

    const skillDir = path.join(work, 'plugins', opts.pluginName, 'skills')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'my-skill.md'), opts.skillContent ?? '# skill v1\n')

    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "init"', work)

    // Create bare repo and push the base commit as main
    git('git init -q --bare', bare)
    git(`git remote add origin ${bare}`, work)
    git('git push -q origin HEAD:main', work)

    return { work, bare }
  }

  it('exits 1 when a plugin has an unchanged version and skills/ changed on HEAD vs origin/main', () => {
    // Arrange — plugin "foo" has version "1.0.0" on origin/main, unchanged on HEAD
    const { work, bare } = setupOriginWithPlugin({ pluginName: 'foo', version: '1.0.0' })
    workDir = work
    bareDir = bare

    // Add a change to skills/ without bumping the version
    const skillDir = path.join(work, 'plugins', 'foo', 'skills')
    fs.writeFileSync(path.join(skillDir, 'my-skill.md'), '# skill v2 (no bump)\n')
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "update skill"', work)

    // Act
    const code = runScript(CHECK_SKILL_VERSION, work)

    // Assert
    expect(code).toBe(1)
  })

  it('exits 0 when a plugin has no version field (SHA-based plugin) and skills/ changed', () => {
    // Arrange — plugin "bar" has no version field (SHA-based)
    const { work, bare } = setupOriginWithPlugin({ pluginName: 'bar' })
    workDir = work
    bareDir = bare

    // Add a change to skills/ — should be skipped because no version field
    const skillDir = path.join(work, 'plugins', 'bar', 'skills')
    fs.writeFileSync(path.join(skillDir, 'my-skill.md'), '# skill v2 (sha-based)\n')
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "update sha-based skill"', work)

    // Act
    const code = runScript(CHECK_SKILL_VERSION, work)

    // Assert
    expect(code).toBe(0)
  })

  it('exits 0 when a plugin version is bumped above base and skills/ changed', () => {
    // Arrange — plugin "baz" starts at version "1.0.0"
    const { work, bare } = setupOriginWithPlugin({ pluginName: 'baz', version: '1.0.0' })
    workDir = work
    bareDir = bare

    // Update both the skill AND the version — valid bump
    const skillDir = path.join(work, 'plugins', 'baz', 'skills')
    fs.writeFileSync(path.join(skillDir, 'my-skill.md'), '# skill v2\n')
    const pluginJsonPath = path.join(work, 'plugins', 'baz', '.claude-plugin', 'plugin.json')
    fs.writeFileSync(pluginJsonPath, JSON.stringify({ version: '1.1.0' }))
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "update skill + bump version"', work)

    // Act
    const code = runScript(CHECK_SKILL_VERSION, work)

    // Assert
    expect(code).toBe(0)
  })

  it('exits 1 when a plugin has an unchanged version and commands/ changed on HEAD vs origin/main', () => {
    // Arrange — plugin "qux" has version "2.0.0" on origin/main
    const { work, bare } = setupOriginWithPlugin({ pluginName: 'qux', version: '2.0.0' })
    workDir = work
    bareDir = bare

    // Add a file under commands/ without bumping the version
    const commandsDir = path.join(work, 'plugins', 'qux', 'commands')
    fs.mkdirSync(commandsDir, { recursive: true })
    fs.writeFileSync(path.join(commandsDir, 'my-command.md'), '# command v1\n')
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "add command without bump"', work)

    // Act
    const code = runScript(CHECK_SKILL_VERSION, work)

    // Assert — commands/ pathspec is load-bearing: missing bump is caught
    expect(code).toBe(1)
  })

  it('exits 0 and emits an origin/main-unreachable SKIP when origin/main is not reachable', () => {
    // Arrange — repo with no remote at all (no origin/main)
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-r2-noremote-'))
    git('git init -q', workDir)
    const pluginDir = path.join(workDir, 'plugins', 'nop', '.claude-plugin')
    fs.mkdirSync(pluginDir, { recursive: true })
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ version: '1.0.0' }))
    const skillDir = path.join(workDir, 'plugins', 'nop', 'skills')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'skill.md'), '# skill\n')
    git('git add -A', workDir)
    git('git -c user.email=t@t -c user.name=t commit -q -m "init"', workDir)

    // Act — script must skip gracefully, not error
    const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, workDir)

    // Assert — guard skips with exit 0 and prints a visible SKIP line to stderr
    expect(code).toBe(0)
    expect(stderr).toMatch(/origin\/main unreachable/)
  })
})
