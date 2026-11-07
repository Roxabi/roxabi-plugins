import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Gh } from '../../../../adapters/github/types.ts'
import { decodeHistory } from '../../../../contracts.ts'
import { actionInputDigest } from '../../../../engine/action-input.ts'
import type { ActionInputManifest } from '../../../../engine/action-input-schema.ts'
import { buildRecord } from '../../../../engine/record-construction.ts'
import { resolveSpecEffective } from '../../../../engine/spec-effective.ts'
import { resolveAcceptedSpec } from '../../../../engine/workflow-accepted-spec.ts'
import { recordsOf } from '../../../../engine/workflow-control.ts'
import { prepareUwAction, replayUwActionInputs } from '../../../../roxabi/uw-action-inputs.ts'
import { createProductionActionPorts } from '../../../../roxabi/uw-input-readers.ts'
import { createInstalledUwOperations } from '../../../../roxabi/uw-installed-operations.ts'
import type { GitRunner } from '../../../../roxabi/workflow-checkout.ts'
import { committedFixtureProjection, committedFixtureRecords } from '../../../../testing/committed-plugin-fixture.ts'
import { encodeCriterionRecords } from '../../../../testing/criterion-approval.ts'
import { eligiblePlan } from '../../../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import {
  childNode,
  epicFixtureGraph,
  issueComments,
  ME,
  recordHistory,
  serveComments,
  serveEpic,
} from './epic-driver-records.ts'
import { git as checkedGit, sandboxOf } from './epic-driver-sandbox.ts'

/** Add an independent blocker without replacing the delivered parent and child observations. */
export function installEpicBlocker() {
  const state = sandboxOf().state
  const names = ['comments-1.json', 'epic.json', 'containment-1.json', 'uw-1.json']
  const saved = names.map((name) => ({ name, contents: readFileSync(path.join(state, name)) }))
  serveEpic([childNode(3, 'fix(y): independent blocker')])
  for (const { name, contents } of saved) writeFileSync(path.join(state, name), contents)
  const blockerPath = path.join(state, 'uw-3.json')
  const blocker = JSON.parse(readFileSync(blockerPath, 'utf8'))
  blocker.data.repository.issue.parent = null
  writeFileSync(blockerPath, JSON.stringify(blocker))
}

/** Install accepted plan records against the observed pre-action checkout. */
export function installEpicPlan(number: number, base: string) {
  const scope = { repository: 'o/r', target: `o/r#${number}` }
  const graph = epicFixtureGraph(scope)
  const histories = graph.nodes.map((node) => {
    const match = /^o\/r#([1-9]\d*)$/.exec(node.uw.target)
    if (node.uw.repository !== 'o/r' || match === null)
      throw new Error(`Unexpected plan history scope ${node.uw.target}`)
    const issue = Number(match[1])
    return decodeHistory(recordHistory(issue, issueComments(issue)))
  })
  const history = histories.find((item) => item.source.scope.target === scope.target)
  if (!history) throw new Error(`Missing plan history ${scope.target}`)
  const externalHistories = histories.filter((item) => item !== history)
  const mandate = recordsOf(history).find((record) => record.kind === 'mandate')
  if (mandate?.kind !== 'mandate') throw new Error(`Missing accepted mandate ${scope.target}`)
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) throw new Error(`Cannot resolve ${scope.target} accepted Spec: ${accepted.reason}`)
  const effective = resolveSpecEffective({ mode: 'current', own: accepted.spec.ref, histories, graph })
  if (!effective.ok) throw new Error(`Cannot resolve ${scope.target} vector: ${JSON.stringify(effective.diagnostics)}`)
  const commit = checkedGit(import.meta.dirname, 'rev-parse', 'HEAD')
  const records = committedFixtureRecords(
    import.meta.dirname,
    eligiblePlan(mandate, histories, effective.value),
    commit,
  )
    .filter((record) => record.kind !== 'mandate')
    .map((record) => {
      if (record.kind !== 'action-receipt') return record
      const previous = record.payload.inputs
      const manifest = {
        ...previous.manifest,
        code: { repository: scope.repository, base, head: base, referenceCommit: base },
      }
      const result = buildRecord({
        ...record,
        payload: { ...record.payload, inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) } },
      })
      if (!result.ok) throw new Error(`Invalid fixture plan: ${JSON.stringify(result.diagnostics)}`)
      return result.value
    })
  const first = records.find((record) => record.kind === 'action-receipt')
  if (first?.kind !== 'action-receipt') throw new Error('Missing plan START')
  const projection = committedFixtureProjection(import.meta.dirname, first.payload.inputs)
  const encoded = encodeCriterionRecords(records, scope, projection, ME, externalHistories, history)
  serveComments(number, [...issueComments(number), ...encoded.comments.map(({ body }) => ({ body, author: ME }))])
  return { mandate, pin: first.payload.inputs.manifest.plugin }
}

/** All transport calls use the same mutable sandbox and the actual checkout. */
export async function epicNativeOperations(cwd: string, plugin: ActionInputManifest['plugin']) {
  const box = sandboxOf()
  const run = (program: string, dir: string, args: string[]) =>
    spawnSync(program, args, { cwd: dir, env: box.env, encoding: 'utf8' })
  const gh: Gh = async (dir, args) => {
    const result = run('gh', dir, args)
    if (result.error || result.status !== 0)
      throw new Error(`gh ${args.join(' ')}: ${result.stderr || result.error?.message}`)
    return result.stdout
  }
  const git: GitRunner = async (dir, args) => {
    const result = run('git', dir, args)
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error?.message ?? '',
    }
  }
  const installed = await createInstalledUwOperations({
    cwd,
    gh,
    readAuthor: ME,
    operator: {
      async executeConfirmed() {
        throw new Error('Fixture does not authorize operator mutation')
      },
    },
  })
  const { files: _files, ...pin } = plugin
  const production = createProductionActionPorts({ cwd, gh, git, readAuthor: ME, artifactsDir: box.root })
  const bytes = (path: string) => {
    const result = spawnSync('git', ['show', `${pin.commit}:${path}`], { cwd: import.meta.dirname, encoding: 'buffer' })
    if (result.status !== 0 || result.error) throw new Error(`Missing committed plugin file ${path}`)
    return new Uint8Array(result.stdout)
  }
  const ports = {
    ...production,
    plugin: {
      async resolveInstalledPluginPin() {
        return { ok: true as const, value: pin }
      },
      async readInstalledFile(path: string) {
        return { ok: true as const, value: bytes(`${pin.root}/${path}`) }
      },
    },
    async readCodeDiff(code: { base: string; head: string }) {
      const result = spawnSync('git', ['diff', '--binary', code.base, code.head], {
        cwd,
        env: box.env,
        encoding: 'buffer',
      })
      if (result.status !== 0 || result.error) throw new Error('Cannot read actual checkout diff')
      return { ok: true as const, value: new Uint8Array(result.stdout) }
    },
  }
  const operations = {
    ...installed,
    prepareAction: (
      request: Parameters<typeof installed.prepareAction>[0],
      projection?: Parameters<typeof installed.prepareAction>[1],
      review?: Parameters<typeof installed.prepareAction>[2],
    ) => prepareUwAction(request, ports, projection, review),
    replayActionInputs: (request: Parameters<typeof installed.replayActionInputs>[0]) =>
      replayUwActionInputs(request, ports),
  }
  return { gh, git, operations }
}
