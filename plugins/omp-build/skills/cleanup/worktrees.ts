#!/usr/bin/env bun
import { rmdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { mountPointsWithin } from './worktree-artifact-trees'
import { applyUsage } from './worktree-inspection'
import { inventory } from './worktree-inventory'
import { render } from './worktree-render'
import { git, message, type Options, type RemovalMode, type Report, type Row } from './worktree-shared'

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
    case '--ack-ignored-artifacts':
      options.ackIgnoredArtifacts = value
      break
    case '--ack-discard-local-data':
      options.ackDiscardLocalData = value
      break
    default:
      throw new Error(`unknown argument: ${key}`)
  }
}
function validateAcknowledgmentOptions(options: Options) {
  if (options.ackUnknownUsage && options.ackUnknownUsage !== options.target)
    throw new Error('--ack-unknown-usage must exactly match --path')
  if (options.ackIgnoredArtifacts && options.ackIgnoredArtifacts !== options.target)
    throw new Error('--ack-ignored-artifacts must exactly match --path')
  if (options.force && options.ackIgnoredArtifacts)
    throw new Error('--ack-ignored-artifacts does not apply with --force; --ack-discard-local-data covers ignored data')
  if (options.ackDiscardLocalData && !options.force) throw new Error('--ack-discard-local-data requires --force')
  if (options.ackDiscardLocalData && options.ackDiscardLocalData !== options.target)
    throw new Error('--ack-discard-local-data must exactly match --path')
}
function validateRemoveOptions(options: Options) {
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
  validateAcknowledgmentOptions(options)
}
function validateOptions(options: Options) {
  if (options.scope !== undefined && !/^[1-9][0-9]*$/.test(options.scope))
    throw new Error('--scope requires a positive issue number')
  if (options.repos.length && options.roots.length) throw new Error('choose --repo or --root, not both')
  if (options.command === 'inventory') {
    if (
      options.target ||
      options.expect ||
      options.confirm ||
      options.ackUnknownUsage ||
      options.ackIgnoredArtifacts ||
      options.ackDiscardLocalData
    )
      throw new Error('removal options require remove')
    return
  }
  validateRemoveOptions(options)
}
function consumeOption(options: Options, args: string[], seen: Set<string>, key: string) {
  if (seen.has(key) && key !== '--repo' && key !== '--root') throw new Error(`duplicate ${key}`)
  seen.add(key)
  if (key === '--json') {
    options.json = true
    return
  }
  // A boolean mode switch: inventory --force stays read-only; remove --force needs a force-mode inventory token.
  if (key === '--force') {
    options.force = true
    return
  }
  if (key === '--all' || key === '--report-only') {
    if (options.command !== 'inventory') throw new Error(`${key} is only valid for inventory`)
    if (key === '--all') options.roots.push(process.cwd())
    return
  }
  const valued = [
    '--repo',
    '--root',
    '--scope',
    '--path',
    '--expect',
    '--confirm',
    '--ack-unknown-usage',
    '--ack-ignored-artifacts',
    '--ack-discard-local-data',
  ]
  if (!valued.includes(key)) throw new Error(`unknown argument: ${key}`)
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
function checkAcknowledgment(required: boolean, value: string | undefined, path: string, errors: [string, string]) {
  if (required && value !== path) throw new Error(errors[0])
  if (!required && value) throw new Error(errors[1])
}
// Each acknowledgment is required exactly when fresh inspection requires it; usage is checked before local data.
function checkAcknowledgments(options: Options, row: Row) {
  checkAcknowledgment(row.requiresUsageConfirmation, options.ackUnknownUsage, row.path, [
    'process inspection incomplete; explicit --ack-unknown-usage EXACT_PATH is required',
    '--ack-unknown-usage is unnecessary: fresh process inspection is complete',
  ])
  checkAcknowledgment(row.requiresArtifactConfirmation, options.ackIgnoredArtifacts, row.path, [
    'ignored artifacts are removed with the worktree; explicit --ack-ignored-artifacts EXACT_PATH is required',
    '--ack-ignored-artifacts is unnecessary: fresh inventory found no ignored artifacts',
  ])
  checkAcknowledgment(row.requiresDiscardConfirmation, options.ackDiscardLocalData, row.path, [
    'force removal permanently deletes local data; explicit --ack-discard-local-data EXACT_PATH is required',
    '--ack-discard-local-data is unnecessary: fresh force inventory found no local data',
  ])
}
// Force tokens carry their mode as a prefix and also bind it in their digest; safe tokens are bare digests.
const tokenMode = (token: string | undefined): RemovalMode => (token?.startsWith('force-') ? 'force' : 'safe')
// Fresh inspection runs in the requested mode, so a row's mode differs from it only where force does not apply.
function checkTarget(options: Options, report: Report): Row {
  if (report.errors.some((error) => error.scope === 'repository' || error.scope === undefined))
    throw new Error('repository inventory incomplete; resolve repository errors before removal')
  const row = report.worktrees.find((item) => item.path === options.target)
  if (!row) throw new Error('target not found in fresh inventory; select an exact reported path')
  if (options.force && row.removalMode !== 'force')
    throw new Error('--force applies only to registered or detached worktrees')
  if (!row.eligible) throw new Error(`target is protected: ${row.reasons.join('; ')}`)
  if (!['registered', 'detached'].includes(row.kind) && report.errors.some((error) => error.scope === 'orphan-scan'))
    throw new Error('orphan scanner failed; resolve the scanner error before removing an orphan')
  const tokenFrom = tokenMode(options.expect)
  if (tokenFrom !== row.removalMode)
    throw new Error(`a ${tokenFrom}-mode inventory token cannot remove in ${row.removalMode} mode; inventory again`)
  if (row.token !== options.expect)
    throw new Error('inventory token is stale; inventory again and select the target afresh')
  return row
}
function removeTarget(options: Options, report: Report): Row {
  const row = checkTarget(options, report)
  if (row.removalMode === 'force') {
    // A large tree walk can outlast the initial process observation.
    applyUsage(row)
    if (row.activity === 'active') throw new Error('target is protected: used by a same-user process')
  }
  checkAcknowledgments(options, row)
  // Mount topology can change after inventory; Git's recursive removal would cross a new mount.
  if ((row.removalMode === 'force' || row.requiresArtifactConfirmation) && mountPointsWithin(row.path).length)
    throw new Error('a mount point is at or below the worktree; removal refused')
  const repo = options.repos[0]
  // Exactly one --force: Git then deletes local changes and untracked files but still refuses a locked worktree.
  if (row.removalMode === 'force') git(repo, 'worktree', 'remove', '--force', '--', row.path)
  else if (row.kind === 'registered' || row.kind === 'detached') git(repo, 'worktree', 'remove', '--', row.path)
  else if (row.kind === 'empty_parent' || row.kind === 'empty_untracked') rmdirSync(row.path)
  else throw new Error('unsupported target classification')
  return row
}
// A force removal reports its mode and every discarded local entry; a safe removal keeps its original output.
function reportRemoval(row: Row, json: boolean) {
  const force = row.removalMode === 'force'
  const discarded = force ? { removalMode: row.removalMode, localEntries: row.localEntries } : {}
  if (json) console.log(JSON.stringify({ removed: row.path, ...discarded }))
  else if (force) {
    const count = row.localEntries.length
    console.log(
      `Removed worktree with git worktree remove --force; ${count} local entries discarded: ${JSON.stringify(row.path)}`,
    )
  } else console.log(`Removed worktree directory: ${row.path}`)
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
    render(report, options)
    if (report.errors.length) process.exitCode = 1
    return
  }
  try {
    reportRemoval(removeTarget(options, report), options.json)
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
