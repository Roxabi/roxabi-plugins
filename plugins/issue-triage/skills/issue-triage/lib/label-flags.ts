/**
 * Canonicalisation and writing of the label flags, shared by `set` and
 * `create`.
 *
 * One owner so the two commands cannot disagree about which spellings are
 * accepted, nor about when a bad value is fatal: resolution happens before the
 * first write, writing reports every label it lands, and a label that does not
 * land is counted rather than thrown — dropping out mid-sequence used to cancel
 * the relationship writes queued behind it (#525, PR #528 review).
 */

import {
  DEFAULT_LANE_OPTIONS,
  DEFAULT_SIZE_OPTIONS,
  DEFAULT_STATUS_OPTIONS,
  PRIORITY_INPUT_HINT,
  resolveLane,
  resolvePriority,
  resolveSize,
  resolveStatus,
} from '../../shared/adapters/config-helpers'
import { syncLaneLabel, syncPriorityLabel, syncSizeLabel, syncStatusLabel } from '../../shared/adapters/github-infra'

export interface LabelFlags {
  priority?: string
  size?: string
  lane?: string
  status?: string
}

function canonicalise(
  value: string,
  resolve: (input: string) => string | undefined,
  flag: string,
  valid: string,
): string {
  const canonical = resolve(value)
  if (!canonical) {
    console.error(`Error: Invalid ${flag} '${value}'. Valid: ${valid}`)
    process.exit(1)
  }
  return canonical
}

/** Canonicalise every supplied flag, rejecting an unrecognised value loudly. */
export function resolveLabelFlags(raw: LabelFlags): LabelFlags {
  const resolved: LabelFlags = {}
  if (raw.priority !== undefined) {
    resolved.priority = canonicalise(raw.priority, resolvePriority, 'priority', PRIORITY_INPUT_HINT)
  }
  if (raw.size !== undefined) {
    resolved.size = canonicalise(raw.size, resolveSize, 'size', DEFAULT_SIZE_OPTIONS.join(', '))
  }
  if (raw.lane !== undefined) {
    resolved.lane = canonicalise(raw.lane, resolveLane, 'lane', DEFAULT_LANE_OPTIONS.join(', '))
  }
  if (raw.status !== undefined) {
    resolved.status = canonicalise(raw.status, resolveStatus, 'status', DEFAULT_STATUS_OPTIONS.join(', '))
  }
  return resolved
}

/**
 * Write each canonical label, echoing the ones that land and returning the
 * names of the ones that do not. The caller runs its remaining writes, then
 * exits non-zero if this list is non-empty.
 */
export async function writeLabels(issueNumber: number, flags: LabelFlags): Promise<string[]> {
  const failed: string[] = []

  if (flags.priority) {
    if (await syncPriorityLabel(issueNumber, flags.priority)) {
      console.log(`Priority=${flags.priority} #${issueNumber}`)
    } else {
      failed.push('priority')
    }
  }
  if (flags.size) {
    if (await syncSizeLabel(issueNumber, flags.size)) {
      console.log(`Size=${flags.size} #${issueNumber}`)
    } else {
      failed.push('size')
    }
  }
  if (flags.lane) {
    if (await syncLaneLabel(issueNumber, flags.lane)) {
      console.log(`Lane=${flags.lane} #${issueNumber}`)
    } else {
      failed.push('lane')
    }
  }
  if (flags.status) {
    if (await syncStatusLabel(issueNumber, flags.status)) {
      console.log(`Status=${flags.status} #${issueNumber}`)
    } else {
      failed.push('status')
    }
  }

  return failed
}
