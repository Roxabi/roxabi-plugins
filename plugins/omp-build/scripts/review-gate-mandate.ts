import { type Gh, type Git, refreshReviewBase } from '../skills/feature/review-base.ts'
import { currentLandingMandate, type LandingMandateRead } from '../skills/feature/workflow-mandate.js'
import { type Arguments, jsonDetail, type MachineResult } from './review-gate-cli.ts'
import { type Coordinates, currentHeadAndBase } from './review-gate-coordinates.ts'

export async function landingMandate(
  toolingRoot: string,
  args: Arguments,
  gh: Gh,
  git: Git,
  coordinates: Coordinates,
  baseTip: string,
): Promise<{ mandate?: LandingMandateRead; error?: unknown }> {
  try {
    return {
      mandate: await currentLandingMandate(
        toolingRoot,
        args.pr,
        gh,
        { head: args.head, base: coordinates.baseName, baseTip, automationLogin: args.automationLogin },
        git,
        args.candidateCwd,
      ),
    }
  } catch (error) {
    return { error }
  }
}

export function historyRefusal(diagnostics: readonly { code: string }[]): MachineResult {
  const code = diagnostics[0]?.code
  return {
    ok: false,
    allowed: false,
    reason: code === 'record-edited' || code === 'record-unreadable' ? code : 'review-history-refused',
    detail: diagnostics,
  }
}

export async function citedHistoryRefusal(
  args: Arguments,
  toolingRoot: string,
  gh: Gh,
  git: Git,
  diagnostics: readonly { code: string }[],
): Promise<MachineResult> {
  try {
    const coordinates = currentHeadAndBase(
      await gh(toolingRoot, ['pr', 'view', String(args.pr), '--json', 'headRefOid,baseRefName,baseRefOid']),
    )
    if (coordinates.head === args.head) {
      const base = await refreshReviewBase(args.candidateCwd, coordinates.baseName, git, gh)
      if (base.ok) {
        const read = await landingMandate(toolingRoot, args, gh, git, coordinates, base.tip)
        if (read.mandate && !read.mandate.admitted)
          return { ok: false, allowed: false, reason: read.mandate.reason, detail: jsonDetail(read.mandate.evidence) }
      }
    }
  } catch {
    // Keep the cited-history refusal if independent mandate admission cannot be read.
  }
  return historyRefusal(diagnostics)
}
