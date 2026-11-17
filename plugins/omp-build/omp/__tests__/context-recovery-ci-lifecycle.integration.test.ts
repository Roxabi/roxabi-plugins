import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import { PULL_SCOPE, pullHistory } from '../../testing/feature-ci-review-fixture.ts'
import { arrangeRecoveryReviewFixture } from '../../testing/fix-recovery-review-prelude.ts'
import { readSim } from '../../testing/sandbox/sandbox-repository.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = resolve(import.meta.dirname, '../../testing/context-recovery-ci-lifecycle-worker.ts')
const runner = resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
const raceRunner = resolve(import.meta.dirname, '../../testing/context-recovery-ci-binding-race.ts')
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

for (const scenario of [
  'stable',
  'binding-race',
  'abandon-race',
  'pause-request-race',
  'pause-confirmed-race',
] as const) {
  it(
    `recovers native CI context with ${scenario} authority`,
    () => {
      const { box, cwd } = arrangeRecoveryReviewFixture('healthy')
      roots.add(box.root)
      const gh = join(box.root, 'bin', 'gh')
      unlinkSync(gh)
      symlinkSync(resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts'), gh)
      const ghConfig = join(box.root, 'gh-config')
      mkdirSync(ghConfig)
      const env: NodeJS.ProcessEnv = {
        ...box.env,
        HOME: box.root,
        GH_CONFIG_DIR: ghConfig,
        GH_SIM_STATE: box.stateFile,
        RECOVERY_TEST_CREDENTIAL: 'fixture-model-only',
      }
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'])
        delete env[key]
      const invoke = (mode: string, actionFile = '') => {
        const child = spawnSync(
          bun,
          [worker, mode, cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} }), actionFile],
          { cwd, env, encoding: 'utf8', timeout: 30_000 },
        )
        expect(
          child.status,
          `${mode}: signal=${child.signal} error=${String(child.error)}\n${child.stderr}\n${child.stdout}`,
        ).toBe(0)
        const line = child.stdout
          .trim()
          .split('\n')
          .findLast((item) => item.startsWith('{"mode"'))
        if (!line) throw new Error(`worker output missing: ${child.stdout}`)
        return { ...JSON.parse(line), workerStderr: child.stderr }
      }
      const cold = () => {
        const child = spawnSync(
          bun,
          [runner, 'continue', cwd, JSON.stringify({ reference: '#42', control: 'continue' })],
          { cwd, env, encoding: 'utf8', timeout: 30_000 },
        )
        expect(
          child.status,
          `cold: signal=${child.signal} error=${String(child.error)}\n${child.stderr}\n${child.stdout}`,
        ).toBe(0)
        return JSON.parse(child.stdout)
      }
      expect(invoke('prelude').result.qualityStatus).toBe(1)
      const first = invoke('initial')
      expect(
        first.called,
        JSON.stringify({
          notifications: first.notifications,
          messages: first.messages,
          errors: first.errors,
          workerStderr: first.workerStderr,
        }),
      ).toBe(true)
      expect(first.dispatches).toEqual(['ci-native'])
      expect(first.children.length).toBeGreaterThan(0)
      const results = () =>
        pullHistory(box).operations.flatMap(({ record }) =>
          record?.kind === 'action-receipt' &&
          record.payload.action === 'attribute-ci' &&
          record.payload.phase === 'result'
            ? [record]
            : [],
        )
      const negative = results()[0]
      if (negative?.payload.action !== 'attribute-ci' || negative.payload.phase !== 'result')
        throw new Error('native CI negative missing')
      expect(negative.payload).toMatchObject({
        native: { completion: 'completed', strict: 'valid' },
        structured: { outcome: 'missing-context' },
      })
      const retained = JSON.stringify(negative)
      const starts = () =>
        pullHistory(box).operations.flatMap(({ record }) =>
          record?.kind === 'action-receipt' &&
          record.payload.action === 'attribute-ci' &&
          record.payload.phase === 'start'
            ? [record]
            : [],
        )
      const beforeCold = readSim(box).prs['7']?.comments ?? []
      const originalStarts = JSON.stringify(starts())
      expect(cold()).toMatchObject({ kind: 'blocked' })
      const afterCold = readSim(box).prs['7']?.comments ?? []
      expect(afterCold.slice(0, beforeCold.length)).toEqual(beforeCold)
      expect(afterCold.slice(beforeCold.length)).toHaveLength(1)
      const withdrawal = afterCold[beforeCold.length]?.body.split('\n')
      expect(withdrawal?.[0]).toBe('<!-- kit-head-authorization:v1 -->')
      const barrier = JSON.parse(withdrawal?.[1] ?? '{}')
      expect(barrier).toMatchObject({
        kind: 'withdraw',
        pullRequest: 7,
        lane: 'all',
        source: 'revoke',
        evidence: 'native lifecycle disarm',
      })
      expect(beforeCold.some((comment) => comment.id === barrier.previous)).toBe(true)
      expect(JSON.stringify(starts())).toBe(originalStarts)
      expect(JSON.stringify(results()[0])).toBe(retained)
      const inputs = negative.payload.inputs
      const manifest = inputs.manifest
      const actionFile = join(box.root, 'ci-expanded.json')
      const foreignFile = join(box.root, 'ci-foreign.json')
      const priorRefs = [
        ...manifest.expandedContext,
        ...manifest.acceptedSources,
        ...manifest.deliveryData,
        ...manifest.repositoryReferences,
        ...inputs.stageSources,
      ]
      const prior = new Set(priorRefs.map(canonicalValueDigest))
      const extra = ['README.md', 'region.test.ts', 'package.json', '.dev/stack.yml', 'src/save.ts']
        .map((path) => ({
          source: 'git-file' as const,
          repository: PULL_SCOPE.repository,
          commit: manifest.code.head,
          path,
          digest: createHash('sha256')
            .update(execFileSync('git', ['show', `${manifest.code.head}:${path}`], { cwd }))
            .digest('hex'),
        }))
        .find((ref) => !prior.has(canonicalValueDigest(ref)))
      if (!extra) throw new Error('fixture has no additional pinned file context')
      const request = (recordId: string, actionId: string) => ({
        request: {
          actionId,
          purpose: manifest.purpose,
          subject: manifest.subject,
          code: manifest.code,
          ...(manifest.operands === undefined ? {} : { operands: manifest.operands }),
          stageSources: inputs.stageSources,
          expandedContext: [
            ...manifest.expandedContext,
            {
              source: 'record',
              record: { scope: PULL_SCOPE, kind: 'action-receipt', recordId },
              selector: '/payload',
              digest: canonicalValueDigest(negative.payload),
            },
            extra,
          ],
        },
      })
      writeFileSync(foreignFile, JSON.stringify(request('foreign-negative', 'foreign-ci')))
      writeFileSync(actionFile, JSON.stringify(request(negative.recordId, 'expanded-ci')))
      const refused = invoke('foreign', foreignFile)
      expect(refused.called).toBe(false)
      expect(refused.dispatches).toEqual([])
      const afterRefusal = readSim(box).prs['7']?.comments ?? []
      expect(afterRefusal.slice(0, afterCold.length)).toEqual(afterCold)
      for (const comment of afterRefusal.slice(afterCold.length)) {
        const [marker, body] = comment.body.split('\n')
        expect(marker).toBe('<!-- kit-head-authorization:v1 -->')
        expect(JSON.parse(body ?? '{}')).toMatchObject({
          kind: 'withdraw',
          source: 'revoke',
          evidence: 'native lifecycle disarm',
        })
      }
      expect(JSON.stringify(starts())).toBe(originalStarts)
      expect(JSON.stringify(results()[0])).toBe(retained)
      function assertRace() {
        const child = spawnSync(bun, [raceRunner, cwd, JSON.stringify({ ...box, env: {} }), actionFile, scenario], {
          cwd,
          env,
          encoding: 'utf8',
          timeout: 30_000,
        })
        expect(
          child.status,
          `race: signal=${child.signal} error=${String(child.error)}\n${child.stderr}\n${child.stdout}`,
        ).toBe(0)
        const race = JSON.parse(child.stdout)
        expect(race.injected).toBe(true)
        expect(race.result).toMatchObject({ kind: 'blocked', reason: 'action-start-unconfirmed' })
        if (scenario === 'binding-race')
          expect(race.records).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ kind: 'workflow-binding', recordId: 'ci-race-binding-b2' }),
            ]),
          )
        else {
          const recordId =
            scenario === 'abandon-race'
              ? 'ci-race-abandon'
              : scenario === 'pause-confirmed-race'
                ? 'ci-race-pause-confirmed'
                : 'ci-race-pause-request'
          expect(race.mandateRecords).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: 'operator-control', recordId })]),
          )
        }
        expect(starts()).toHaveLength(2)
        expect(results()).toHaveLength(1)
        expect(JSON.stringify(results()[0])).toBe(retained)
      }
      if (scenario !== 'stable') {
        assertRace()
        return
      }
      const recovered = invoke('successor', actionFile)
      expect(recovered.called, JSON.stringify(recovered)).toBe(true)
      expect(recovered.dispatches).toEqual(['ci-native'])
      expect(recovered.children.length).toBeGreaterThan(0)
      const all = results()
      expect(all).toHaveLength(2)
      expect(cold()).toMatchObject({ kind: 'terminal', reason: 'ci-attribution-refused' })
      expect(JSON.stringify(all[0])).toBe(retained)
      expect(all[1]?.payload).toMatchObject({
        actionId: 'expanded-ci',
        native: { completion: 'completed', strict: 'valid' },
        structured: { attribution: 'unknown', evidence: null },
      })
      const after = readSim(box).prs['7']?.comments ?? []
      const replay = invoke('replay', actionFile)
      expect(replay.called).toBe(false)
      expect(replay.dispatches).toEqual([])
      const afterReplay = readSim(box).prs['7']?.comments ?? []
      expect(afterReplay.slice(0, after.length)).toEqual(after)
      for (const comment of afterReplay.slice(after.length)) {
        const [marker, body] = comment.body.split('\n')
        expect(marker).toBe('<!-- kit-head-authorization:v1 -->')
        expect(JSON.parse(body ?? '{}')).toMatchObject({
          kind: 'withdraw',
          source: 'revoke',
          evidence: 'native lifecycle disarm',
        })
      }
      expect(results()).toHaveLength(2)
    },
    scenario === 'stable' ? 90_000 : undefined,
  )
}
