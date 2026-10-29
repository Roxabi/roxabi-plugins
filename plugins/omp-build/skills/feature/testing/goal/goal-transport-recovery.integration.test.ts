import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createInstalledUwReadPort, UwGraphUnavailableError } from '../../../../roxabi/uw-read-port.ts'
import { openPr } from '../../workflow-pr.js'
import { A, BRANCH_A } from './goal-scenario-domain.ts'
import { ensureChildMandate } from './goal-scenario-records.ts'
import { commitAndPush, git, sandbox } from './goal-scenario-sandbox.ts'
import { workflowGh } from './goal-simulator-port.ts'

function useEnv(env: NodeJS.ProcessEnv, fn: () => Promise<void>): Promise<void> {
  const snapshot = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'])
    delete process.env[key]
  return fn().finally(() => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, snapshot)
  })
}

describe('goal transport recovery', () => {
  it('recovers a duplicate pull through workflowGh without treating exit 1 as HTTP status', async () => {
    const box = sandbox()
    git(box.epic, ['switch', '-q', '-c', BRANCH_A])
    commitAndPush(BRANCH_A, 'feat(a): child a', 'a.txt')
    ensureChildMandate(A, BRANCH_A, 'a')
    await useEnv(box.env, async () => {
      const post = [
        'api',
        '--method',
        'POST',
        'repos/{owner}/{repo}/pulls',
        '-f',
        `head=${BRANCH_A}`,
        '-f',
        'base=main',
        '-f',
        'title=feat(a): child a',
        '-f',
        'body=UW #2',
      ]
      let created = false
      const raced = async (cwd: string, args: string[]) => {
        if (!created && args[0] === 'pr' && args[1] === 'list') {
          const listed = await workflowGh(cwd, args)
          await workflowGh(cwd, post)
          created = true
          return listed
        }
        return workflowGh(cwd, args)
      }
      const recovered = await openPr(
        box.epic,
        { issue: A, branch: BRANCH_A, base: 'main', title: 'feat(a): child a' },
        { gh: raced },
      )
      expect(recovered).toMatchObject({ status: 'existing' })
      expect(recovered.number).toBeGreaterThan(0)
      const direct = await workflowGh(box.epic, post).then(
        () => null,
        (error: Error & { status?: number; exitCode?: number; stderr?: string }) => error,
      )
      expect(direct?.exitCode).toBe(1)
      expect(direct).not.toHaveProperty('status')
      expect(direct?.stderr).toContain('HTTP 422')
    })
  })

  it('refuses a later unreadable native graph instead of replaying the first read', async () => {
    const box = sandbox()
    await useEnv(box.env, async () => {
      const scope = { repository: 'acme/app', target: 'acme/app#2' }
      const reader = createInstalledUwReadPort({ cwd: box.epic, gh: workflowGh, readAuthor: 'operator' })
      const first = await reader.readUw(scope)
      expect(first.graph.status).toBe('complete')
      expect(first.graph.nodes.some((node) => node.uw.target === scope.target)).toBe(true)
      const state = JSON.parse(readFileSync(box.stateFile, 'utf8'))
      const calls = state.calls.length
      delete state.issues['2']
      writeFileSync(box.stateFile, JSON.stringify(state, null, 2))
      await expect(reader.readUw(scope)).rejects.toBeInstanceOf(UwGraphUnavailableError)
      const after = JSON.parse(readFileSync(box.stateFile, 'utf8'))
      const added = after.calls.slice(calls)
      expect(
        added.some((argv: string[]) => argv.includes('graphql') && argv.some((arg) => arg.includes('number=2'))),
      ).toBe(true)
      expect(after.issues['2']).toBeUndefined()
    })
  })
})
