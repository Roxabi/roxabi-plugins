import { describe, expect, it } from 'vitest'
import { extractWriteContent, isBunTestBlocked, shouldBlockPrincipalSwitch } from '../guards'

describe('OMP dev-core hooks', () => {
  describe('bun-test guard', () => {
    it('blocks bare bun test', () => {
      expect(isBunTestBlocked('bun test')).toBe(true)
      expect(isBunTestBlocked('cd apps/api && bun test src')).toBe(true)
    })

    it('allows bun run test', () => {
      expect(isBunTestBlocked('bun run test')).toBe(false)
      expect(isBunTestBlocked('cd apps/api && bun run test')).toBe(false)
    })
  })

  describe('principal freeze pre', () => {
    it('denies git switch feat/foo on principal cwd', () => {
      const principalCwd = '/repo/principal'
      const denied = shouldBlockPrincipalSwitch('git switch feat/foo', principalCwd, process.env, {
        isPrincipalCwd: (cwd) => cwd === principalCwd,
      })
      expect(denied).toBe(true)
    })

    it('allows switch on non-principal cwd', () => {
      const denied = shouldBlockPrincipalSwitch('git switch feat/foo', '/repo/feature-wt', process.env, {
        isPrincipalCwd: () => false,
      })
      expect(denied).toBe(false)
    })

    it('honors DEV_CORE_ALLOW_PRINCIPAL_SWITCH escape hatch', () => {
      const principalCwd = '/repo/principal'
      const denied = shouldBlockPrincipalSwitch(
        'git switch feat/foo',
        principalCwd,
        { ...process.env, DEV_CORE_ALLOW_PRINCIPAL_SWITCH: '1' },
        { isPrincipalCwd: (cwd) => cwd === principalCwd },
      )
      expect(denied).toBe(false)
    })
  })

  describe('extractWriteContent', () => {
    it('reads OMP edit hashline from input', () => {
      expect(extractWriteContent({ input: '+const api_key = "abcdefgh12345"' })).toContain('api_key')
    })
  })
})
