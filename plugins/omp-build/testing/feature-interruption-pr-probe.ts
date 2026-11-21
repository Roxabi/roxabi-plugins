import { selectApplicableMandate } from '../dist/contracts.js'
import { startResolution } from '../engine/workflow-action-interruption.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { startDispatch } from '../roxabi/feature-start-executions.ts'
import type { OperatorPort, PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { operatorDialogUi, operatorRootContext } from './operator-dialog-ui.ts'

export async function probePrResolution(
  cwd: string,
  payload: { start: string | null; startTarget: string; mandateId: string | null },
  prompts: PreparedOperatorProposal[],
  observed: unknown[],
): Promise<void> {
  if (payload.start === null || payload.mandateId === null) throw new Error('cross-scope-reference-missing')
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const start = {
    scope: { repository: 'acme/app', target: payload.startTarget },
    recordId: payload.start,
    kind: 'action-receipt' as const,
  }
  let dialog = ''
  let confirmations = 0
  const realOperator = createOperatorConfirmation({
    ...operatorRootContext(cwd, { getArtifactsDir: () => process.env.HOME ?? cwd }),
    hasUI: true,
    mode: 'tui',
    ui: operatorDialogUi(
      async () => {
        confirmations++
        return 'confirm'
      },
      (text) => {
        dialog = text
      },
    ),
  } as never)
  const confirmingOperator: OperatorPort = {
    async executeConfirmed(prepared, action) {
      prompts.push(structuredClone(prepared))
      return realOperator.executeConfirmed(prepared, action)
    },
  }
  const reader = createInstalledUwReadPort({ cwd })
  const before = await reader.readUw(scope)
  const starts = (histories: typeof before.observation.histories) =>
    histories.flatMap((history) =>
      history.operations.flatMap((operation) => {
        const record = operation.record
        return record?.kind === 'action-receipt' && record.payload.phase === 'start'
          ? [{ scope: history.source.scope, recordId: record.recordId }]
          : []
      }),
    )
  const beforeStarts = starts(before.observation.histories)
  const uw = await createInstalledUwOperations({ cwd, operator: confirmingOperator })
  const result = await uw.resolveInterruption({
    mandate: { scope, recordId: payload.mandateId, kind: 'mandate' },
    start,
    async observe(candidate) {
      return { ok: true, value: { runtime: candidate.runtime } }
    },
  })
  const readback = await reader.readUw(scope)
  const admitted =
    readback.observation.status === 'complete' ? startResolution(readback.observation.histories, start) : null
  const home = readback.observation.histories.find(
    (history) => history.source.scope.target === scope.target && history.source.scope.repository === scope.repository,
  )
  const selection =
    home && readback.observation.status === 'complete'
      ? selectApplicableMandate(
          home,
          readback.observation.histories.filter((history) => history !== home),
          {
            histories: readback.observation.histories,
            catalogues: readback.observation.catalogues,
            observation: readback.observation,
          },
        )
      : null
  process.stdout.write(
    `${JSON.stringify({
      result,
      prompts,
      observed,
      dialog,
      confirmations,
      dispatch: startDispatch(start) ?? null,
      before: { status: before.observation.status, starts: beforeStarts },
      readback: {
        status: readback.observation.status,
        admitted,
        selection,
        starts: starts(readback.observation.histories),
      },
    })}\n`,
  )
}
