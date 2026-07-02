'use strict'

/**
 * Shared CommonJS parser for .claude/stack.yml.
 *
 * Consumed by:
 *   - plugins/dev-core/hooks/format.js  (CJS require)
 *   - plugins/dev-core/skills/checkup/doctor.ts  (Bun TS import)
 *
 * Dependency-free: pure regex/string ops — no external YAML library.
 * Behavior-preserving: exact semantics from the three inline parsers it replaces.
 */

/**
 * Parse the `build.formatters:` array from stack.yml text.
 *
 * Expected shape:
 *
 *   build:
 *     formatters:
 *       - cmd: "bunx biome check --write"
 *         ext: [".ts", ".tsx", ".js"]
 *       - cmd: "ruff format"
 *         ext: [".py"]
 *
 * `ext` is optional — null means match all formattable extensions.
 * Returns null when the key is absent or no entries are found.
 *
 * @param {string} text
 * @returns {Array<{cmd: string, ext: string[]|null}>|null}
 */
function parseFormatters(text) {
  if (!text) return null
  const idx = text.indexOf('formatters:')
  if (idx === -1) return null

  // Slice from the formatters: key to EOF
  const block = text.slice(idx + 'formatters:'.length)

  // Split on "- cmd:" to get each entry
  const chunks = block.split(/\n[ \t]*-[ \t]+cmd:/)
  if (chunks.length < 2) return null

  const formatters = []
  for (const chunk of chunks.slice(1)) {
    // First line is the cmd value
    const firstLine = chunk.split('\n')[0]
    let cmd = firstLine.trim()
    if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
      cmd = cmd.slice(1, -1)
    }
    if (!cmd) continue

    // ext: [".ts", ".py"] — inline array on one line
    const extMatch = chunk.match(/\bext:\s*\[([^\]]*)\]/)
    const ext = extMatch
      ? extMatch[1]
          .split(',')
          .map((e) => e.trim().replace(/['"]/g, ''))
          .filter(Boolean)
      : null

    formatters.push({ cmd, ext })
  }

  return formatters.length > 0 ? formatters : null
}

/**
 * Parse the legacy single `build.formatter_fix_cmd` string from stack.yml text.
 * Kept for backward compat with stack.yml files that predate `formatters:`.
 * Returns null when the key is absent.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseSingleFormatterCmd(text) {
  if (!text) return null
  const match = text.match(/^\s*formatter_fix_cmd:\s*(.+?)\s*$/m)
  if (!match) return null
  let val = match[1].trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  return val || null
}

/**
 * Parse `deploy.platform` from stack.yml text.
 * Returns the platform string, or null when absent or set to 'none'.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parsePlatform(text) {
  if (!text) return null
  const match = text.match(/^\s*platform:\s*(\S+)/m)
  if (!match) return null
  const val = match[1]
  return val === 'none' ? null : val
}

/**
 * Parse `frontend.framework` from stack.yml text.
 * Returns the framework string, or null when the `frontend:` section is absent,
 * the `framework:` key is absent, or the value is 'none'.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseFrontendFramework(text) {
  if (!text) return null
  // Find the frontend: section start index
  const frontendMatch = text.match(/^frontend:/m)
  if (!frontendMatch) return null
  // Slice from after `frontend:` up to the next top-level key (line starting with a non-space char)
  const afterFrontend = text.slice(frontendMatch.index + 'frontend:'.length)
  const nextTopLevel = afterFrontend.match(/\n\S/)
  const block = nextTopLevel ? afterFrontend.slice(0, nextTopLevel.index) : afterFrontend
  // Now find framework: within this block only
  const frameworkMatch = block.match(/^\s+framework:\s*(\S+)/m)
  if (!frameworkMatch) return null
  const val = frameworkMatch[1]
  return val === 'none' ? null : val
}

/**
 * Parse `package_manager` from stack.yml text.
 * Returns the package manager string (e.g. 'bun', 'npm', 'pnpm', 'yarn', 'uv'),
 * or null when absent.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parsePackageManager(text) {
  if (!text) return null
  const match = text.match(/^\s*package_manager:\s*(\S+)/m)
  return match ? match[1] : null
}

/**
 * Parse top-level `runtime` from stack.yml text.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseRuntime(text) {
  if (!text) return null
  const match = text.match(/^\s*runtime:\s*(\S+)/m)
  return match ? match[1] : null
}

/**
 * Parse a single `commands.<key>` value from stack.yml text.
 *
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
function parseCommand(text, key) {
  if (!text) return null
  const section = text.match(/^commands:\s*$/m)
  if (!section) return null
  const after = text.slice(section.index + 'commands:'.length)
  const nextTop = after.match(/\n\S/)
  const block = nextTop ? after.slice(0, nextTop.index) : after
  const match = block.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*(#.*)?$`, 'm'))
  if (!match) return null
  let val = match[1].trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  return val || null
}

/**
 * Parse `testing.e2e` from stack.yml text.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseTestingE2e(text) {
  if (!text) return null
  const section = text.match(/^testing:\s*$/m)
  if (!section) return null
  const after = text.slice(section.index + 'testing:'.length)
  const nextTop = after.match(/\n\S/)
  const block = nextTop ? after.slice(0, nextTop.index) : after
  const match = block.match(/^\s+e2e:\s*(\S+)/m)
  if (!match) return null
  const val = match[1]
  return val === 'none' ? null : val
}

/**
 * Parse `ci.merge` strategy from stack.yml text.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseCiMerge(text) {
  if (!text) return null
  const section = text.match(/^ci:\s*$/m)
  if (!section) return null
  const after = text.slice(section.index + 'ci:'.length)
  const nextTop = after.match(/\n\S/)
  const block = nextTop ? after.slice(0, nextTop.index) : after
  const match = block.match(/^\s+merge:\s*(\S+)/m)
  return match ? match[1] : null
}

/**
 * Parse the `standards:` section from stack.yml text.
 * Returns a Record<string, string> mapping standard key → path,
 * or null when the section is absent or empty.
 *
 * Parsing rules (from doctor.ts checkStandardsPaths):
 *   - Section starts at line matching /^standards:\s*$/
 *   - Section ends at the first line with a non-whitespace leading character
 *   - Each entry: /^\s+(\w+):\s*(.+?)(?:\s*#.*)?$/
 *
 * @param {string} text
 * @returns {Record<string, string>|null}
 */
function parseStandards(text) {
  if (!text) return null
  const lines = text.split('\n')
  let inStandards = false
  const standards = {}

  for (const line of lines) {
    if (/^standards:\s*$/.test(line)) {
      inStandards = true
      continue
    }
    if (inStandards) {
      if (/^\S/.test(line)) break // new top-level key — end of section
      const match = line.match(/^\s+(\w+):\s*(.+?)\s*(#.*)?$/)
      if (!match) continue
      const key = match[1]
      const path = match[2].trim()
      if (path) standards[key] = path
    }
  }

  return Object.keys(standards).length > 0 ? standards : null
}

/**
 * Parse a stack.yml text into a structured object.
 *
 * @param {string|null} text - raw stack.yml contents, or null
 * @returns {{
 *   formatters: Array<{cmd: string, ext: string[]|null}>|null,
 *   singleFormatterCmd: string|null,
 *   platform: string|null,
 *   frontend: string|null,
 *   packageManager: string|null,
 *   standards: Record<string, string>|null,
 *   runtime: string|null,
 *   commands: {lint: string|null, typecheck: string|null, test: string|null},
 *   testingE2e: string|null,
 *   ciMerge: string|null
 * }}
 */
function parseStackYml(text) {
  return {
    formatters: parseFormatters(text),
    singleFormatterCmd: parseSingleFormatterCmd(text),
    platform: parsePlatform(text),
    frontend: parseFrontendFramework(text),
    packageManager: parsePackageManager(text),
    standards: parseStandards(text),
    runtime: parseRuntime(text),
    commands: {
      lint: parseCommand(text, 'lint'),
      typecheck: parseCommand(text, 'typecheck'),
      test: parseCommand(text, 'test'),
    },
    testingE2e: parseTestingE2e(text),
    ciMerge: parseCiMerge(text),
  }
}

module.exports = {
  parseStackYml,
  parseFormatters,
  parseSingleFormatterCmd,
  parsePlatform,
  parseFrontendFramework,
  parsePackageManager,
  parseStandards,
  parseRuntime,
  parseCommand,
  parseTestingE2e,
  parseCiMerge,
}
