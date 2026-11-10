import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { REMOVE_BLOCKED_BY_MUTATION } from '../../../issue-triage/skills/shared/queries.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { scopeKey } from '../../engine/uw-graph.ts'
import { bindExternalRef, recordsOf } from '../../engine/workflow-control.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { installedMultiSisterFixture } from '../../testing/multi-sister-installed-fixture.ts'
import { operatorDialogUi, operatorRootContext } from '../../testing/operator-dialog-ui.ts'
import type { UwOperations } from '../uw-contract.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'

/** Execute inside one isolated declared transport; returned values contain no live resources. */
export async function runCauseAdjustmentScenario(mode: 'confirm' | 'decline' | 'lost-delta' = 'confirm') {
  const artifacts = mkdtempSync(join(tmpdir(), 'omp-cause-adjustment-'))
  try {
    const world = await installedMultiSisterFixture(1, { artifactsDir: artifacts })
    const created = await world.operations.createSister(world.request(0))
    if (created.status !== 'created' || created.receipt.kind !== 'debt-receipt')
      throw new Error(`Could not establish the causal sister: ${JSON.stringify(created)}`)
    const origin = world.context.original
    const sister = { repository: 'acme/app', target: 'acme/app#43' }
    const disposition = world.request(0).disposition
    const receipt: Parameters<UwOperations['adjustCauseDependency']>[0]['receipt'] = {
      scope: created.receipt.scope,
      recordId: created.receipt.recordId,
      kind: created.receipt.kind,
    }
    const issue = world.issues.get(42)
    if (!issue?.blockers.includes(43)) throw new Error('Created native blocker missing')
    const journal: { kind: string; args: string[] }[] = []
    const confirmations: { title: string; detail: string }[] = []
    const recordPublication = (args: string[]) => {
      if (args[0] !== 'api' || args[1] !== '--method') return
      if (args[2] === 'PATCH') journal.push({ kind: 'patch', args: [...args] })
      if (args[2] === 'POST' && args[3]?.endsWith('/comments')) journal.push({ kind: 'publish', args: [...args] })
    }
    const gh: Gh = async (cwd, args) => {
      if (args[1] === 'graphql' && args[3] === `query=${REMOVE_BLOCKED_BY_MUTATION}`) {
        if (args[5] !== 'issueId=node-42' || args[7] !== 'blockingId=node-43')
          throw new Error('Unexpected dependency mutation')
        journal.push({ kind: 'remove-blocker', args: [...args] })
        if (mode !== 'lost-delta') issue.blockers = issue.blockers.filter((number) => number !== 43)
        return JSON.stringify({ data: { removeBlockedBy: { issue: { number: 42 }, blockingIssue: { number: 43 } } } })
      }
      recordPublication(args)
      return world.gh(cwd, args)
    }
    const operator = createOperatorConfirmation({
      ...operatorRootContext('/fixture', { getArtifactsDir: () => artifacts }),
      hasUI: true,
      mode: 'tui',
      ui: operatorDialogUi(
        async () => (mode === 'decline' ? 'refuse' : 'confirm'),
        (detail) => confirmations.push({ title: 'Confirm UW proposal', detail }),
      ),
    } as unknown as ExtensionContext)
    const operations = await createInstalledUwOperations({ cwd: '/fixture', gh, readAuthor: 'automation', operator })
    const snapshot = async () => {
      const read = await operations.readUw(origin)
      const node = read.graph.nodes.find((item) => item.uw.target === origin.target)
      const wait = read.completion.waits.causeWaits.find((item) => item.receipt.recordId === receipt.recordId)
      const dependency = read.completion.dependencies.get(scopeKey(sister))
      return {
        observation: read.observation.status,
        node,
        accepted: read.accepted,
        wait: wait ?? null,
        dependency: dependency ? { state: dependency.state, diagnostics: dependency.diagnostics } : null,
        completion: read.completion.completions.get(scopeKey(origin)) ?? null,
        requirements: read.completion.waits.requirements,
        histories: read.histories,
      }
    }
    const before = await snapshot()
    const result = await operations.adjustCauseDependency({
      origin,
      disposition,
      receipt,
      predecessor: receipt,
      change: { kind: 'withdraw' },
      nativeEffect: { kind: 'update-blockers', remove: [sister], add: [] },
      reason: 'The operator withdrew this causal dependency',
      references: [],
    })
    const after = await snapshot()
    let control = null
    if (result.status === 'adjusted') {
      const home = after.histories.find((history) => history.source.scope.target === origin.target)
      if (!home) throw new Error('Origin history missing after publication')
      const bound = bindExternalRef(result.control, home)
      control = bound.ok ? bound.value : null
    }
    let replay = null
    if (result.status === 'adjusted') {
      issue.blockers.push(43)
      replay = await snapshot()
    }
    const project = ({ histories, ...value }: typeof before) => ({
      ...value,
      controlRecords: histories.flatMap((history) =>
        recordsOf(history).filter(
          (record) => record.kind === 'operator-control' && record.payload.control === 'adjust-cause-dependency',
        ),
      ),
    })
    return structuredClone({
      origin,
      sister,
      disposition,
      receipt,
      before: project(before),
      after: project(after),
      replay: replay && project(replay),
      result: result.status === 'adjusted' ? { status: result.status, control: result.control } : result,
      canonicalControl: control,
      confirmations,
      journal,
    })
  } finally {
    rmSync(artifacts, { recursive: true, force: true })
  }
}
