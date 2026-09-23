#!/usr/bin/env bun
/**
 * ADR CLI — the deterministic half of `/R-adr`.
 *
 * The skill runs the interview and writes prose; number allocation, lifecycle
 * transitions and migration are here, because they are contract operations and
 * a contract that only an LLM enforces is not a contract.
 *
 * All subcommands print JSON for the SKILL.md orchestrator to parse.
 */

import { execFileSync } from 'node:child_process'
import {
  type AdrFile,
  adrCollisions,
  axialAdrs,
  deprecateAdr,
  listAdrs,
  migrateAdrDir,
  misnamedAdrs,
  nextNnn,
  parseRefList,
  scanAdrs,
  supersedeAdr,
  supersedeAdrInPart,
} from './lib/adr'

const USAGE = `ADR CLI — number allocation, lifecycle transitions, migration.

Usage:
  bun adr.ts next-nnn [--dir docs/architecture/adr]
      Next sequence number. Scans archived/ too — archiving must never free a number.
      Reports \`collisions\` and \`misnamed\`: one number naming two documents, and
      files whose name cannot be an ADR, both of which corrupt allocation.
  bun adr.ts list [--dir docs/architecture/adr]
      Active ADRs and archived ADRs, separately.
  bun adr.ts axial [--dir docs/architecture/adr]
      An axial declaration across active + archived, in any YAML boolean spelling.
      At most one is the invariant, so exit 1 means two axes; \`declared: false\`
      means none declared yet.
  bun adr.ts supersede --nnn <N> --by ADR-<NNN> [--dir docs/architecture/adr]
      status: superseded, normative: false, superseded_by, strip axial, move to archived/.
  bun adr.ts supersede-in-part --nnn <N> --by <ADR-NNN|#NNN> [--dir docs/architecture/adr]
      Append to superseded_in_part_by. The ADR stays in force and stays put — it is
      binding for every part nobody replaced.
  bun adr.ts deprecate --nnn <N> [--dir docs/architecture/adr]
      status: deprecated, normative: false. Stays in place — deprecated is not replaced.
  bun adr.ts migrate [--dir docs/architecture/adr] [--dry-run]
      Backfill status/normative/date from the body \`## Status\` section, then drop it.
      Dates missing from the body fall back to the file's first commit date.`

const args = process.argv.slice(2)
const command = args[0] ?? '--help'
const rest = args.slice(1)

function parseFlag(flag: string, fallback: string): string {
  const idx = rest.indexOf(flag)
  if (idx === -1 || idx + 1 >= rest.length) return fallback
  return rest[idx + 1]
}

const dir = parseFlag('--dir', 'docs/architecture/adr')

function requireAdr(nnn: string): AdrFile {
  const wanted = Number.parseInt(nnn, 10)
  const found = scanAdrs(dir).find((a) => a.nnn === wanted)
  if (!found) {
    console.error(`ADR-${nnn} not found under ${dir}`)
    process.exit(1)
  }
  return found
}

/**
 * First-commit date per path, so migration can date ADRs whose body never did.
 *
 * Falls back to a basename pathspec: an ADR read from a scratch copy, or moved
 * into `archived/`, is untracked at the path we scanned but its `NNN-` prefix
 * makes the basename unique across the tracked corpus.
 */
function gitAddedDates(paths: string[]): Record<string, string> {
  const dates: Record<string, string> = {}
  const base = ['log', '--diff-filter=A', '--format=%ad', '--date=short']
  for (const path of paths) {
    const attempts = [
      [...base, '--follow', '--', path],
      [...base, '--', `*/${path.split('/').pop()}`],
    ]
    for (const argv of attempts) {
      let out = ''
      try {
        out = execFileSync('git', argv, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        // Not a git repo, or the pathspec matches nothing — try the next shape.
        continue
      }
      const first = out.trim().split('\n').filter(Boolean).pop()
      if (first) {
        dates[path] = first
        break
      }
    }
  }
  return dates
}

if (command === '--help' || command === '-h' || rest.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}

switch (command) {
  case 'next-nnn': {
    // A collision or a misnamed file is a number-allocation fault, not a
    // cosmetic one: `next` is max + 1 over the scan, so either can hand the
    // same number out twice or skip a thousand. Exit 1 so a caller that pipes
    // this into a filename stops instead of writing the wrong one.
    const collisions = adrCollisions(dir)
    const misnamed = misnamedAdrs(dir)
    console.log(JSON.stringify({ dir, next: nextNnn(dir), collisions, misnamed }, null, 2))
    process.exit(collisions.length > 0 || misnamed.length > 0 ? 1 : 0)
    break
  }

  case 'list': {
    const { active, archived } = listAdrs(dir)
    const row = (a: AdrFile) => ({
      nnn: a.nnn,
      file: a.name,
      title: a.fields.title ?? '',
      status: a.fields.status ?? '',
      normative: a.fields.normative ?? '',
      date: a.fields.date ?? '',
      superseded_by: a.fields.superseded_by ?? '',
      superseded_in_part_by: parseRefList(a.fields.superseded_in_part_by),
    })
    console.log(JSON.stringify({ dir, active: active.map(row), archived: archived.map(row) }, null, 2))
    break
  }

  case 'axial': {
    const found = axialAdrs(dir)
    const result = {
      dir,
      count: found.length,
      files: found.map((a) => a.path),
      singleton: found.length === 1,
      declared: found.length > 0,
      /** At most one is the invariant. Zero is "no axis declared yet". */
      violated: found.length > 1,
    }
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.violated ? 1 : 0)
    break
  }

  case 'supersede': {
    const by = parseFlag('--by', '')
    if (!/^ADR-\d+$/.test(by)) {
      console.error('--by ADR-<NNN> is required: a superseded ADR names its replacement')
      process.exit(1)
    }
    const adr = requireAdr(parseFlag('--nnn', ''))
    console.log(JSON.stringify(supersedeAdr(adr, by, dir), null, 2))
    break
  }

  case 'supersede-in-part': {
    const by = parseFlag('--by', '')
    if (!/^(?:ADR-\d{3,4}|#\d+)$/.test(by)) {
      console.error('--by ADR-<NNN> or --by #<NNN> is required: a partial supersession names what replaced the part')
      process.exit(1)
    }
    console.log(JSON.stringify(supersedeAdrInPart(requireAdr(parseFlag('--nnn', '')), by), null, 2))
    break
  }

  case 'deprecate': {
    console.log(JSON.stringify(deprecateAdr(requireAdr(parseFlag('--nnn', ''))), null, 2))
    break
  }

  case 'migrate': {
    const dryRun = rest.includes('--dry-run')
    const reports = migrateAdrDir(dir, {
      dates: gitAddedDates(scanAdrs(dir).map((a) => a.path)),
      dryRun,
    })
    const needsHuman = reports.filter((r) => r.warnings.length > 0)
    console.log(
      JSON.stringify(
        {
          dir,
          dryRun,
          total: reports.length,
          migrated: reports.filter((r) => r.changed).length,
          clean: needsHuman.length === 0,
          reports,
        },
        null,
        2,
      ),
    )
    break
  }

  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`)
    process.exit(1)
}
