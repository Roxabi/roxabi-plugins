import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  mandateAssessmentState,
  proposedAssessmentState,
} from '../engine/__tests__/workflow-spec-assessment-support.ts'
import { featureMandate, SCOPE } from '../engine/__tests__/workflow-test-support.ts'
import { mechanicalSpecDelta } from '../engine/workflow-spec-assessment.ts'
import { fixtureUwOperations, standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { prepareDeliveryAction } from './delivery-action.ts'
import type { UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import * as actionObserve from './uw-action-observe.ts'
import { actionOperationMethods } from './uw-action-operations.ts'
import { sha256Bytes } from './uw-action-result.ts'
import { createProductionActionPorts, createProductionInputPorts } from './uw-input-readers.ts'

it('prepares plan and plan-review against the same accepted UW Spec', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plan-review-preparation-'))
  const base = standaloneReviewInputs()
  const mandate = featureMandate()
  const decoded = roxabiWorkflowFixtures().historyFrom([mandate])
  const pluginBytes = Buffer.from('fixture plugin')
  const observe = vi.spyOn(actionObserve, 'observeCode').mockResolvedValue({
    ok: true,
    value: { branch: 'feature/bounded', baseName: 'main' },
  })
  const config = vi.spyOn(actionObserve, 'configuration').mockResolvedValue({
    ok: true,
    value: base.manifest.configuration,
  })
  const histories = vi.spyOn(actionObserve, 'readHistories').mockResolvedValue({ ok: true, value: [decoded] })
  try {
    const { readPinnedFiles: _readPinnedFiles, ...production } = createProductionInputPorts({
      cwd: directory,
      gh: async () => {
        throw new Error('accepted Spec must not read the proposed issue body')
      },
    })
    let placement = 0
    const ports: UwActionPorts = {
      ...production,
      readPinnedFile: async () => ({ ok: true, value: pluginBytes }),
      readCodeDiff: async () => ({ ok: true, value: Buffer.from('diff') }),
      repositoryReferences: async () => ({ ok: true, value: [] }),
      plugin: {
        resolveInstalledPluginPin: async () => ({
          ok: true,
          value: {
            name: 'omp-build',
            version: base.manifest.plugin.version,
            repository: base.manifest.plugin.repository,
            commit: base.manifest.plugin.commit,
            root: base.manifest.plugin.root,
          },
        }),
        readInstalledFile: async () => ({ ok: true, value: pluginBytes }),
      },
      snapshots: {
        create: async ({ files }) => {
          const root = join(directory, `snapshot-${placement++}`)
          for (const file of files) {
            const path = join(root, file.path)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, file.bytes)
          }
          return { ok: true, value: { indexPath: join(root, 'index.md'), location: 'local' } }
        },
      },
    }
    const operations = { ...fixtureUwOperations(), ...actionOperationMethods({ actions: ports }) }
    const request: UwActionRequest = {
      actionId: 'plan-action',
      purpose: 'plan',
      subject: { kind: 'uw', uw: SCOPE, pullRequest: null, binding: null },
      code: { ...base.manifest.code, repository: SCOPE.repository },
      stageSources: [],
      expandedContext: [],
    }
    const plan = await prepareDeliveryAction(operations, request)
    expect(plan.ok).toBe(true)
    const review = await prepareDeliveryAction(operations, {
      ...request,
      actionId: 'plan-review-action',
      purpose: 'plan-review',
    })
    expect(review.ok).toBe(true)
    if (!plan.ok || !review.ok) return
    expect(plan.value.inputs.manifest.spec.kind).toBe('accepted')
    expect(review.value.inputs.manifest.spec).toEqual(plan.value.inputs.manifest.spec)
    expect(review.value.inputs.manifest.acceptedSources).toEqual(plan.value.inputs.manifest.acceptedSources)
    expect(review.value.inputs.manifest.configuration).toEqual(plan.value.inputs.manifest.configuration)
  } finally {
    observe.mockRestore()
    config.mockRestore()
    histories.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('preserves the missing adjacent native source in assessment preparation diagnostics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'assessment-graph-preparation-'))
  const base = standaloneReviewInputs()
  const mandate = featureMandate()
  const decoded = roxabiWorkflowFixtures().historyFrom([mandate])
  const accepted = mandateAssessmentState(mandate)
  const proposed = proposedAssessmentState(accepted, { body: 'Changed proposal' })
  const observe = vi.spyOn(actionObserve, 'observeCode').mockResolvedValue({
    ok: true,
    value: { branch: 'feature/bounded', baseName: 'main' },
  })
  const config = vi.spyOn(actionObserve, 'configuration').mockResolvedValue({
    ok: true,
    value: base.manifest.configuration,
  })
  const histories = vi.spyOn(actionObserve, 'readHistories').mockResolvedValue({ ok: true, value: [decoded] })
  try {
    const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
    const production = createProductionActionPorts({
      cwd: directory,
      gh: async (_cwd, args) => {
        const number = args.find((arg) => arg.startsWith('number='))?.slice('number='.length)
        if (number === '43') throw new Error('adjacent issue #43 is unreadable')
        if (number !== '42') throw new Error('unexpected history read')
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                number: 42,
                title: 'Selected UW',
                body: mandate.payload.ownSpec.snapshot.raw.body,
                updatedAt: '2026-10-27T12:00:00Z',
                state: 'OPEN',
                stateReason: null,
                repository: { nameWithOwner: 'acme/app' },
                parent: null,
                labels: { ...empty, nodes: [{ name: 'size:S' }] },
                subIssues: empty,
                blockedBy: { ...empty, nodes: [{ number: 43, repository: { nameWithOwner: 'acme/app' } }] },
              },
            },
          },
        })
      },
    })
    const ports: UwActionPorts = {
      ...production,
      plugin: {
        ...production.plugin,
        resolveInstalledPluginPin: async () => ({
          ok: true,
          value: {
            name: 'omp-build',
            version: base.manifest.plugin.version,
            repository: base.manifest.plugin.repository,
            commit: base.manifest.plugin.commit,
            root: base.manifest.plugin.root,
          },
        }),
      },
    }
    const operations = { ...fixtureUwOperations(), ...actionOperationMethods({ actions: ports }) }
    const request: UwActionRequest = {
      actionId: 'assessment-incomplete-graph',
      purpose: 'assess-spec',
      subject: { kind: 'uw', uw: SCOPE, pullRequest: null, binding: null },
      code: { ...base.manifest.code, repository: SCOPE.repository },
      stageSources: [],
      expandedContext: [],
      operands: {
        action: 'assess-spec',
        exactInputs: {
          format: 'omp-build-spec-assessment/2',
          accepted,
          proposed,
          identityAllocations: mandate.payload.ownSpec.identityAllocations,
          mechanical: mechanicalSpecDelta(accepted, proposed),
        },
      },
    }
    const result = await prepareDeliveryAction(operations, request)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected incomplete graph refusal')
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'graph-incomplete',
        message: 'adjacent issue #43 is unreadable',
        detail: {
          uwLocation: {
            kind: 'native',
            uw: { repository: 'acme/app', target: 'acme/app#43' },
            connection: 'state',
            page: 1,
          },
          related: [],
        },
      }),
    )
  } finally {
    observe.mockRestore()
    config.mockRestore()
    histories.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('materializes the selected draft module glossary for each plan specialist at the pinned base', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'planned-glossary-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
  const workflow = roxabiWorkflowFixtures()
  const mandate = featureMandate()
  const decoded = workflow.historyFrom([mandate, ...workflow.planDraftRecords(mandate)])
  const base = standaloneReviewInputs()
  const pluginBytes = Buffer.from('fixture plugin')
  const observe = vi.spyOn(actionObserve, 'observeCode').mockResolvedValue({
    ok: true,
    value: { branch: 'feature/bounded', baseName: 'main' },
  })
  const config = vi.spyOn(actionObserve, 'configuration').mockResolvedValue({
    ok: true,
    value: base.manifest.configuration,
  })
  const histories = vi.spyOn(actionObserve, 'readHistories').mockResolvedValue({ ok: true, value: [decoded] })
  try {
    git('init')
    git('config', 'user.name', 'fixture')
    git('config', 'user.email', 'fixture@example.com')
    git('remote', 'add', 'origin', 'https://github.com/acme/app.git')
    mkdirSync(join(directory, 'src'), { recursive: true })
    writeFileSync(join(directory, 'src/GLOSSARY.md'), 'pinned glossary')
    git('add', '.')
    git('commit', '-m', 'fixture')
    const commit = git('rev-parse', 'HEAD')
    writeFileSync(join(directory, 'src/GLOSSARY.md'), 'dirty glossary')
    const production = createProductionInputPorts({
      cwd: directory,
      gh: async () => {
        throw new Error('unexpected GitHub read')
      },
    })
    const snapshots: { path: string; bytes: Uint8Array }[][] = []
    const ports: UwActionPorts = {
      ...production,
      readPinnedFiles: async (refs) => ({ ok: true, value: refs.map(() => pluginBytes) }),
      plugin: {
        resolveInstalledPluginPin: async () => ({
          ok: true,
          value: {
            name: 'omp-build',
            version: base.manifest.plugin.version,
            repository: base.manifest.plugin.repository,
            commit: base.manifest.plugin.commit,
            root: base.manifest.plugin.root,
          },
        }),
        readInstalledFile: async () => ({ ok: true, value: pluginBytes }),
      },
      snapshots: {
        create: async ({ files }) => {
          snapshots.push([...files])
          const root = join(directory, `snapshot-${snapshots.length}`)
          for (const file of files) {
            const target = join(root, file.path)
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, file.bytes)
          }
          return {
            ok: true,
            value: { indexPath: join(root, 'index.md'), location: 'local' },
          }
        },
      },
    }
    const operations = { ...fixtureUwOperations(), ...actionOperationMethods({ actions: ports }) }
    const request: UwActionRequest = {
      actionId: 'specialist-a',
      purpose: 'plan-review',
      subject: { kind: 'uw', uw: SCOPE, pullRequest: null, binding: null },
      code: { repository: SCOPE.repository, base: commit, head: commit, referenceCommit: commit },
      stageSources: [],
      expandedContext: [],
    }
    for (const actionId of ['specialist-a', 'specialist-b']) {
      const prepared = await prepareDeliveryAction(operations, { ...request, actionId })
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true)
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics))
      expect(prepared.value.inputs.manifest.repositoryReferences).toContainEqual({
        source: 'git-file',
        repository: SCOPE.repository,
        commit,
        path: 'src/GLOSSARY.md',
        digest: sha256Bytes(Buffer.from('pinned glossary')),
      })
      const indexPath = prepared.value.snapshot.indexPath
      expect(readFileSync(indexPath, 'utf8')).toContain('- repo/src/GLOSSARY.md')
      expect(readFileSync(join(dirname(indexPath), 'repo/src/GLOSSARY.md'), 'utf8')).toBe('pinned glossary')
    }
  } finally {
    observe.mockRestore()
    config.mockRestore()
    histories.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
