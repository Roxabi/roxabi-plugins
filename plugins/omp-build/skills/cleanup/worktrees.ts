#!/usr/bin/env bun
import { rmdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { inventory } from './worktree-inventory'
import { git, message, type Options, type Report, type Row } from './worktree-shared'

function applyValue(options: Options, key: string, value: string) {
  switch (key) {
    case '--repo':
      options.repos.push(value)
      break
    case '--root':
      options.roots.push(value)
      break
    case '--scope':
      options.scope = value.replace(/^#/, '')
      break
    case '--path':
      options.target = value
      break
    case '--expect':
      options.expect = value
      break
    case '--confirm':
      options.confirm = value
      break
    case '--ack-unknown-usage':
      options.ackUnknownUsage = value
      break
    default:
      throw new Error(`unknown argument: ${key}`)
  }
}
function validateOptions(options: Options) {
  if (options.scope !== undefined && !/^[1-9][0-9]*$/.test(options.scope))
    throw new Error('--scope requires a positive issue number')
  if (options.repos.length && options.roots.length) throw new Error('choose --repo or --root, not both')
  if (options.command === 'inventory') {
    if (options.target || options.expect || options.confirm || options.ackUnknownUsage)
      throw new Error('removal options require remove')
    return
  }
  if (
    options.repos.length !== 1 ||
    options.roots.length ||
    options.scope ||
    !options.target ||
    !options.expect ||
    !options.confirm
  )
    throw new Error('remove requires exactly --repo REPO --path PATH --expect TOKEN --confirm PATH')
  if (!isAbsolute(options.target) || options.target !== options.confirm)
    throw new Error('--path must be absolute and --confirm must exactly match it')
  if (options.ackUnknownUsage && options.ackUnknownUsage !== options.target)
    throw new Error('--ack-unknown-usage must exactly match --path')
}
function consumeOption(options: Options, args: string[], seen: Set<string>, key: string) {
  if (seen.has(key) && key !== '--repo' && key !== '--root') throw new Error(`duplicate ${key}`)
  seen.add(key)
  if (key === '--json') {
    options.json = true
    return
  }
  if (key === '--all' || key === '--report-only') {
    if (options.command !== 'inventory') throw new Error(`${key} is only valid for inventory`)
    if (key === '--all') options.roots.push(process.cwd())
    return
  }
  if (!['--repo', '--root', '--scope', '--path', '--expect', '--confirm', '--ack-unknown-usage'].includes(key))
    throw new Error(`unknown argument: ${key}`)
  const value = args.shift()
  if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
  applyValue(options, key, value)
}
function parseArgs(args: string[]): Options {
  let commandName: Options['command'] = 'inventory'
  if (args[0] === 'inventory' || args[0] === 'remove') commandName = args.shift() as Options['command']
  const options: Options = { command: commandName, repos: [], roots: [], json: false }
  const seen = new Set<string>()
  while (args.length) {
    const key = args.shift()
    if (key === undefined) break
    consumeOption(options, args, seen, key)
  }
  validateOptions(options)
  return options
}
function renderUsageWarnings(rows: Row[]) {
  const processes = new Map<string, { name: string; observations: Set<string> }>()
  const other = new Set<string>()
  for (const row of rows) {
    for (const warning of row.warnings) {
      const match = warning.match(/^(?:(\d+) (.*?) (?:cwd|fd \d+):|\/proc\/(\d+):)/)
      if (!match) {
        other.add(warning)
        continue
      }
      const pid = match[1] || match[3]
      const entry = processes.get(pid) || { name: '', observations: new Set<string>() }
      if (match[2]) entry.name = match[2]
      entry.observations.add(warning)
      processes.set(pid, entry)
    }
  }
  for (const [pid, entry] of processes) {
    const label = entry.name ? `${pid} ${entry.name}` : pid
    console.log(`Uninspected: ${label} (${entry.observations.size} denied observations; details in --json)`)
  }
  for (const warning of other) console.log(`Uninspected: ${warning}`)
}
function render(report: Report, json: boolean) {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log('PATH\tKIND\tBRANCH\tACTIVITY\tELIGIBLE\tREASONS\tTOKEN')
  for (const row of report.worktrees) {
    console.log(
      [
        JSON.stringify(row.path),
        row.kind,
        row.branch || '-',
        row.activity,
        row.eligible ? 'yes' : 'no',
        row.reasons.join('; ') || '-',
        row.token,
      ].join('\t'),
    )
    if (row.requiresUsageConfirmation)
      console.log(`  Usage inspection incomplete; additional confirmation required: ${JSON.stringify(row.path)}`)
    for (const evidence of row.usageEvidence) console.log(`  Usage: ${evidence}`)
  }
  renderUsageWarnings(report.worktrees)
  console.log(
    `Discovery excludes directories: ${report.discoveryExclusions.directoryNames.join(', ')}; symlinks are not followed`,
  )
  for (const error of report.errors) console.error(`${error.path}: ${error.message}`)
}
function removeTarget(options: Options, report: Report): string {
  if (report.errors.some((error) => error.scope === 'repository' || error.scope === undefined))
    throw new Error('repository inventory incomplete; resolve repository errors before removal')
  const row = report.worktrees.find((item) => item.path === options.target)
  if (!row) throw new Error('target not found in fresh inventory; select an exact reported path')
  if (!row.eligible) throw new Error(`target is protected: ${row.reasons.join('; ')}`)
  if (!['registered', 'detached'].includes(row.kind) && report.errors.some((error) => error.scope === 'orphan-scan'))
    throw new Error('orphan scanner failed; resolve the scanner error before removing an orphan')
  if (row.token !== options.expect)
    throw new Error('inventory token is stale; inventory again and select the target afresh')
  if (row.requiresUsageConfirmation && options.ackUnknownUsage !== row.path)
    throw new Error('process inspection incomplete; explicit --ack-unknown-usage EXACT_PATH is required')
  if (!row.requiresUsageConfirmation && options.ackUnknownUsage)
    throw new Error('--ack-unknown-usage is unnecessary: fresh process inspection is complete')
  if (row.kind === 'registered' || row.kind === 'detached') git(options.repos[0], 'worktree', 'remove', '--', row.path)
  else if (row.kind === 'empty_parent' || row.kind === 'empty_untracked') rmdirSync(row.path)
  else throw new Error('unsupported target classification')
  return row.path
}
function main() {
  let options: Options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(message(e))
    process.exitCode = 2
    return
  }
  const report = inventory(options)
  if (options.command === 'inventory') {
    render(report, options.json)
    if (report.errors.length) process.exitCode = 1
    return
  }
  try {
    const path = removeTarget(options, report)
    if (options.json) console.log(JSON.stringify({ removed: path }))
    else console.log(`Removed worktree directory: ${path}`)
  } catch (e) {
    if (options.json) console.log(JSON.stringify({ error: message(e), errors: report.errors }))
    else {
      console.error(message(e))
      for (const error of report.errors) console.error(`${error.path}: ${error.message}`)
    }
    process.exitCode = 1
  }
}
main()
