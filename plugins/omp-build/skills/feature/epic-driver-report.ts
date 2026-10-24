import type { Json } from '../../dist/contracts.js'
import type { Disarm } from './epic-driver-publication'
import type { HookRecord, Report } from './epic-types'

function ticketList(items: number[]): string {
  return items.length ? items.map((item) => `#${item}`).join(', ') : '—'
}

export function reportText(
  run: string,
  base: string,
  outcome: string,
  reason: string,
  summary: Report,
  hook: HookRecord | null,
  disarmed: Record<string, Disarm>,
  stillArmed: number[],
): string {
  return [
    `## Epic run \`${run}\` — ${outcome === 'complete' ? 'complete' : `dropped: \`${reason || 'unspecified'}\``}`,
    '',
    '| | |',
    '|---|---|',
    `| Merged into \`${base}\` | ${ticketList(summary.merged)} |`,
    `| Closed without a merged PR | ${ticketList(summary.closed)} |`,
    `| Stopped | ${summary.stopped.map((item) => `#${item.ticket} \`${item.reason}\`${item.sticky ? ' (sticky)' : ''}`).join(', ') || '—'} |`,
    `| Skipped (open blocker) | ${summary.skipped.map((item) => `#${item.ticket} by ${ticketList(item.blockers)}`).join(', ') || '—'} |`,
    `| Post-merge hook | ${hook ? `${hook.result} at \`${hook.sha}\`${hook.run === run ? '' : ` (run \`${hook.run}\`)`}` : 'not run'} |`,
    `| Base CI | ${summary.baseCi.state}${summary.baseCi.failed.length ? ` (failed: ${summary.baseCi.failed.join(', ')})` : ''} |`,
    ...(Object.keys(disarmed).length
      ? [
          `| Disarmed | ${Object.entries(disarmed)
            .map(([pr, value]) => `#${pr} ${value}`)
            .join(', ')} |`,
        ]
      : []),
    ...(stillArmed.length ? [`| Still armed | ${ticketList(stillArmed)} |`] : []),
  ].join('\n')
}

export function reportPayload(
  outcome: string,
  reason: string,
  summary: Report,
  hook: HookRecord | null,
  disarmed: Record<string, Disarm>,
  stillArmed: number[],
): Record<string, Json> {
  return {
    outcome,
    reason,
    summary: {
      merged: summary.merged,
      closed: summary.closed,
      stopped: summary.stopped,
      skipped: summary.skipped,
      baseCi: summary.baseCi,
    },
    hook,
    disarmed,
    stillArmed,
  }
}
