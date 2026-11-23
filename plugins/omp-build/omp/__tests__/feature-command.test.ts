import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as contracts from '../../dist/contracts.js'
import type { FeatureAuthority } from '../../roxabi/feature-continuation-admission.ts'
import * as admission from '../../roxabi/feature-continuation-admission.ts'
import { applyFeatureControl } from '../../roxabi/feature-continuation-controls.ts'
import * as observation from '../../roxabi/feature-continuation-observation.ts'
import * as selection from '../../roxabi/feature-continuation-selection.ts'
import type { ContinueFeatureInput, FeatureWorkflow } from '../../roxabi/feature-contract'
import * as checkout from '../../roxabi/feature-selection.ts'
import { createUwAbandon } from '../../roxabi/uw-abandon.ts'
import type { OperatorPort, UwOperations } from '../../roxabi/uw-contract.ts'
import * as issues from '../../roxabi/uw-spec/index.ts'
import { createExtensionApiStub, fixtureEventBus } from '../../testing/extension-api-stub'
import { provisionNativeRoot } from '../../testing/native-root-fixture.ts'
import { consultableAgentRoot, consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import ompBuildExtension from '../index'
import { INSTALL_ROOT } from '../install-root.ts'
import type { OmpBuildExtensionOptions } from '../omp-commands'
import { reviewControllerFor } from '../omp-controller'

const root = {
  ...consultableAgentRoot(),
  cwd: '/repo/feature',
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

beforeEach(() => {
  root.localProtocolOptions = consultableProtocolOptions()
  Object.assign(root.sessionManager, { getArtifactsDir: root.localProtocolOptions.getArtifactsDir })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function workflow(impl: Partial<FeatureWorkflow> = {}): FeatureWorkflow {
  return { continueFeature: async () => ({ kind: 'blocked', reason: 'unconfigured' }), ...impl }
}

function installed(
  options: OmpBuildExtensionOptions,
  exec?: (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ) => Promise<{ code: number; killed: boolean; stdout: string; stderr: string }>,
) {
  const sent: string[] = []
  const commands = new Map<string, { handler: (args: string, ctx: typeof root) => Promise<void> }>()
  const tools = new Set<string>()
  const sessions = new Map<string, (event: { signal: AbortSignal }, ctx: typeof root) => void | Promise<void>>()
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const registered = new Map<string, Array<(...args: never[]) => unknown>>()
  const raw = new Map<string, (value: unknown) => void>()
  const registeredRaw = new Map<string, Array<(value: unknown) => void>>()
  const pi = createExtensionApiStub({
    on: (event, handler) => {
      const listeners = registered.get(event) ?? []
      listeners.push(handler as (...args: never[]) => unknown)
      registered.set(event, listeners)
      const dispatch = async (...args: never[]) => {
        for (const listener of listeners) {
          const result = await listener(...args)
          if (result !== undefined) return result
        }
      }
      handlers.set(event, dispatch)
      sessions.set(event, async (session, ctx) => {
        await dispatch(session as never, ctx as never)
      })
    },
    events: fixtureEventBus((event, handler) => {
      const listeners = registeredRaw.get(event) ?? []
      listeners.push(handler)
      registeredRaw.set(event, listeners)
      raw.set(event, (value) => {
        for (const listener of listeners) listener(value)
      })
      return () => undefined
    }),
    registerCommand: (name, command) => {
      commands.set(name, command as { handler: (args: string, ctx: typeof root) => Promise<void> })
    },
    registerTool: (tool) => {
      tools.add(tool.name)
    },
    sendUserMessage: async (content) => {
      sent.push(String(content))
    },
    sendMessage: (message) => {
      sent.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
    ...(exec === undefined ? {} : { exec }),
  })
  provisionNativeRoot(root)
  ompBuildExtension(pi, { principalCwd: () => false, ...options })
  return { sent, commands, tools, sessions, handlers, raw, pi }
}

describe('installed /feature command', () => {
  it('returns session-cwd and /move on the principal and does not announce a batch', async () => {
    const calls: string[] = []
    const host = installed({
      principalCwd: () => true,
      featureWorkflow: workflow({
        continueFeature: async (input) => {
          calls.push(input.control)
          return { kind: 'session-cwd', path: input.cwd, instruction: `/move ${input.cwd}` }
        },
      }),
    })
    await host.commands.get('feature')?.handler('#12', root)
    expect(calls).toEqual(['select'])
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]).toContain('/move /repo/feature')
    expect(host.sent[0]).toContain('/repo/feature')
    expect(host.sent.join('\n')).not.toContain('OMP_BUILD_NATIVE_BATCH')
    expect(host.sent.join('\n')).not.toContain('disarmed')
  })

  it.each(['unbound', 'open', 'closed'] as const)('composes on entry and re-entry with a %s PR', async (prState) => {
    const scope = { repository: 'acme/widgets', target: 'acme/widgets#12' }
    const mandate = {
      ...scope,
      recordId: 'mandate-1',
      payload: { branch: 'feat/12-widgets', base: 'main', parent: null },
    }
    const active = { status: 'applicable', mandate }
    const authority = {
      context: { git: vi.fn(), cwd: root.cwd },
      scope,
      selection: active,
      onPrincipal: false,
      identity: { ok: true, sessionTop: root.cwd },
    } as unknown as FeatureAuthority
    const current = {
      snapshot: {
        spec: { version: 'version-1' },
        raw: { body: 'Accepted issue body.', bodySha256: 'a'.repeat(64) },
      },
      tier: 'S',
      children: [],
      inheritedOwnSpecRefs: [],
      coverage: null,
    }
    vi.spyOn(admission, 'resolveFeatureAuthority').mockResolvedValue(authority)
    const issue = { body: 'An unaccepted edit to the criterion.' }
    vi.spyOn(selection, 'selectFeatureMandate').mockResolvedValue({
      authority,
      issue,
      number: 12,
      mandate,
      acceptedSpec: current,
    } as unknown as selection.SelectedFeature)
    vi.spyOn(checkout, 'requireMandateCheckout').mockResolvedValue(null)
    const source = {
      uw: { ...scope, target: 'acme/widgets#10' },
      version: 'parent-version',
      sourceAccepted: { recordId: 'parent-assessment' },
    }
    const own = { uw: scope, version: 'version-1', sourceAccepted: { recordId: 'mandate-1' } }
    const spec = {
      criteria: [{ id: 'C1', statement: 'Keep the accepted criterion.' }],
      invariants: [{ id: 'I1', statement: 'Keep the accepted invariant.' }],
      exclusions: ['No changes to the renderer.'],
      inherited: {
        invariants: [{ target: { spec: source, id: 'I2' }, statement: 'Keep the inherited invariant.' }],
        exclusions: [{ ref: { spec: source, index: 0 }, statement: 'No public API changes.' }],
      },
    }
    vi.spyOn(contracts, 'resolveSpecEffective').mockReturnValue({
      ok: true,
      value: { own, spec, inherited: spec.inherited },
    } as never)
    const pr = { number: 34, scope: { ...scope, target: 'acme/widgets#34' }, ...mandate.payload }
    vi.spyOn(contracts, 'selectWorkflowBinding').mockReturnValue(
      prState === 'unbound' ? { status: 'absent' } : ({ status: 'bound', mandateRecord: mandate } as never),
    )
    const readPr = vi.spyOn(contracts, 'readNativePullRequestFacts').mockResolvedValue({
      state: prState === 'open' ? 'OPEN' : 'CLOSED',
      branch: pr.branch,
      base: pr.base,
    } as never)
    vi.spyOn(observation, 'assembleObservationBase').mockResolvedValue({
      facts: { currentSpec: current },
      evidence: { issue: { source: { scope }, operations: [] }, causal: { histories: [], observation: { graph: {} } } },
      deliveryAdmission: { admission: { deliverable: { diagnostics: [] } } },
      delivery: pr,
    } as unknown as observation.FeatureAdmissionObservation)
    const exec = vi.fn()
    const host = installed({ uwOperations: () => ({}) as UwOperations }, exec)
    const dir = join(INSTALL_ROOT, 'skills', 'feature')
    const body = readFileSync(join(dir, 'SKILL.md'), 'utf8').split(/^---$/m)[2]?.trim()
    const message = [
      body,
      '',
      `[Skill directory: ${dir}]`,
      '',
      '## Feature context',
      'repository: acme/widgets',
      'issue: 12',
      'mandate: mandate-1',
      'branch: feat/12-widgets',
      'base: main',
      'worktree: /repo/feature',
      ...(prState === 'open' ? ['pr: 34'] : []),
      '',
      '## Accepted Spec',
      'The live issue body differs from the accepted snapshot.',
      '',
      '```json',
      JSON.stringify(
        {
          own,
          acceptedBodySha256: 'a'.repeat(64),
          criteria: spec.criteria,
          invariants: spec.invariants,
          exclusions: spec.exclusions,
          inherited: spec.inherited,
        },
        null,
        2,
      ),
      '```',
    ].join('\n')
    await host.commands.get('feature')?.handler('#12', root)
    expect(host.sent).toEqual([message])
    issue.body = current.snapshot.raw.body
    await host.commands.get('feature')?.handler('#12', root)
    expect(host.sent).toEqual([
      message,
      message.replace('The live issue body differs from the accepted snapshot.\n', ''),
    ])
    expect(exec).not.toHaveBeenCalled()
    expect(readPr).toHaveBeenCalledTimes(prState === 'unbound' ? 0 : 2)
    expect(reviewControllerFor(host.pi).active()).toBeNull()
  })

  it('stops a native parent before mandate or checkout work', async () => {
    const scope = { repository: 'acme/widgets', target: 'acme/widgets#12' }
    const child = { repository: scope.repository, target: 'acme/widgets#13' }
    const git = vi.fn()
    const readUw = vi.fn(async () => ({
      accepted: { status: 'absent' },
      admission: { aggregate: { status: 'none' } },
      graph: {
        status: 'complete',
        nodes: [
          { uw: scope, children: [child], labels: [] },
          { uw: child, children: [], labels: [] },
        ],
      },
    }))
    const host = installed({
      uwOperations: () => ({ readUw }) as unknown as UwOperations,
    })
    vi.spyOn(admission, 'resolveFeatureAuthority').mockResolvedValue({
      context: { git, cwd: root.cwd, engine: { resolveOwnSpecAuthority: () => ({ ok: false }) } },
      scope,
      target: { status: 'issue' },
      selection: { status: 'refused', reason: 'missing' },
    } as unknown as FeatureAuthority)
    vi.spyOn(issues, 'readSelectionIssueSpec').mockResolvedValue({ title: 'Parent', labels: [] } as never)
    await host.commands.get('feature')?.handler('#12', root)
    expect(readUw).toHaveBeenCalledOnce()
    expect(host.sent).toEqual(['Parent /feature delivery is suspended; resumes in slice 6 (#1031).'])
    expect(git).not.toHaveBeenCalled()
  })

  it.each([
    ['resume #12', 'resume', undefined],
    ['new #12', 'new', undefined],
    ['material-decision #12', 'material-decision', undefined],
    ['resolve-interruption #12 --start start-12', 'resolve-interruption', 'start-12'],
  ])('routes %s without dispatching native work', async (args, control, start) => {
    const continueFeature = vi.fn(
      async (_input: ContinueFeatureInput) => ({ kind: 'blocked', reason: 'fixture-control' }) as const,
    )
    const host = installed({ featureWorkflow: workflow({ continueFeature }) })
    await host.commands.get('feature')?.handler(args, root)
    expect(continueFeature).toHaveBeenCalledOnce()
    expect(continueFeature.mock.calls[0]?.[0]).toMatchObject({ control })
    if (start) expect(continueFeature.mock.calls[0]?.[0]).toMatchObject({ interruption: { start } })
    expect(host.sent).toEqual(['feature-stopped: fixture-control'])
  })

  it('confirms pause only from the product and never prints disarmed for an unconfirmed pause', async () => {
    const confirmed = installed({
      featureWorkflow: workflow({
        continueFeature: async () => ({ kind: 'paused', confirmed: true, reason: 'operator' }),
      }),
    })
    await confirmed.commands.get('feature')?.handler('pause #12', root)
    expect(confirmed.sent).toEqual(['pause-confirmed: operator'])

    const unconfirmed = installed({
      featureWorkflow: workflow({
        continueFeature: async () => ({ kind: 'paused', confirmed: false, reason: 'product said disarmed' }),
      }),
    })
    await unconfirmed.commands.get('feature')?.handler('pause #12', root)
    expect(unconfirmed.sent).toEqual(['pause-unconfirmed: pause-unconfirmed'])
    expect(unconfirmed.sent.join('\n')).not.toContain('disarmed')
  })

  it('does not claim abandoned unless the product confirmed publication', async () => {
    const host = installed({
      featureWorkflow: workflow({
        continueFeature: async () => ({ kind: 'abandoned', confirmed: false }),
      }),
    })
    await host.commands.get('feature')?.handler('abandon #12', root)
    expect(host.sent).toEqual(['feature-stopped: abandon-unconfirmed'])
    expect(host.sent.join('\n')).not.toContain('feature-abandoned')
  })

  it('reports the UW refusal diagnostic through /feature abandon without publishing or continuing', async () => {
    const scope = { repository: 'acme/app', target: 'acme/app#12' }
    const mandate = { kind: 'mandate', recordId: 'mandate-1', payload: { role: 'leaf', branch: 'work' } }
    const gh = vi.fn(async () => {
      throw new Error('Unexpected GitHub publication')
    })
    const confirm = vi.fn()
    const readUw = vi.fn(async () => {
      throw new Error('Native authority read failed: connection reset')
    })
    const abandon = createUwAbandon({
      reader: { readUw },
      operator: { executeConfirmed: confirm } as unknown as OperatorPort,
      github: { cwd: root.cwd, gh },
    })
    const authority = {
      context: {
        cwd: root.cwd,
        gh,
        engine: { resolveAcceptedSpec: () => ({ ok: true, spec: {} }), effectiveMandateRole: () => 'leaf' },
      },
      history: { source: { scope } },
      scope,
      selection: { status: 'applicable', mandate },
      target: null,
      parentHistories: [],
      causal: { histories: [] },
    } as unknown as FeatureAuthority
    const continuation = vi.fn(async (input: { control: string }) => {
      expect(input.control).toBe('abandon')
      return applyFeatureControl('abandon', authority, { abandon } as unknown as UwOperations)
    })
    const host = installed({ featureWorkflow: workflow({ continueFeature: continuation }) })

    await host.commands.get('feature')?.handler('abandon #12', root)

    expect(readUw).toHaveBeenCalledOnce()
    expect(confirm).not.toHaveBeenCalled()
    expect(gh).not.toHaveBeenCalled()
    expect(continuation).toHaveBeenCalledOnce()
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]).toContain('refused')
    expect(host.sent[0]).toContain('abandon-unconfirmed')
    expect(host.sent[0]).toContain('Native authority read failed: connection reset')
    expect(host.sent[0]).not.toContain('feature-abandoned')
  })

  it('rejects an argv material decision at the /uw UI boundary before creating operations', async () => {
    let created = false
    const host = installed({
      uwOperations: async () => {
        created = true
        throw new Error('operations should not be created')
      },
    })
    await host.commands.get('uw')?.handler('accept-material acme/widgets#12 accept', root)
    expect(created).toBe(false)
    expect(host.sent).toEqual(['uw-stopped: uw-reference-invalid'])
  })

  it.each([
    [{ kind: 'operator-decision', reason: 'needs-scope' }, 'operator-decision:needs-scope'],
    [{ kind: 'blocked', reason: 'branch-mismatch' }, 'branch-mismatch'],
  ] as const)('stops %j without launching framing or native work', async (result, reason) => {
    const host = installed({ featureWorkflow: { continueFeature: async () => result } })
    await host.commands.get('feature')?.handler('#12', root)
    expect(host.sent).toEqual([`feature-stopped: ${reason}`])
    expect(reviewControllerFor(host.pi).active()).toBeNull()
  })
})

describe('installed correction lane', () => {
  it('registers no correction tool while retaining the /fix command', () => {
    const host = installed({})

    expect(host.tools.has('omp_build_start_fix')).toBe(false)
    expect(host.commands.has('fix')).toBe(true)
  })

  it('specifies a publish-only composed resume bound to the same review and PR head', () => {
    const skill = readFileSync(join(INSTALL_ROOT, 'skills', 'dev-fix', 'SKILL.md'), 'utf8')
    const resume = skill.split('**Composed resume:**')[1]?.split('\n')[0]
    expect(resume).toContain('git merge-base --is-ancestor <HEAD> <tip>')
    expect(resume).toContain('`Review-Id` and `Review-Updated-At` commit trailers match `REVIEW` exactly')
    expect(resume).toContain('skip planning, editing and committing')
    const publish = skill.split('## 4. Publish')[1] ?? ''
    expect(publish).toMatch(
      /head still `HEAD`[\s\S]*latest review comment by a writer still `REVIEW` with the same `updated_at`[\s\S]*--tip <tip> --from <HEAD> --pr <PR>/,
    )
  })
})
