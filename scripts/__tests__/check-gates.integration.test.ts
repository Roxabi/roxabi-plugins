import { execFileSync, execSync, spawnSync } from 'node:child_process'
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
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'CHECK_SKILL_VERSION_BASE'),
  ),
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
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

function runScriptCapture(
  scriptPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv = CLEAN_ENV,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync('bash', [scriptPath], { cwd, env })
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
    claudeCatalogue?: { documentVersion: string; entryVersion?: string }
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
    if (opts.claudeCatalogue) {
      const dir = path.join(work, '.claude-plugin')
      fs.mkdirSync(dir, { recursive: true })
      const row: Record<string, string> = {
        name: opts.pluginName,
        source: `./plugins/${opts.pluginName}`,
      }
      if (opts.claudeCatalogue.entryVersion !== undefined) row.version = opts.claudeCatalogue.entryVersion
      fs.writeFileSync(
        path.join(dir, 'marketplace.json'),
        JSON.stringify({ version: opts.claudeCatalogue.documentVersion, plugins: [row] }),
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

  function commitPluginPathChange(work: string, pluginName: string, relativePath: string, body: string): void {
    const file = path.join(work, 'plugins', pluginName, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "update plugin runtime"', work)
  }

  function commitSkillChange(work: string, pluginName: string, body: string): void {
    commitPluginPathChange(work, pluginName, 'skills/my-skill.md', body)
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

  function catalogueBytes(version: string): string {
    return JSON.stringify({
      name: 'fixture-marketplace',
      version: '9.9.9',
      plugins: [{ name: 'omp-build', version, source: './plugins/omp-build' }],
    })
  }

  function writeCatalogue(work: string, bytes: string): void {
    fs.writeFileSync(path.join(work, '.omp-plugin', 'marketplace.json'), bytes)
  }
  function writeClaudeCatalogue(work: string, bytes: string): void {
    const file = path.join(work, '.claude-plugin', 'marketplace.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
  }

  function claudeCatalogueBytes(plugin: string, version?: string): string {
    return JSON.stringify({
      version: '9.9.9',
      plugins: [{ name: plugin, source: `./plugins/${plugin}`, ...(version === undefined ? {} : { version }) }],
    })
  }

  function pushAsMain(work: string, message: string): void {
    git('git add -A', work)
    git(`git -c user.email=t@t -c user.name=t commit -q -m "${message}"`, work)
    git('git push -q origin HEAD:main', work)
  }

  function expectRejectedCatalogue(bytes: string, side: 'head' | 'base'): void {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    if (side === 'base') {
      writeCatalogue(work, bytes)
      pushAsMain(work, 'break base catalogue')
      writeCatalogue(work, catalogueBytes('0.8.0'))
    } else {
      writeCatalogue(work, bytes)
    }
    commitSkillChange(work, 'omp-build', `# skill v2 (${side} catalogue rejected)\n`)
    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)
    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stderr).not.toMatch(/SKIP: omp-build has no version in/)
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
    expect(stderr).toContain('SKIP: bar takes its Claude version from the commit SHA')
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

  describe('Claude catalogue version fallback', () => {
    function fixture(manifestVersion?: string): string {
      const { work, bare } = setupOriginWithPlugin({
        pluginName: 'claude-only',
        version: manifestVersion,
        claudeCatalogue: { documentVersion: '9.9.9', entryVersion: '1.0.0' },
      })
      workDir = work
      bareDir = bare
      return work
    }

    it('rejects an unchanged catalogue row when the manifest has no version', () => {
      const work = fixture()
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('.claude-plugin/marketplace.json')
      expect(stdout).toContain('1.0.0')
      expect(stdout).not.toContain('9.9.9')
    })

    it('accepts a bumped catalogue row without a manifest version', () => {
      const work = fixture()
      writeClaudeCatalogue(work, claudeCatalogueBytes('claude-only', '1.1.0'))
      commitSkillChange(work, 'claude-only', '# changed\n')
      expect(runScript(CHECK_SKILL_VERSION, work)).toBe(0)
    })

    it('uses the catalogue when the manifest is absent', () => {
      const { work, bare } = setupOriginWithPlugin({
        pluginName: 'claude-only',
        pluginJson: false,
        claudeCatalogue: { documentVersion: '9.9.9', entryVersion: '1.0.0' },
      })
      workDir = work
      bareDir = bare
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('.claude-plugin/marketplace.json')
    })

    it('gives the manifest precedence over a bumped catalogue row', () => {
      const work = fixture('2.0.0')
      writeClaudeCatalogue(work, claudeCatalogueBytes('claude-only', '1.1.0'))
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('plugins/claude-only/.claude-plugin/plugin.json')
      expect(stdout).not.toContain('bump .claude-plugin/marketplace.json')
    })

    it('accepts a manifest bump even when the catalogue row is unchanged', () => {
      const work = fixture('2.0.0')
      fs.writeFileSync(
        path.join(work, 'plugins', 'claude-only', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ version: '2.1.0' }),
      )
      commitSkillChange(work, 'claude-only', '# changed\n')
      expect(runScript(CHECK_SKILL_VERSION, work)).toBe(0)
    })

    it('compares a catalogue fallback against the base manifest version', () => {
      const work = fixture('2.0.0')
      fs.writeFileSync(path.join(work, 'plugins', 'claude-only', '.claude-plugin', 'plugin.json'), '{}')
      writeClaudeCatalogue(work, claudeCatalogueBytes('claude-only', '2.0.0'))
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('2.0.0')
    })

    it('compares a new manifest version against the base catalogue fallback', () => {
      const work = fixture()
      fs.writeFileSync(
        path.join(work, 'plugins', 'claude-only', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ version: '1.0.0' }),
      )
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('1.0.0')
    })

    it('discloses SHA-based versioning when neither surface declares a version', () => {
      const work = fixture()
      writeClaudeCatalogue(work, claudeCatalogueBytes('claude-only'))
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(0)
      expect(stderr).toContain('SKIP: claude-only takes its Claude version from the commit SHA')
    })

    it('skips when neither Claude version surface exists', () => {
      const { work, bare } = setupOriginWithPlugin({ pluginName: 'no-surface', pluginJson: false })
      workDir = work
      bareDir = bare
      commitSkillChange(work, 'no-surface', '# changed\n')
      const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(0)
      expect(stderr).toContain('SKIP: no-surface has no Claude manifest or local catalogue row')
    })

    it.each(['head', 'base'] as const)('rejects malformed Claude catalogue JSON on %s', (side) => {
      const work = fixture()
      writeClaudeCatalogue(work, '{not json')
      if (side === 'base') {
        pushAsMain(work, 'break Claude catalogue')
        writeClaudeCatalogue(work, claudeCatalogueBytes('claude-only', '1.1.0'))
      }
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('.claude-plugin/marketplace.json')
      expect(stdout).toMatch(/pars/i)
    })

    it.each(['head', 'base'] as const)('rejects duplicate Claude catalogue rows on %s', (side) => {
      const work = fixture()
      writeClaudeCatalogue(
        work,
        JSON.stringify({
          plugins: [
            { name: 'claude-only', source: './plugins/claude-only', version: '1.0.0' },
            { name: 'claude-only', source: './plugins/claude-only', version: '1.1.0' },
          ],
        }),
      )
      if (side === 'base') {
        pushAsMain(work, 'duplicate Claude row')
        writeClaudeCatalogue(work, claudeCatalogueBytes('claude-only', '1.1.0'))
      }
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('.claude-plugin/marketplace.json')
      expect(stdout).toMatch(/duplicate/i)
    })

    // Claude versions are free strings, so a non-semver bump passes. A version that is
    // not a non-empty single-line string fails closed; Claude Code refuses an explicit null.
    it.each([
      ['a number', 2, 1],
      ['an explicit null', null, 1],
      ['an empty string', '', 1],
      ['a multi-line string', '1.1.0\n', 1],
      ['a non-semver string', 'build-42', 0],
    ])('treats a HEAD Claude row version that is %s as exit %i', (_case, version, expected) => {
      const work = fixture()
      writeClaudeCatalogue(
        work,
        JSON.stringify({ plugins: [{ name: 'claude-only', source: './plugins/claude-only', version }] }),
      )
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(expected)
      if (expected === 1) expect(stdout).toContain('not a non-empty single-line string')
    })

    it('rejects duplicate Claude rows even when plugin.json supplies the bumped version', () => {
      const work = fixture('2.0.0')
      fs.writeFileSync(
        path.join(work, 'plugins', 'claude-only', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ version: '2.1.0' }),
      )
      writeClaudeCatalogue(
        work,
        JSON.stringify({
          plugins: [
            { name: 'claude-only', source: './plugins/claude-only', version: '1.0.0' },
            { name: 'claude-only', source: './plugins/claude-copy', version: '1.1.0' },
          ],
        }),
      )
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('duplicate plugins[] rows named claude-only in .claude-plugin/marketplace.json')
    })

    // A remote row with the same name is another install, not this directory's Claude row.
    it('does not ask a local plugin to bump a remote Claude row that shares its name', () => {
      const { work, bare } = setupOriginWithPlugin({ pluginName: 'claude-only', pluginJson: false })
      workDir = work
      bareDir = bare
      writeClaudeCatalogue(
        work,
        JSON.stringify({
          plugins: [{ name: 'claude-only', source: { source: 'github', repo: 'a/b' }, version: '1.0.0' }],
        }),
      )
      pushAsMain(work, 'remote Claude row')
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(0)
      expect(stderr).toContain('SKIP: claude-only has no Claude manifest or local catalogue row')
    })

    it('discloses that a vendored plugin was remote at the base', () => {
      const work = fixture()
      writeClaudeCatalogue(
        work,
        JSON.stringify({ plugins: [{ name: 'claude-only', source: { source: 'github', repo: 'a/b' } }] }),
      )
      pushAsMain(work, 'remote at base')
      writeClaudeCatalogue(work, claudeCatalogueBytes('claude-only', '1.0.0'))
      commitSkillChange(work, 'claude-only', '# vendored\n')
      const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(0)
      expect(stderr).toContain('NOTE: claude-only was a remote Claude plugin at origin/main')
    })

    // Only a source object is remote; a missing or malformed source is still this row.
    it.each([
      ['missing', {}],
      ['null', { source: null }],
      ['an array', { source: [] }],
    ])('still compares a Claude row whose source is %s', (_case, source) => {
      const work = fixture()
      writeClaudeCatalogue(work, JSON.stringify({ plugins: [{ name: 'claude-only', version: '1.0.0', ...source }] }))
      pushAsMain(work, 'malformed source')
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('(still 1.0.0) — bump .claude-plugin/marketplace.json')
    })

    // Git quotes a non-ASCII path by default; a quoted path never matched plugins/<p>/.
    it.each([
      ['locally', undefined],
      ['with an explicit base', 'HEAD^'],
    ])('sees a runtime file with a non-ASCII name %s', (_case, base) => {
      const work = fixture()
      commitPluginPathChange(work, 'claude-only', 'commands/résumé.md', '# new command\n')
      const env = base === undefined ? undefined : { ...CLEAN_ENV, CHECK_SKILL_VERSION_BASE: base }
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work, env)
      expect(code).toBe(1)
      expect(stdout).toContain('claude-only: distributed runtime changed without version bump (still 1.0.0)')
    })

    // A skill, command group or agent named like a category is runtime; the category
    // directories inside it are not.
    it.each([
      ['skills/docs/SKILL.md', 1],
      ['skills/tests/SKILL.md', 1],
      ['commands/fixtures/run.md', 1],
      ['skills/my-skill/docs/notes.md', 0],
      ['skills/docs/tests/case.md', 0],
    ])('treats %s as exit %i', (file, expected) => {
      const work = fixture()
      commitPluginPathChange(work, 'claude-only', file, '# body\n')
      expect(runScriptCapture(CHECK_SKILL_VERSION, work).code).toBe(expected)
    })

    it('fails when the changed paths cannot be listed', () => {
      const work = fixture()
      git('git checkout -q --orphan unrelated', work)
      git('git -c user.email=t@t -c user.name=t commit -q -m unrelated', work)
      const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).not.toBe(0)
      expect(stderr).toContain('no merge base')
    })

    // A catalogue reached through a symlink is not in the tree under its own path, so
    // reading it as absent would silently skip the gate.
    it.each(['directory', 'file'] as const)('rejects a Claude catalogue behind a symlinked %s', (kind) => {
      const work = fixture()
      const bytes = claudeCatalogueBytes('claude-only', '1.0.0')
      fs.rmSync(path.join(work, '.claude-plugin'), { recursive: true })
      if (kind === 'directory') {
        fs.mkdirSync(path.join(work, 'claude-config'))
        fs.writeFileSync(path.join(work, 'claude-config', 'marketplace.json'), bytes)
        fs.symlinkSync('claude-config', path.join(work, '.claude-plugin'))
      } else {
        fs.mkdirSync(path.join(work, '.claude-plugin'))
        fs.writeFileSync(path.join(work, 'claude-catalogue.json'), bytes)
        fs.symlinkSync('../claude-catalogue.json', path.join(work, '.claude-plugin', 'marketplace.json'))
      }
      commitSkillChange(work, 'claude-only', '# changed\n')
      const { code, stdout } = runScriptCapture(CHECK_SKILL_VERSION, work)
      expect(code).toBe(1)
      expect(stdout).toContain('.claude-plugin/marketplace.json is a symlink or sits under one')
    })

    it('uses the committed catalogue rather than a dirty bump locally and with an explicit base', () => {
      const work = fixture()
      commitSkillChange(work, 'claude-only', '# changed\n')
      writeClaudeCatalogue(work, claudeCatalogueBytes('claude-only', '1.1.0'))

      const local = runScriptCapture(CHECK_SKILL_VERSION, work)
      const ci = runScriptCapture(CHECK_SKILL_VERSION, work, {
        ...CLEAN_ENV,
        CHECK_SKILL_VERSION_BASE: 'HEAD^',
      })
      for (const result of [local, ci]) {
        expect(result.code).toBe(1)
        expect(result.stdout).toContain('.claude-plugin/marketplace.json')
      }
    })
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

  it.each([
    'omp/index.ts',
    'hooks/preflight.ts',
    'engine/runner.ts',
    'roxabi/profile.ts',
    'agents/reviewer.md',
    'agent-sources/reviewer.md',
    'dist/contracts.js',
    'triage-runtime.ts',
    '.claude-plugin/plugin.json',
    '.omp-plugin/plugin.json',
    'package.json',
  ])('exits 1 when distributed runtime path %s changes without an OMP catalogue bump', (runtimePath) => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    commitPluginPathChange(work, 'omp-build', runtimePath, `runtime change at ${runtimePath}\n`)

    expect(runScript(CHECK_SKILL_VERSION, work)).toBe(1)
  })

  it('exits 0 when an OMP extension changes with a matching catalogue bump', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    bumpCatalogueEntry(work, 'omp-build', '0.8.0')
    commitPluginPathChange(work, 'omp-build', 'omp/index.ts', 'export const extension = true\n')

    expect(runScript(CHECK_SKILL_VERSION, work)).toBe(0)
  })

  it('exits 0 for root/docs/test/fixture-only changes', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    fs.writeFileSync(path.join(work, 'README.md'), '# root documentation\n')
    fs.writeFileSync(path.join(work, 'plugins', 'omp-build', 'README.md'), '# plugin documentation\n')
    fs.mkdirSync(path.join(work, 'plugins', 'omp-build', 'testing'), { recursive: true })
    fs.writeFileSync(path.join(work, 'plugins', 'omp-build', 'testing', 'runtime.test.ts'), 'export {}\n')
    fs.mkdirSync(path.join(work, 'plugins', 'omp-build', 'fixtures'), { recursive: true })
    fs.writeFileSync(path.join(work, 'plugins', 'omp-build', 'fixtures', 'runtime.json'), '{}\n')
    fs.mkdirSync(path.join(work, 'plugins', 'omp-build', 'skills', 'helpers', '__fixtures__'), { recursive: true })
    fs.writeFileSync(
      path.join(work, 'plugins', 'omp-build', 'skills', 'helpers', '__fixtures__', 'fixture.json'),
      '{}\n',
    )
    fs.mkdirSync(path.join(work, 'plugins', 'omp-build', 'skills', 'helpers', '__tests__'), { recursive: true })
    fs.writeFileSync(
      path.join(work, 'plugins', 'omp-build', 'skills', 'helpers', '__tests__', 'fixture.test.ts'),
      'export {}\n',
    )
    git('git add -A', work)
    git('git -c user.email=t@t -c user.name=t commit -q -m "documentation and fixture updates"', work)

    expect(runScript(CHECK_SKILL_VERSION, work)).toBe(0)
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
      pluginName: 'sha-plugin',
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.3.0' },
    })
    workDir = work
    bareDir = bare
    commitSkillChange(work, 'sha-plugin', '# skill v2 (sha plugin.json, stale catalogue)\n')

    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('sha-plugin')
    expect(stdout).toContain('still 0.3.0')
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stdout).not.toContain('9.9.9')
    expect(stderr).toContain('SKIP: sha-plugin takes its Claude version from the commit SHA')
  })

  it('exits 0 and keeps the SHA-based SKIP when plugin.json has no version and the catalogue entry is bumped', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'sha-plugin',
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.3.0' },
    })
    workDir = work
    bareDir = bare
    bumpCatalogueEntry(work, 'sha-plugin', '0.4.0')
    commitSkillChange(work, 'sha-plugin', '# skill v2 (sha plugin.json, catalogue bumped)\n')

    const { code, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(0)
    expect(stderr).toContain('SKIP: sha-plugin takes its Claude version from the commit SHA')
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

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \t\n'],
    [
      'a second JSON value',
      `${JSON.stringify({
        name: 'fixture-marketplace',
        plugins: [{ name: 'omp-build', version: '0.7.0' }],
      })}${JSON.stringify({
        name: 'fixture-marketplace',
        plugins: [{ name: 'omp-build', version: '0.8.0' }],
      })}`,
    ],
    [
      'a leading BOM',
      `\uFEFF${JSON.stringify({
        name: 'fixture-marketplace',
        plugins: [{ name: 'omp-build', version: '0.8.0' }],
      })}`,
    ],
    ['NaN', '{"plugins":[{"name":"omp-build","version":"0.8.0"}],"x":NaN}'],
    ['Infinity', '{"plugins":[{"name":"omp-build","version":"0.8.0"}],"x":Infinity}'],
    ['a leading plus', '{"plugins":[{"name":"omp-build","version":"0.8.0"}],"x":+1}'],
    [
      'a trailing newline in the version',
      JSON.stringify({
        plugins: [{ name: 'omp-build', version: '0.8.0\n' }],
      }),
    ],
    [
      'an embedded newline in the version',
      JSON.stringify({
        plugins: [{ name: 'omp-build', version: '0.7.0\nbad!!' }],
      }),
    ],
    [
      'a version split across a newline',
      JSON.stringify({
        plugins: [{ name: 'omp-build', version: '0.7.\n.0' }],
      }),
    ],
    [
      'a v-prefixed version',
      JSON.stringify({
        plugins: [{ name: 'omp-build', version: 'v0.8.0' }],
      }),
    ],
  ])('exits 1 naming the catalogue when HEAD catalogue is %s', (_label, bytes) => {
    expectRejectedCatalogue(bytes, 'head')
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \t\n'],
    [
      'a second JSON value',
      `${JSON.stringify({
        plugins: [{ name: 'omp-build', version: '0.7.0' }],
      })}${JSON.stringify({
        plugins: [{ name: 'omp-build', version: '0.8.0' }],
      })}`,
    ],
    [
      'a leading BOM',
      `\uFEFF${JSON.stringify({
        plugins: [{ name: 'omp-build', version: '0.7.0' }],
      })}`,
    ],
    ['NaN', '{"plugins":[{"name":"omp-build","version":"0.7.0"}],"x":NaN}'],
    [
      'a trailing newline in the version',
      JSON.stringify({
        plugins: [{ name: 'omp-build', version: '0.7.0\n' }],
      }),
    ],
  ])('exits 1 naming the catalogue when origin/main catalogue is %s and HEAD is a bumped semver', (_label, bytes) => {
    expectRejectedCatalogue(bytes, 'base')
  })

  it.each([
    ['a prerelease', '0.8.0-rc.1'],
    ['build metadata only', '0.8.0+build.1'],
    ['a downgrade', '0.7.9'],
  ])('exits 1 naming the catalogue when the version change is %s', (_label, version) => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.8.0' },
    })
    workDir = work
    bareDir = bare
    writeCatalogue(work, catalogueBytes(version))
    commitSkillChange(work, 'omp-build', '# skill v2 (not an upgrade)\n')

    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stderr).not.toMatch(/SKIP: omp-build has no version in/)
  })

  it.each(['head', 'base'] as const)('exits 1 naming the catalogue when a trailing NUL is on %s', (side) => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    const nul = Buffer.concat([Buffer.from(catalogueBytes(side === 'head' ? '0.8.0' : '0.7.0')), Buffer.from([0])])
    fs.writeFileSync(path.join(work, '.omp-plugin', 'marketplace.json'), nul)
    if (side === 'base') {
      pushAsMain(work, 'nul on base')
      writeCatalogue(work, catalogueBytes('0.8.0'))
    }
    commitSkillChange(work, 'omp-build', '# skill v2 (nul catalogue)\n')

    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stderr).not.toMatch(/SKIP: omp-build has no version in/)
  })

  it('exits 1 naming the catalogue when jq is absent and the catalogue does not parse', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    fs.writeFileSync(path.join(work, '.omp-plugin', 'marketplace.json'), '{not json')
    commitSkillChange(work, 'omp-build', '# skill v2 (no jq)\n')
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-no-jq-'))
    for (const tool of ['bash', 'git', 'bun', 'sed', 'sort', 'timeout']) {
      const src = execFileSync('which', [tool], { encoding: 'utf8', env: CLEAN_ENV }).trim()
      fs.symlinkSync(src, path.join(bin, tool))
    }

    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work, {
      ...CLEAN_ENV,
      PATH: bin,
    })

    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stderr).not.toMatch(/SKIP: check-skill-version requires jq/)
    fs.rmSync(bin, { recursive: true, force: true })
  })

  it('exits 1 naming the catalogue when fetch fails and a stale origin/main remains', () => {
    const { work, bare } = setupOriginWithPlugin({
      pluginName: 'omp-build',
      pluginJson: false,
      catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
    })
    workDir = work
    bareDir = bare
    writeCatalogue(work, catalogueBytes('0.8.0'))
    commitSkillChange(work, 'omp-build', '# skill v2 (stale base)\n')
    git('git remote set-url origin /nonexistent/gate-fetch-fail', work)

    const { code, stdout, stderr } = runScriptCapture(CHECK_SKILL_VERSION, work)

    expect(code).toBe(1)
    expect(stdout).toContain('.omp-plugin/marketplace.json')
    expect(stderr).not.toMatch(/origin\/main unreachable/)
  })

  describe('with CHECK_SKILL_VERSION_BASE (CI)', () => {
    const ci = (work: string, base: string) =>
      runScriptCapture(CHECK_SKILL_VERSION, work, { ...CLEAN_ENV, CHECK_SKILL_VERSION_BASE: base })
    const head = (work: string) =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, env: CLEAN_ENV, encoding: 'utf8' }).trim()

    function setupFoo(): string {
      const { work, bare } = setupOriginWithPlugin({
        pluginName: 'foo',
        version: '1.0.0',
        catalogue: { documentVersion: '9.9.9', entryVersion: '0.7.0' },
      })
      workDir = work
      bareDir = bare
      return work
    }

    function commitBump(work: string, version: string, entryVersion: string, skillFile: string): void {
      fs.writeFileSync(path.join(work, 'plugins', 'foo', '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
      bumpCatalogueEntry(work, 'foo', entryVersion)
      commitPluginPathChange(work, 'foo', `skills/${skillFile}`, `# ${skillFile} ${version}\n`)
    }

    // The merge ref CI checks out for a pull request: the base tip first, the PR head second.
    function checkoutMergeRef(work: string, baseTip: string, prHead: string): void {
      git(`git checkout -q --detach ${baseTip}`, work)
      git(`git -c user.email=t@t -c user.name=t merge -q --no-ff --no-edit ${prHead}`, work)
    }

    it('exits 1 for a PR whose bump collides with a version that already landed', () => {
      const work = setupFoo()
      const start = head(work)
      commitBump(work, '1.0.1', '0.7.1', 'my-skill.md')
      const landed = head(work)
      git(`git checkout -q --detach ${start}`, work)
      commitBump(work, '1.0.1', '0.7.1', 'other.md')
      checkoutMergeRef(work, landed, head(work))

      const { code, stdout } = ci(work, 'HEAD^1')

      expect(code).toBe(1)
      expect(stdout).toContain('foo: distributed runtime changed without version bump (still 1.0.1)')
      expect(stdout).toContain('(still 0.7.1) — bump .omp-plugin/marketplace.json')
    })

    it('exits 0 for a PR that bumps both surfaces above its base', () => {
      const work = setupFoo()
      const start = head(work)
      commitBump(work, '1.0.1', '0.7.1', 'my-skill.md')
      checkoutMergeRef(work, start, head(work))

      expect(ci(work, 'HEAD^1').code).toBe(0)
    })

    it('compares with the given base even when origin/main is unreachable', () => {
      const work = setupFoo()
      commitSkillChange(work, 'foo', '# skill v2 (no bump)\n')
      git('git remote remove origin', work)

      const { code, stdout, stderr } = ci(work, 'HEAD^1')

      expect(code).toBe(1)
      expect(stdout).toContain('(still 1.0.0)')
      expect(stderr).not.toMatch(/origin\/main unreachable/)
    })

    it('reads the Claude version from HEAD, not an uncommitted worktree bump', () => {
      const { work, bare } = setupOriginWithPlugin({ pluginName: 'foo', version: '1.0.0' })
      workDir = work
      bareDir = bare
      commitSkillChange(work, 'foo', '# skill v2 (no bump)\n')
      fs.writeFileSync(
        path.join(work, 'plugins', 'foo', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ version: '1.0.1' }),
      )

      const { code, stdout } = ci(work, 'HEAD^1')

      expect(code).toBe(1)
      expect(stdout).toContain('foo: distributed runtime changed without version bump (still 1.0.0)')
    })

    // Claude plugins may symlink files inside the repository: the manifest is what a checkout reads.
    function commitLinkedManifest(
      work: string,
      link: string,
      files: Record<string, string>,
      links: Record<string, string>,
    ): void {
      const pluginDir = path.join(work, 'plugins', 'foo')
      for (const [name, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(pluginDir, name)), { recursive: true })
        fs.writeFileSync(path.join(pluginDir, name), body)
      }
      for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(pluginDir, name))
      fs.rmSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'))
      fs.symlinkSync(link, path.join(pluginDir, '.claude-plugin', 'plugin.json'))
      commitSkillChange(work, 'foo', '# skill v2 (linked manifest)\n')
    }

    const v = (version: string) => JSON.stringify({ version })
    // current -> releases/v1 (tracked), so current/.. is releases/, not the plugin root decoy.
    const viaCurrent = (intended: string, decoy: string) => ({
      'releases/v1/keep.txt': 'keep\n',
      'releases/manifest.json': v(intended),
      'manifest.json': v(decoy),
    })
    const releases = { current: 'releases/v1' }
    const unresolved = 'foo: cannot resolve HEAD:plugins/foo/.claude-plugin/plugin.json'

    it.each([
      ['../manifest.json, unchanged', '../manifest.json', { 'manifest.json': v('1.0.0') }, {}, 1, '(still 1.0.0)'],
      ['../manifest.json, bumped', '../manifest.json', { 'manifest.json': v('1.0.1') }, {}, 0, ''],
      ['./real.json, unchanged', './real.json', { '.claude-plugin/real.json': v('1.0.0') }, {}, 1, '(still 1.0.0)'],
      [
        'current/.., unchanged',
        '../current/../manifest.json',
        viaCurrent('1.0.0', '1.0.1'),
        releases,
        1,
        '(still 1.0.0)',
      ],
      ['current/.., bumped', '../current/../manifest.json', viaCurrent('1.0.1', '1.0.0'), releases, 0, ''],
      ['a dangling target', '../missing.json', {}, {}, 1, unresolved],
      ['a target outside the repository', '../../../../outside.json', {}, {}, 1, unresolved],
    ])('plugin.json linked through %s', (_case, link, files, links, expected, message) => {
      const { work, bare } = setupOriginWithPlugin({ pluginName: 'foo', version: '1.0.0' })
      workDir = work
      bareDir = bare
      commitLinkedManifest(work, link, files, links)

      const { code, stdout, stderr } = ci(work, 'HEAD^1')

      expect(code).toBe(expected)
      expect(stdout).toContain(message)
      expect(stderr).not.toMatch(/SKIP: foo (has no Claude manifest|takes its Claude version from the commit SHA)/)
    })

    it('keeps the visible SKIP when plugin.json is absent', () => {
      const { work, bare } = setupOriginWithPlugin({ pluginName: 'foo', version: '1.0.0' })
      workDir = work
      bareDir = bare
      fs.rmSync(path.join(work, 'plugins', 'foo', '.claude-plugin', 'plugin.json'))
      commitSkillChange(work, 'foo', '# skill v2 (manifest removed)\n')

      const { code, stderr } = ci(work, 'HEAD^1')

      expect(code).toBe(0)
      expect(stderr).toContain('SKIP: foo has no Claude manifest or local catalogue row')
    })

    // .claude-plugin itself is a link: once the directory resolves, plugin.json is an optional leaf.
    it.each([
      [
        'without plugin.json',
        'config',
        { 'config/README.md': '# config\n' },
        0,
        'SKIP: foo has no Claude manifest or local catalogue row',
      ],
      ['with an unchanged plugin.json', 'config', { 'config/plugin.json': v('1.0.0') }, 1, '(still 1.0.0)'],
      ['to a missing directory', 'nowhere', {}, 1, unresolved],
    ])('.claude-plugin linked to a directory %s', (_case, link, files, expected, message) => {
      const { work, bare } = setupOriginWithPlugin({ pluginName: 'foo', version: '1.0.0' })
      workDir = work
      bareDir = bare
      const pluginDir = path.join(work, 'plugins', 'foo')
      fs.rmSync(path.join(pluginDir, '.claude-plugin'), { recursive: true })
      for (const [name, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(pluginDir, name)), { recursive: true })
        fs.writeFileSync(path.join(pluginDir, name), body)
      }
      fs.symlinkSync(link, path.join(pluginDir, '.claude-plugin'))
      commitSkillChange(work, 'foo', '# skill v2 (linked config dir)\n')

      const { code, stdout, stderr } = ci(work, 'HEAD^1')

      expect(code).toBe(expected)
      expect(`${stdout}${stderr}`).toContain(message)
    })

    it('exits 1 when plugin.json exists but is a directory', () => {
      const { work, bare } = setupOriginWithPlugin({ pluginName: 'foo', version: '1.0.0' })
      workDir = work
      bareDir = bare
      const manifest = path.join(work, 'plugins', 'foo', '.claude-plugin', 'plugin.json')
      fs.rmSync(manifest)
      fs.mkdirSync(manifest)
      fs.writeFileSync(path.join(manifest, 'version'), '1.0.0\n')
      commitSkillChange(work, 'foo', '# skill v2 (manifest is a directory)\n')

      const { code, stdout } = ci(work, 'HEAD^1')

      expect(code).toBe(1)
      expect(stdout).toContain(unresolved)
    })

    it.each([
      ['does not resolve to a commit', 'no-such-base'],
      ['is set but empty', ''],
    ])('exits 1 when the base %s', (_case, base) => {
      const work = setupFoo()
      commitSkillChange(work, 'foo', '# skill v2 (no bump)\n')
      git('git remote remove origin', work)

      const { code, stdout, stderr } = ci(work, base)

      expect(code).toBe(1)
      expect(stdout).toContain(`cannot resolve CHECK_SKILL_VERSION_BASE='${base}' to a commit`)
      expect(stderr).not.toMatch(/SKIP/)
    })
  })
})
