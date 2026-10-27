import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { FeatureCommandHost, FeatureControl, ParsedFeatureCommand } from './feature-contract.ts'

type FeatureInitHost = Pick<FeatureCommandHost, 'cwd' | 'send' | 'exec' | 'git'>

const CONTROL_BY_WORD: Record<string, FeatureControl> = {
  pause: 'pause',
  abandon: 'abandon',
  new: 'new',
  resume: 'resume',
  'material-decision': 'material-decision',
}

function parseInitCommand(input: string): ParsedFeatureCommand | null {
  if (input !== 'init' && !input.startsWith('init ') && !input.startsWith('init\t')) return null
  const tokens = shellTokens(input)
  if (tokens === null || tokens[0] !== 'init') return { ok: false, reason: 'feature-init-invalid' }
  return { ok: true, control: 'init', args: tokens.slice(1) }
}

function parseMaterialDecision(tokens: string[]): ParsedFeatureCommand {
  const reference = normalizeReference(tokens[1])
  if (reference === null || tokens.length !== 2) {
    return { ok: false, reason: 'feature-material-decision-invalid' }
  }
  return { ok: true, control: 'material-decision', reference }
}

function parseControlCommand(control: FeatureControl, tokens: string[]): ParsedFeatureCommand {
  const reference = normalizeReference(tokens[1])
  if (reference === null || tokens.length !== 2) return { ok: false, reason: 'feature-reference-missing' }
  return { ok: true, control, reference }
}

function parseFeatureReference(args: string, tokens: string[]): ParsedFeatureCommand {
  if (tokens.length === 0) return { ok: false, reason: 'feature-reference-missing' }
  const head = tokens[0] ?? ''
  if (head === 'material-decision') return parseMaterialDecision(tokens)
  const control = CONTROL_BY_WORD[head]
  if (control !== undefined) return parseControlCommand(control, tokens)
  if (tokens.length !== 1) return { ok: true, control: 'select', reference: args.trim() }
  const reference = normalizeReference(head)
  return reference === null
    ? { ok: false, reason: 'feature-reference-invalid' }
    : { ok: true, control: 'select', reference }
}

export function parseFeatureCommand(args: string): ParsedFeatureCommand {
  const trimmed = args.trim()
  return (
    parseInitCommand(trimmed) ??
    parseFeatureReference(
      args,
      trimmed.split(/\s+/).filter((token) => token.length > 0),
    )
  )
}

function normalizeReference(token: string | undefined): string | null {
  if (token === undefined || token.length === 0) return null
  const stripped = token.startsWith('#') ? token.slice(1) : token
  if (stripped.length === 0 || CONTROL_BY_WORD[stripped] !== undefined) return null
  return stripped
}

export type InstalledWatchCommand = {
  args: string[]
  pr: number
}

/** The coordinator's existing `landPr` command, not a reconstructed watcher. */
export function parseInstalledWatchCommand(command: string): InstalledWatchCommand | null {
  const tokens = shellTokens(command)
  if (tokens === null || tokens[0] !== 'bash' || tokens.length < 7) return null
  const script = tokens[1]
  const prText = tokens[2]
  if (script === undefined || !script.startsWith('/') || !script.endsWith('/ci-watch.sh')) return null
  if (prText === undefined || !/^[1-9]\d*$/.test(prText)) return null
  if (tokens[3] !== '--merge-mode' || tokens[4] === undefined || tokens[4].length === 0) return null
  if (tokens[5] !== '--base' || tokens[6] === undefined || tokens[6].length === 0) return null
  if (tokens.length === 7) return { args: tokens.slice(1), pr: Number(prText) }
  if (tokens.length === 9 && tokens[7] === '--since' && tokens[8] !== undefined && tokens[8].length > 0) {
    return { args: tokens.slice(1), pr: Number(prText) }
  }
  return null
}

type ShellToken = { value: string; end: number }

function unquotedToken(input: string, start: number): ShellToken | null {
  const next = input.indexOf(' ', start)
  const value = next === -1 ? input.slice(start) : input.slice(start, next)
  if (value.length === 0 || value.includes("'")) return null
  return { value, end: next === -1 ? input.length : next }
}

function nextTokenStart(input: string, start: number): number {
  let index = start
  while (input[index] === ' ') index += 1
  return index
}

function shellTokens(input: string): string[] | null {
  const tokens: string[] = []
  let index = 0
  while (index < input.length) {
    index = nextTokenStart(input, index)
    if (index >= input.length) break
    const token = input[index] === "'" ? readQuotedToken(input, index) : unquotedToken(input, index)
    if (token === null) return null
    tokens.push(token.value)
    index = token.end
  }
  return tokens
}

function readQuotedToken(input: string, start: number): ShellToken | null {
  if (input[start] !== "'") return null
  let index = start + 1
  let value = ''
  while (index < input.length) {
    if (input.startsWith("'\\''", index)) {
      value += "'"
      index += 4
      continue
    }
    if (input[index] === "'") return { value, end: index + 1 }
    value += input[index]
    index += 1
  }
  return null
}

export async function runTrustedFeatureInit(args: readonly string[], host: FeatureInitHost): Promise<void> {
  const git = host.git ?? defaultFeatureGit
  const captured = await git(['rev-parse', '--show-toplevel'], host.cwd)
  const dir = captured.stdout.trim()
  if (captured.exitCode !== 0 || !dir.startsWith('/')) {
    await host.send('feature-stopped: feature-init-target-unobserved')
    return
  }
  let script: string
  try {
    script = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../skills/feature/feature-init.ts'))
  } catch {
    await host.send('feature-stopped: feature-init-unresolved')
    return
  }
  const result = await host.exec('bun', ['--no-env-file', script, '--dir', dir, ...args], { cwd: dirname(script) })
  if (result.stdout !== undefined && result.stdout.length > 0) await host.send(result.stdout)
  if (result.code !== 0) {
    const detail = result.stderr?.trim()
    await host.send(detail ? `feature-stopped: feature-init-exit\n${detail}` : 'feature-stopped: feature-init-exit')
  }
}

const execGit = promisify(execFile)

async function defaultFeatureGit(args: readonly string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execGit('git', [...args], { cwd, encoding: 'utf8' })
    return { stdout: String(stdout), exitCode: 0 }
  } catch (error) {
    const failed = error as { stdout?: string; code?: number }
    return { stdout: String(failed.stdout ?? ''), exitCode: typeof failed.code === 'number' ? failed.code : 1 }
  }
}
