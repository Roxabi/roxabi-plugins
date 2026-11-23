import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { isolatedPinSandbox } from './isolated-pin-sandbox.ts'
import { git, readSim, sandbox } from './sandbox/sandbox-repository.ts'

it('confirms a framed UW and continues at its moved destination with the activated pin', () => {
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\nrelease:\n  model: trunk\n', 'README.md': 'fixture\n' },
    branches: [],
    issues: [],
    prs: [],
  })
  try {
    git(box, box.root, ['--git-dir', box.origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(box, box.principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const pin = isolatedPinSandbox(box)
    const bin = join(box.root, 'framing-bin')
    mkdirSync(bin)
    symlinkSync(resolve(import.meta.dirname, 'isolated-pin-framing-gh.ts'), join(bin, 'gh'))
    const run = spawnSync('bun', [resolve(import.meta.dirname, 'isolated-pin-framing-runner.ts'), box.principal], {
      cwd: box.principal,
      env: { ...pin.env, PATH: `${bin}:${pin.env.PATH}` },
      encoding: 'utf8',
      timeout: 90_000,
    })
    expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
    const result = JSON.parse(run.stdout) as {
      statuses: string[]
      notices: string[]
      displayed: string[]
      deliveries: string[]
      destination: string
    }
    expect(result.displayed.join('\n')).toContain(pin.candidate)
    const evidence = JSON.stringify(result)
    const composed = result.deliveries.filter((message) => message.includes('## Feature context'))
    expect(composed, evidence).toHaveLength(1)
    expect(composed[0], evidence).toContain('repository: acme/app\nissue: 1')
    expect(composed[0], evidence).toContain(`worktree: ${result.destination}`)
    expect([...result.notices, ...result.deliveries].join('\n'), evidence).not.toContain('OMP_BUILD_NATIVE_BATCH')
    expect(result.statuses.join('\n'), evidence).not.toContain('plugin-pin-mismatch')
    expect(result.destination).not.toBe(box.principal)
    const issue = readSim(box).issues['1']
    expect(issue.title).toBe('Billing export')
    expect(issue.body).toContain('Operators can export billing data')
    expect(issue.comments.length).toBeGreaterThan(0)
    const history = decodeHistory({
      scope: { repository: 'acme/app', target: 'acme/app#1' },
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: issue.comments.map((comment, index) => ({
        locator: `acme/app#1:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
    const records = history.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
    expect(records, evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'mandate' })]))
    expect(
      records.some((record) => record.kind === 'action-receipt'),
      evidence,
    ).toBe(false)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})
