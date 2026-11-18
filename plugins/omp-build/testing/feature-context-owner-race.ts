import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { recordsOf } from '../engine/workflow-control.ts'
import { reviewControllerFor } from '../omp/omp-controller.ts'
import { createFeatureCommandHost } from '../omp/omp-feature-command-host.ts'
import { beginFeatureUwIntake, createFeatureOperationReportGuard } from '../omp/omp-feature-composition.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import type { FeatureWorkflow } from '../roxabi/feature-contract.ts'
import { runInstalledFeatureCommand } from '../roxabi/feature-entry.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import {
  fixtureScopeFromReference,
  prepareFictionalNoneIdentifiedHandoffEffects,
} from './context-effect-review-fixture.ts'
import { createExtensionApiStub } from './extension-api-stub.ts'
import { provisionNativeRoot } from './native-root-fixture.ts'

export async function contextOwnerCoverageRace(
  cwd: string,
  negativeRecordId: string,
  workflow: FeatureWorkflow,
  operator: OperatorPort,
  effectsFileArg?: string,
) {
  const artifacts = mkdtempSync(join(tmpdir(), 'context-owner-coverage-'))
  const messages: unknown[] = []
  const pi = createExtensionApiStub({
    sendMessage(message) {
      messages.push(message)
    },
  })
  const entered = Promise.withResolvers<string>()
  const release = Promise.withResolvers<string>()
  const ctx = {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui' as const,
    ui: {
      async editor(_title: string, text: string) {
        entered.resolve(text)
        return release.promise
      },
      async confirm() {
        return true
      },
    },
    model: { contextWindow: 128_000 },
    sessionManager: { getSessionId: () => 'context-owner-coverage-root' },
    localProtocolOptions: { getArtifactsDir: () => artifacts },
  }
  provisionNativeRoot(ctx)
  try {
    const controller = reviewControllerFor(pi)
    controller.observeRootContext(ctx as never)
    const operation = createOperatorConfirmation(ctx as never)
    const report = createFeatureOperationReportGuard(pi, ctx as never, operation)
    beginFeatureUwIntake(pi, operation, ctx as never)
    const effectsFile =
      effectsFileArg !== undefined
        ? (() => {
            if (!isAbsolute(effectsFileArg)) throw new Error('context-effect-intent-path-must-be-absolute')
            return effectsFileArg
          })()
        : (
            await prepareFictionalNoneIdentifiedHandoffEffects({
              cwd,
              scope: fixtureScopeFromReference('#200'),
              negativeRecordId,
              directory: artifacts,
            })
          ).effectsFile
    const args = `new #200 --context-handoff ${negativeRecordId} --context-effects ${effectsFile}`
    const host = createFeatureCommandHost(
      { pi, options: { principalCwd: () => false }, interruptOwnedFeatureWork: async () => {}, framing: {} } as never,
      { ctx: ctx as never, operator: operation, originalArgs: args },
      workflow,
      controller,
      await createInstalledUwOperations({ cwd, operator }),
      report,
      undefined,
    )
    const running = runInstalledFeatureCommand(args, host)
    const offered = await Promise.race([entered.promise, running.then(() => null)])
    if (offered === null) throw new Error(`Coverage editor was not reached: ${JSON.stringify(messages)}`)
    const draft = JSON.parse(offered) as {
      context: {
        parent: { uw: { target: string }; version: string }
        criteria: { id: string }[]
        children: { scope: { repository: string; target: string } }[]
      }
      coverage: unknown
    }
    if (draft.context.parent.uw.target !== 'acme/app#200' || draft.context.children.length !== 3)
      throw new Error('Unexpected owner-race coverage request')
    draft.coverage = {
      parent: draft.context.parent,
      assignments: draft.context.criteria.map((criterion) => ({
        criterion: criterion.id,
        children: draft.context.children.map((child) => child.scope),
      })),
    }
    const observe = async () => {
      const read = await createInstalledUwReadPort({ cwd }).readUw({ repository: 'acme/app', target: 'acme/app#200' })
      const records = read.observation.histories.flatMap(recordsOf)
      return {
        starts: records.filter(
          (record) =>
            record.kind === 'action-receipt' &&
            record.payload.action === 'assess-spec' &&
            record.payload.phase === 'start',
        ).length,
        mandates: records.filter((record) => record.kind === 'mandate').map((record) => record.recordId),
      }
    }
    const before = await observe()
    const replacement = createOperatorConfirmation(ctx as never)
    beginFeatureUwIntake(pi, replacement, ctx as never)
    release.resolve(JSON.stringify(draft))
    await running
    const after = await observe()
    return {
      before,
      after,
      coverageVersion: draft.context.parent.version,
      messages,
      active: controller.active() !== null,
      oldCurrent: report.isCurrent(),
    }
  } finally {
    rmSync(artifacts, { recursive: true, force: true })
  }
}
