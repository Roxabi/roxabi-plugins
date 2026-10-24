import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandEvidence } from './feature-init-types'
import { isMap, type YamlMap } from './feature-init-yaml'

function packageRunner(dir: string, pkg: YamlMap | null): string | null {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null
  if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') return declared
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'npm-shrinkwrap.json'))) return 'npm'
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun'
  return null
}

function readPackage(dir: string): YamlMap | null {
  try {
    const doc: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return isMap(doc) ? doc : null
  } catch {
    return null
  }
}

/** Commands require repository evidence; manifests alone never invent flags or a runner. */
function scriptTestCommand(dir: string): CommandEvidence | null {
  const pkg = readPackage(dir)
  const scripts = isMap(pkg?.scripts) ? pkg.scripts : null
  const runner = packageRunner(dir, pkg)
  if (!runner || typeof scripts?.test !== 'string' || !scripts.test.trim()) return null
  return {
    command: runner === 'npm' || runner === 'bun' ? `${runner} run test` : `${runner} test`,
    source: 'package.json scripts.test',
  }
}

function makeTestCommands(dir: string): CommandEvidence[] {
  return ['Makefile', 'makefile']
    .filter((name) => {
      const file = join(dir, name)
      return existsSync(file) && /^test\s*:/m.test(readFileSync(file, 'utf8'))
    })
    .map((name) => ({ command: 'make test', source: name }))
}

function workflowFileTestCommands(file: string, name: string): CommandEvidence[] {
  const out: CommandEvidence[] = []
  let workingDirectory = '.'
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const workdir = line.match(/^\s*working-directory:\s*(\S.*?)\s*$/)
    if (workdir?.[1]) workingDirectory = workdir[1]
    const run = line.match(/^\s*(?:-\s*)?run:\s*(\S.*?)\s*$/)
    const command = run?.[1]
    if (
      command &&
      /(?:^|\s)(?:npm|pnpm|yarn|bun|go|cargo|pytest|make)\b/.test(command) &&
      /\btest\b|pytest/.test(command)
    ) {
      out.push({ command, source: `.github/workflows/${name} (working-directory: ${workingDirectory})` })
    }
  }
  return out
}

function workflowTestCommands(dir: string): CommandEvidence[] {
  const workflows = join(dir, '.github', 'workflows')
  if (!existsSync(workflows)) return []
  return readdirSync(workflows)
    .filter((name) => /\.(?:ya?ml)$/i.test(name))
    .flatMap((name) => workflowFileTestCommands(join(workflows, name), name))
}

function uniqueCommands(candidates: CommandEvidence[]): CommandEvidence[] {
  const seen = new Map<string, Set<string>>()
  return candidates.filter((candidate) => {
    const sources = seen.get(candidate.command) ?? new Set<string>()
    if (sources.has(candidate.source)) return false
    sources.add(candidate.source)
    seen.set(candidate.command, sources)
    return true
  })
}

/** Commands require repository evidence; manifests alone never invent flags or a runner. */
export function discoverTestCommands(dir: string): CommandEvidence[] {
  const script = scriptTestCommand(dir)
  return uniqueCommands([...(script ? [script] : []), ...makeTestCommands(dir), ...workflowTestCommands(dir)])
}
