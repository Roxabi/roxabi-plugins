import type { ArtifactKind, Options, Report, Row } from './worktree-shared'

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
const artifactLabels: Record<ArtifactKind, string> = {
  dependency: 'Ignored dependencies (entire contents removed; file contents not read)',
  cache: 'Ignored caches (entire contents removed; file contents not read)',
  'build-output': 'Ignored build/test output (entire contents removed; file contents not read; not proven regenerable)',
  protected: 'Ignored data that keeps this worktree (unrecognized or sensitive)',
}
// In force mode every ignored kind, `protected` included, is data the discard acknowledgment abandons, not a blocker.
const forceArtifactLabels: Record<ArtifactKind, string> = {
  dependency: 'Ignored dependencies (would be discarded; file contents not read)',
  cache: 'Ignored caches (would be discarded; file contents not read)',
  'build-output': 'Ignored build/test output (would be discarded; contents not read; not proven regenerable)',
  protected: 'Ignored unrecognized or sensitive data (would be discarded; file contents not read)',
}
function renderArtifacts(row: Row) {
  const labels = row.removalMode === 'force' ? forceArtifactLabels : artifactLabels
  for (const kind of Object.keys(labels) as ArtifactKind[]) {
    const paths = row.ignoredEntries.filter((entry) => entry.kind === kind).map((entry) => JSON.stringify(entry.path))
    if (paths.length) console.log(`  ${labels[kind]}: ${paths.join(', ')}`)
  }
  if (row.eligible && row.requiresArtifactConfirmation)
    console.log(`  Ignored artifacts present; disposability confirmation required: ${JSON.stringify(row.path)}`)
}
// Ignored records (`!!`) are listed above with their kinds; every other status record is listed here, so the human
// output names every local entry a force removal deletes.
function renderLocalEntries(row: Row) {
  if (row.removalMode !== 'force') return
  for (const entry of row.localEntries) {
    if (entry.status === '!!') continue
    const source = entry.originalPath === undefined ? '' : ` (from ${JSON.stringify(entry.originalPath)})`
    console.log(`  Local data that would be discarded [${entry.status}]: ${JSON.stringify(entry.path)}${source}`)
  }
  if (!row.eligible || !row.requiresDiscardConfirmation) return
  console.log(
    `  WARNING: force removal permanently deletes all ${row.localEntries.length} listed local entries unread:`,
    'tracked and staged changes, untracked files and entire ignored contents, including secrets or unique data',
  )
  console.log(`  Local data present; discard confirmation required: ${JSON.stringify(row.path)}`)
}
function render(report: Report, options: Options) {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (options.force) {
    console.log('Mode: force. Read-only inventory; nothing has been removed.')
    console.log('Eligible registered or detached worktrees require explicit selection before force removal.')
    console.log(
      'Branch/tag refs and reachable commits are preserved; worktree reflogs are removed. Orphan rules stay safe.',
    )
  }
  console.log('PATH\tKIND\tBRANCH\tACTIVITY\tELIGIBLE\tREASONS')
  for (const row of report.worktrees) {
    console.log(
      [
        JSON.stringify(row.path),
        row.kind,
        row.branch || '-',
        row.activity,
        row.eligible ? 'yes' : 'no',
        row.reasons.join('; ') || '-',
      ].join('\t'),
    )
    renderArtifacts(row)
    renderLocalEntries(row)
    if (row.requiresUsageConfirmation)
      console.log(`  Usage inspection incomplete; additional confirmation required: ${JSON.stringify(row.path)}`)
    for (const evidence of row.usageEvidence) console.log(`  Usage: ${evidence}`)
  }
  renderUsageWarnings(report.worktrees)
  console.log(
    `Discovery excludes directories: ${report.discoveryExclusions.directoryNames.join(', ')}; symlinks are not followed`,
  )
  console.log('Removal tokens are reported only by inventory --json')
  for (const error of report.errors) console.error(`${error.path}: ${error.message}`)
}

export { render }
