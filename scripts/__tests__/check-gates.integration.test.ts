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

function runScriptCapture(scriptPath: string, cwd: string): { code: number; stderr: string; stdout: string } {
  const result = spawnSync('bash', [scriptPath], { cwd, env: CLEAN_ENV })
  return {
    code: result.status ?? 1,
    stderr: result.stderr ? result.stderr.toString() : '',
    stdout: result.stdout ? result.stdout.toString() : '',
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

  function setupOriginWithPlugin(opts: {
    pluginName: string
    version?: string
    skillContent?: string
    pluginJson?: boolean
    catalogue?: { documentVersion: string; entryVersion?: string }
  }): {
    work: string
    bare: string
  } {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-r2-bare-'))
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-r2-work-'))

    // Build initial commit in work dir, then push to bare as origin/main
    git('git init -q', work)

    if (opts.pluginJson !== false) {
      const pluginDir = path.join(work, 'plugins', opts.pluginName, '.claude-plugin')
      fs.mkdirSync(pluginDir, { recursive: true })
      const pluginJson: Record<string, string> = {}
      if (opts.version !== undefined) pluginJson.version = opts.version
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginJson))
    }

    if (opts.catalogue) {
      const ompDir = path.join(work, '.omp-plugin')
      fs.mkdirSync(ompDir, { recursive: true })
      const row: Record<string, string> = {
        name: opts.pluginName,
        source: `./plugins/${opts.pluginName}`,
      }
      if (opts.catalogue.entryVersion !== undefined) row.version = opts.catalogue.entryVersion
      fs.writeFileSync(
        path.join(ompDir, 'marketplace.json'),
        JSON.stringify({
          name: 'fixture-marketplace',
          version: opts.catalogue.documentVersion,
          plugins: [row],
        }),
      )
    }

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

  function commitSkillChange(work: string, pluginName: string, body: string): void {
    fs.writeFileSync(path.join(work, 'plugins', pluginName, 'skills', 'my-skill.md'), body)
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "update skill"', work)
  }

  function bumpCatalogueEntry(work: string, pluginName: string, version: string): void {
    const catalogPath = path.join(work, '.omp-plugin', 'marketplace.json')
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
      version: string
      plugins: Array<{ name: string; version?: string }>
    }
    const row = catalog.plugins.find((entry) => entry.name === pluginName)
    if (!row) throw new Error(`no catalogue entry for ${pluginName}`)
    row.version = version
    fs.writeFileSync(catalogPath, JSON.stringify(catalog))
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

  it('exits 0 AND emits a visible SHA-based SKIP when a plugin has no version field and skills/ changed', () => {
    // Arrange — plugin "bar" has no version field (SHA-based)
    const { work, bare } = setupOriginWithPlugin({ pluginName: 'bar' })
    workDir = work
    bareDir = bare

    // Add a change to skills/ — skipped because no version field
    const skillDir = path.join(work, 'plugins', 'bar', 'skills')
    fs.writeFileSync(path.join(skillDir, 'my-skill.md'), '# skill v2 (sha-based)\n')
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "update sha-based skill"', work)

    // Act
    const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    // Assert — inertness MUST be disclosed, not silent (same bar as the origin/main SKIP)
    expect(code).toBe(0)
    expect(stderr).toMatch(/SKIP: bar is SHA-based/)
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

  it('exits 1 and names the OMP catalogue when skills change and the catalogue version equals origin/main', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    commitSkillChange(work, 'omp-build', '# skill v2 (no catalogue bump)\n')

    const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('omp-build')
    expect(stdout).toContain('still 0.7.0')
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stdout).not.toContain('9.9.9')
  })

  it('exits 0 when skills change and only the OMP catalogue entry version is bumped', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    bumpCatalogueEntry(work, 'omp-build', '0.8.0')
    commitSkillChange(work, 'omp-build', '# skill v2 (catalogue bumped)\n')

    const { code } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(0)
  })

  it('exits 0 and emits a visible SKIP when the OMP catalogue entry has no version', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'plain',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9' },
    })
    workDir = work
    bareDir = bare
    commitSkillChange(work, 'plain', '# skill v2 (unversioned catalogue)\n')

    const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(0)
    expect(stderr).toMatch(/SKIP: plain has no version in \.omp-plugin\/marketplace\.json/)
  })

  it('exits 1 naming the OMP catalogue when plugin.json is SHA-based and the catalogue version is unchanged', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'dev-core',
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.3.0' },
    })
    workDir = work
    bareDir = bare
    commitSkillChange(work, 'dev-core', '# skill v2 (sha plugin.json, stale catalogue)\n')

    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('dev-core')
    expect(stdout).toContain('still 0.3.0')
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stdout).not.toContain('9.9.9')
    expect(stderr).toMatch(/SKIP: dev-core is SHA-based/)
  })

  it('exits 0 and keeps the SHA-based SKIP when plugin.json has no version and the catalogue entry is bumped', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'dev-core',
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.3.0' },
    })
    workDir = work
    bareDir = bare
    bumpCatalogueEntry(work, 'dev-core', '0.4.0')
    commitSkillChange(work, 'dev-core', '# skill v2 (sha plugin.json, catalogue bumped)\n')

    const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(0)
    expect(stderr).toMatch(/SKIP: dev-core is SHA-based/)
  })

  it('exits 1 naming plugin.json when the Claude version is unchanged even if the OMP catalogue entry is bumped', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'dual',
      version: '1.0.0',
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    bumpCatalogueEntry(work, 'dual', '0.8.0')
    commitSkillChange(work, 'dual', '# skill v2 (claude stale, catalogue bumped)\n')

    const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('plugins/dual/.claude-plugin/plugin.json')
    expect(stdout).not.toContain('.omp-plugin/marketplace.json')
  })

  it('exits 1 naming the catalogue when HEAD is unbumped even if the worktree file is bumped', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    commitSkillChange(work, 'omp-build', '# skill v2 (dirty catalogue)\n')
    bumpCatalogueEntry(work, 'omp-build', '0.8.0')

    const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('still 0.7.0')
    expect(stdout).toContain('.omp-plugin/marketplace.json')
  })

  it('exits 1 naming the catalogue when a later row is bumped and the first row has no version', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    const catalogPath = path.join(work, '.omp-plugin', 'marketplace.json')
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
      plugins: Array<Record<string, string>>
    }
    catalog.plugins = [
      { name: 'omp-build', source: './plugins/omp-build' },
      { name: 'omp-build', source: './plugins/decoy', version: '0.8.0' },
    ]
    fs.writeFileSync(catalogPath, JSON.stringify(catalog))
    commitSkillChange(work, 'omp-build', '# skill v2 (duplicate rows)\n')

    const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stdout).not.toContain('still 0.8.0')
  })

  it('exits 1 naming the catalogue when the pushed catalogue JSON does not parse', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    fs.writeFileSync(path.join(work, '.omp-plugin', 'marketplace.json'), '{not json')
    commitSkillChange(work, 'omp-build', '# skill v2 (bad json)\n')

    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stderr).not.toMatch(/SKIP: omp-build has no version in/)
  })

  it('exits 1 naming the catalogue when origin/main catalogue JSON does not parse', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    fs.writeFileSync(path.join(work, '.omp-plugin', 'marketplace.json'), '{not json')
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "break catalogue"', work)
    git('git push -q origin HEAD:main', work)
    fs.writeFileSync(
      path.join(work, '.omp-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'fixture-marketplace',
        version: '9.9.9',
        plugins: [{ name: 'omp-build', version: '0.7.0', source: './plugins/omp-build' }],
      }),
    )
    commitSkillChange(work, 'omp-build', '# skill v2 (base unreadable)\n')

    const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stdout).not.toContain('still 0.7.0')
  })

  it('exits 1 naming the catalogue when the pushed version is only whitespace', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    bumpCatalogueEntry(work, 'omp-build', '   ')
    commitSkillChange(work, 'omp-build', '# skill v2 (blank version)\n')

    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stderr).not.toMatch(/SKIP: omp-build has no version in/)
  })
})
