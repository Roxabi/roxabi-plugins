/**
 * Scaffold dev-core configuration files.
 * Handles .env merge, .env.example, run-dashboard.ts launcher, artifacts dirs, .gitignore.
 */

const fs = require('fs')

export interface ScaffoldOpts {
  githubRepo: string
  projectId: string
  statusFieldId: string
  sizeFieldId: string
  priorityFieldId: string
  statusOptionsJson: string
  sizeOptionsJson: string
  priorityOptionsJson: string
  vercelToken?: string
  vercelProjectId?: string
  vercelTeamId?: string
  force: boolean
}

export interface ScaffoldResult {
  envWritten: boolean
  envExampleWritten: boolean
  shimWritten: boolean
  shimPath: string
  artifactsCreated: boolean
  gitignoreUpdated: boolean
  envVarCount: number
}

interface EnvSection {
  header: string
  vars: Array<{ key: string; value: string; comment?: string }>
}

function buildDevCoreSections(opts: ScaffoldOpts): EnvSection[] {
  const sections: EnvSection[] = [
    {
      header: '# --- dev-core: GitHub Project V2 ---',
      vars: [
        { key: 'GITHUB_REPO', value: opts.githubRepo },
        { key: 'PROJECT_ID', value: opts.projectId },
        { key: 'STATUS_FIELD_ID', value: opts.statusFieldId },
        { key: 'SIZE_FIELD_ID', value: opts.sizeFieldId },
        { key: 'PRIORITY_FIELD_ID', value: opts.priorityFieldId },
      ],
    },
    {
      header: '# --- dev-core: Field option IDs (auto-detected by /init) ---',
      vars: [
        { key: 'STATUS_OPTIONS_JSON', value: opts.statusOptionsJson },
        { key: 'SIZE_OPTIONS_JSON', value: opts.sizeOptionsJson },
        { key: 'PRIORITY_OPTIONS_JSON', value: opts.priorityOptionsJson },
      ],
    },
  ]

  // Vercel section
  const vercelVars: EnvSection['vars'] = [
    { key: 'VERCEL_TOKEN', value: opts.vercelToken ?? '' },
    { key: 'VERCEL_PROJECT_ID', value: opts.vercelProjectId ?? '' },
    { key: 'VERCEL_TEAM_ID', value: opts.vercelTeamId ?? '' },
  ]

  if (opts.vercelToken || opts.vercelProjectId) {
    sections.push({ header: '# --- dev-core: Vercel ---', vars: vercelVars })
  } else {
    sections.push({
      header: '# --- dev-core: Vercel (optional) ---',
      vars: vercelVars.map((v) => ({ ...v, comment: '# ' })),
    })
  }

  return sections
}

const DEV_CORE_KEYS = new Set([
  'GITHUB_REPO', 'PROJECT_ID',
  'STATUS_FIELD_ID', 'SIZE_FIELD_ID', 'PRIORITY_FIELD_ID',
  'STATUS_OPTIONS_JSON', 'SIZE_OPTIONS_JSON', 'PRIORITY_OPTIONS_JSON',
  'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID',
])

export function mergeEnv(existing: string, sections: EnvSection[], force: boolean): string {
  // Remove existing dev-core lines
  const lines = existing.split('\n')
  const filtered: string[] = []
  let inDevCoreBlock = false

  for (const line of lines) {
    if (line.startsWith('# --- dev-core:')) {
      inDevCoreBlock = true
      continue
    }
    if (inDevCoreBlock) {
      const trimmed = line.trim()
      // Still in block if it's a var we own, a comment, or empty
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0 && DEV_CORE_KEYS.has(trimmed.slice(0, eq))) continue
      // Line doesn't belong to dev-core — end of block
      inDevCoreBlock = false
    }
    filtered.push(line)
  }

  // Remove trailing empty lines
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
    filtered.pop()
  }

  // If not force, check for existing non-block dev-core vars
  if (!force) {
    const existingVars = new Map<string, string>()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) existingVars.set(trimmed.slice(0, eq), trimmed.slice(eq + 1))
    }
    // Don't overwrite values that already exist
    for (const section of sections) {
      for (const v of section.vars) {
        const existing = existingVars.get(v.key)
        if (existing !== undefined && existing !== '') {
          v.value = existing
        }
      }
    }
  }

  // Build dev-core block
  const devCoreLines: string[] = []
  for (const section of sections) {
    devCoreLines.push('', section.header)
    for (const v of section.vars) {
      if (v.comment) {
        devCoreLines.push(`${v.comment}${v.key}=${v.value}`)
      } else {
        devCoreLines.push(`${v.key}=${v.value}`)
      }
    }
  }

  return [...filtered, ...devCoreLines, ''].join('\n')
}

function generateEnvExample(_opts: ScaffoldOpts): string {
  const lines = [
    '# --- dev-core: GitHub Project V2 ---',
    '# Run /init to auto-detect these values',
    'GITHUB_REPO=owner/repo',
    'PROJECT_ID=PVT_...',
    'STATUS_FIELD_ID=PVTSSF_...',
    'SIZE_FIELD_ID=PVTSSF_...',
    'PRIORITY_FIELD_ID=PVTSSF_...',
    '',
    '# --- dev-core: Field option IDs (auto-detected by /init) ---',
    'STATUS_OPTIONS_JSON={}',
    'SIZE_OPTIONS_JSON={}',
    'PRIORITY_OPTIONS_JSON={}',
    '',
    '# --- dev-core: Vercel (optional — for dashboard deployments panel) ---',
    'VERCEL_TOKEN=',
    'VERCEL_PROJECT_ID=',
    'VERCEL_TEAM_ID=',
    '',
    '# --- dev-core: GitHub token (optional — falls back to `gh auth token`) ---',
    'GITHUB_TOKEN=',
    '',
  ]
  return lines.join('\n')
}

export function mergeEnvExample(existing: string, newBlock: string): string {
  const lines = existing.split('\n')
  const filtered: string[] = []
  let inDevCoreBlock = false

  for (const line of lines) {
    if (line.startsWith('# --- dev-core:')) {
      inDevCoreBlock = true
      continue
    }
    if (inDevCoreBlock) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0 && DEV_CORE_KEYS.has(trimmed.slice(0, eq))) continue
      inDevCoreBlock = false
    }
    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
    filtered.pop()
  }

  const prefix = filtered.length > 0 ? filtered.join('\n') + '\n\n' : ''
  return prefix + newBlock
}

const SHIM_CONTENT = `#!/bin/sh
# Installed by dev-core /init — do not edit.
# Auto-resolves the latest active dev-core plugin cache.
BASE="$HOME/.claude/plugins/cache/roxabi-marketplace/dev-core"
LATEST=""
for d in $(ls -t "$BASE" 2>/dev/null); do
  case "$d" in .*) continue ;; esac
  [ -f "$BASE/$d/.orphaned_at" ] && continue
  LATEST="$d" && break
done
if [ -z "$LATEST" ]; then
  echo "dev-core plugin not found. Run: claude plugin install dev-core" >&2
  exit 1
fi
exec bun "$BASE/$LATEST/cli/index.ts" "$@"
`

function resolveShimPath(): string {
  const home = require('os').homedir()
  // Prefer ~/.local/bin if it exists (standard XDG user bin), else ~/bin
  const localBin = `${home}/.local/bin`
  const homeBin = `${home}/bin`
  if (fs.existsSync(localBin)) return `${localBin}/roxabi`
  if (fs.existsSync(homeBin)) return `${homeBin}/roxabi`
  return `${localBin}/roxabi` // will be created
}

function writeShim(): { written: boolean; path: string } {
  const shimPath = resolveShimPath()
  try {
    const dir = shimPath.substring(0, shimPath.lastIndexOf('/'))
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.writeFileSync(shimPath, SHIM_CONTENT, { mode: 0o755 })
    return { written: true, path: shimPath }
  } catch {
    return { written: false, path: shimPath }
  }
}

export async function scaffold(opts: ScaffoldOpts): Promise<ScaffoldResult> {
  const result: ScaffoldResult = {
    envWritten: false,
    envExampleWritten: false,
    shimWritten: false,
    shimPath: '',
    artifactsCreated: false,
    gitignoreUpdated: false,
    envVarCount: 0,
  }

  const sections = buildDevCoreSections(opts)

  // .env
  const existingEnv = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : ''
  const newEnv = mergeEnv(existingEnv, sections, opts.force)
  fs.writeFileSync('.env', newEnv)
  result.envWritten = true
  result.envVarCount = sections.reduce((acc, s) => acc + s.vars.length, 0)

  // .env.example
  const existingEnvExample = fs.existsSync('.env.example') ? fs.readFileSync('.env.example', 'utf8') : ''
  const envExample = mergeEnvExample(existingEnvExample, generateEnvExample(opts))
  fs.writeFileSync('.env.example', envExample)
  result.envExampleWritten = true

  // roxabi shim
  const shim = writeShim()
  result.shimWritten = shim.written
  result.shimPath = shim.path

  // artifacts/
  for (const dir of ['artifacts/frames', 'artifacts/analyses', 'artifacts/specs', 'artifacts/plans']) {
    fs.mkdirSync(dir, { recursive: true })
  }
  result.artifactsCreated = true

  // .gitignore
  try {
    const gitignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : ''
    if (!gitignore.split('\n').some((l: string) => l.trim() === '.env')) {
      fs.appendFileSync('.gitignore', '\n.env\n')
      result.gitignoreUpdated = true
    }
  } catch {}

  return result
}
