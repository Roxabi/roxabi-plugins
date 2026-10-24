import { vi } from 'vitest'
import type { Deps as HotfixDensityDeps } from '../lib/hotfix-density-domain'
import type { Deps as PinSwapDeps } from '../lib/pin-swap-contract'

export function commandResponses(responses: Record<string, string | Error>): Pick<HotfixDensityDeps, 'run'> {
  return {
    run: vi.fn(async (cmd: string[]) => {
      const command = cmd.join(' ')
      for (const [pattern, response] of Object.entries(responses)) {
        if (!command.includes(pattern)) continue
        if (response instanceof Error) throw response
        return response
      }
      throw new Error(`Unexpected command: ${command}`)
    }),
  }
}

export function promoteReadback(opts: {
  tags?: string
  promoLog?: string
  commits?: string
  prShas?: string
}): HotfixDensityDeps {
  return {
    run: vi.fn(async (cmd: string[]) => {
      const command = cmd.join(' ')
      if (command.includes('git tag --list')) return opts.tags ?? ''
      if (command.includes('git log') && command.includes('main') && command.includes('merges'))
        return opts.promoLog ?? ''
      if (command.includes('git log') && command.includes('main..staging')) return opts.commits ?? ''
      if (command.includes('gh pr list')) return opts.prShas ?? ''
      throw new Error(`Unexpected command: ${command}`)
    }),
  }
}

export function pinSwapDeps(sha: string, overrides: Partial<PinSwapDeps> = {}): PinSwapDeps {
  const pyproject = [
    '[tool.uv.sources]',
    'roxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }',
  ].join('\n')
  const uvLock = [
    '[[package]]',
    'name = "roxabi-nats"',
    `source = { git = "https://github.com/Roxabi/roxabi-nats", rev = "${sha}" }`,
  ].join('\n')
  const lsRemote = [
    `${sha}\trefs/tags/roxabi-nats/v1.2.3^{}`,
    'deadbeef0000deadbeef0000deadbeef0000dead\trefs/tags/roxabi-nats/v1.2.3',
  ].join('\n')
  return {
    readFile: vi.fn((path: string) => {
      if (path.endsWith('pyproject.toml')) return pyproject
      if (path.endsWith('uv.lock')) return uvLock
      throw new Error(`unexpected readFile: ${path}`)
    }),
    writeFile: vi.fn(),
    run: vi.fn().mockResolvedValue(lsRemote),
    ...overrides,
  }
}
