import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { isolatedPinSandbox } from './isolated-pin-sandbox.ts'
import { git, sandbox } from './sandbox/sandbox-repository.ts'

const scenarios = [
  { name: 'decline', displayed: true, admitted: false },
  { name: 'escape', displayed: true, admitted: false },
  { name: 'headless', displayed: false, admitted: false },
  { name: 'child', displayed: false, admitted: false },
  { name: 'stale-candidate', displayed: true, admitted: false },
  { name: 'pending-switch', displayed: true, admitted: false },
  { name: 'pending-reload', displayed: true, admitted: false },
  { name: 'session-switch-during-validation', displayed: true, admitted: false },
  { name: 'owner-initial', displayed: false, admitted: false },
  { name: 'owner-final', displayed: true, admitted: false },
  { name: 'shared-unavailable', displayed: false, admitted: false },
  { name: 'shared-matches', displayed: false, admitted: false },
  { name: 'unreachable', displayed: false, admitted: false },
  { name: 'source-repository', displayed: false, admitted: false },
  { name: 'credential-origin', displayed: false, admitted: false },
  { name: 'lookalike-origin', displayed: false, admitted: false },
  { name: 'case-variant-origin', displayed: true, admitted: true },
  { name: 'child-factory', displayed: true, admitted: true },
  { name: 'linked', displayed: true, admitted: true },
  { name: 'other-clone', displayed: true, admitted: false },
  { name: 'other-session', displayed: true, admitted: false },
  { name: 'other-instance', displayed: true, admitted: false },
  { name: 'session-switch', displayed: true, admitted: false },
  { name: 'reload', displayed: true, admitted: false },
  { name: 'remote-changed', displayed: true, admitted: false },
  { name: 'target-changed', displayed: true, admitted: false },
] as const

it.each(scenarios)(
  'retains pin authority only for the confirmed root and scope: $name',
  ({ name, displayed, admitted }) => {
    const box = sandbox({ base: { 'README.md': 'fixture\n' }, branches: [], issues: [], prs: [] })
    try {
      const { env, candidate } = isolatedPinSandbox(box)
      const linked = join(box.root, 'linked')
      git(box, box.principal, ['worktree', 'add', '-q', '--detach', linked, 'HEAD'])
      const other = join(box.root, 'other')
      git(box, box.root, ['clone', '-q', box.origin, other])
      git(box, other, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'])
      const control = join(box.root, 'pin-control.json')
      writeFileSync(control, '{}')
      const run = spawnSync(
        'bun',
        [resolve(import.meta.dirname, 'isolated-pin-scenarios-runner.ts'), box.principal, name, linked, other],
        {
          cwd: box.principal,
          env: { ...env, PIN_CONTROL_FILE: control },
          encoding: 'utf8',
          timeout: 45_000,
        },
      )
      expect(run.status, `${name}: ${run.stderr}\n${run.stdout}`).toBe(0)
      const result = JSON.parse(run.stdout) as {
        outcome: string
        notices: string[]
        displayed: string[]
        messages: unknown[]
        artifactsBeforeActivation?: string[]
        artifactsAfterActivation?: string[]
      }
      if (displayed) expect(result.displayed.join('\n')).toContain(candidate)
      else expect(result.displayed).toEqual([])
      if (admitted) {
        expect(result.outcome).toContain('interview started')
        expect(result.messages).toContain('Build a billing export for operators')
      } else {
        expect(result.outcome).toContain('framing procedures unavailable (plugin-pin-mismatch)')
        expect(result.messages).not.toContain('Build a billing export for operators')
      }
      if (name === 'unreachable') expect(result.notices.join('\n')).toContain('tooling-pin-candidate-unreachable')
      if (name === 'source-repository') expect(result.notices.join('\n')).toContain('tooling-pin-source-repository')
      if (name === 'shared-unavailable') expect(result.notices.join('\n')).toContain('tooling-pin-shared-unavailable')
      if (name === 'shared-matches') expect(result.notices.join('\n')).toContain('tooling-pin-not-needed')
      if (name === 'credential-origin' || name === 'lookalike-origin') {
        expect(result.notices.join('\n')).toContain('tooling-pin-target-ambiguous')
        expect(result.artifactsAfterActivation).toEqual(result.artifactsBeforeActivation)
        expect(JSON.stringify(result)).not.toContain('fixture-token')
      }
      if (name === 'owner-initial' || name === 'owner-final') {
        expect(result.notices.join('\n')).toContain('tooling-pin-work-active')
        expect(result.notices.join('\n')).toContain('tooling-pin: ordinary shared pin')
      }
    } finally {
      rmSync(box.root, { recursive: true, force: true })
    }
  },
)
