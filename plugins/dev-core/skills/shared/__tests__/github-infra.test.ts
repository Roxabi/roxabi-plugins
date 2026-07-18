import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TokenMode } from '../adapters/github-infra'
import { APP_MINT_STEP, emitAppMintStep, PAT_RETIREMENT_BANNER, REQUIRED_SECRETS } from '../adapters/github-infra'
import { ACTION_PINS } from '../workflows/workflow-pins'

const GITHUB_INFRA_SRC = join(dirname(fileURLToPath(import.meta.url)), '../adapters/github-infra.ts')

describe('APP_MINT_STEP', () => {
  it('uses ACTION_PINS.createAppToken (single pin SSoT)', () => {
    expect(APP_MINT_STEP).toContain(ACTION_PINS.createAppToken)
  })

  it('source interpolates ACTION_PINS.createAppToken (not a same-SHA hardcode)', () => {
    // Runtime toContain alone still passes if APP_MINT_STEP hardcodes the expanded
    // pin string. Source-level lock closes that bypass after github-infra left EMITTER_PATHS (#361 review).
    const source = readFileSync(GITHUB_INFRA_SRC, 'utf-8')
    expect(source).toContain('${ACTION_PINS.createAppToken}')
    expect(source).not.toMatch(/uses:\s*[\w.-]+\/[\w.-]+@[0-9a-fA-F]{7,}/)
  })

  it('uses ROXABI_CI_APP_ID var', () => {
    expect(APP_MINT_STEP).toContain('vars.ROXABI_CI_APP_ID')
  })

  it('uses ROXABI_CI_APP_PRIVATE_KEY secret', () => {
    expect(APP_MINT_STEP).toContain('secrets.ROXABI_CI_APP_PRIVATE_KEY')
  })

  it('sets step id to app', () => {
    expect(APP_MINT_STEP).toContain('id: app')
  })

  it('never uses a floating tag', () => {
    // Ensure no @v3 or @v3.2 style floating references
    expect(APP_MINT_STEP).not.toMatch(/create-github-app-token@v\d/)
  })
})

describe('emitAppMintStep()', () => {
  it('returns APP_MINT_STEP unchanged', () => {
    expect(emitAppMintStep()).toBe(APP_MINT_STEP)
  })
})

describe('REQUIRED_SECRETS', () => {
  it('auto-merge.yml uses github-app mode', () => {
    expect(REQUIRED_SECRETS['auto-merge.yml'].mode).toBe('github-app' satisfies TokenMode)
  })

  it('auto-merge.yml has ROXABI_CI_APP_ID var', () => {
    expect(REQUIRED_SECRETS['auto-merge.yml'].var).toBe('ROXABI_CI_APP_ID')
  })

  it('auto-merge.yml has ROXABI_CI_APP_PRIVATE_KEY secret', () => {
    expect(REQUIRED_SECRETS['auto-merge.yml'].secret).toBe('ROXABI_CI_APP_PRIVATE_KEY')
  })

  it('release-please.yml uses github-app mode', () => {
    expect(REQUIRED_SECRETS['release-please.yml'].mode).toBe('github-app' satisfies TokenMode)
  })

  it('release-please.yml has ROXABI_CI_APP_ID var', () => {
    expect(REQUIRED_SECRETS['release-please.yml'].var).toBe('ROXABI_CI_APP_ID')
  })

  it('release-please.yml has ROXABI_CI_APP_PRIVATE_KEY secret', () => {
    expect(REQUIRED_SECRETS['release-please.yml'].secret).toBe('ROXABI_CI_APP_PRIVATE_KEY')
  })
})

describe('PAT_RETIREMENT_BANNER', () => {
  it('mentions PAT', () => {
    expect(PAT_RETIREMENT_BANNER).toContain('PAT')
  })

  it('mentions retiring', () => {
    expect(PAT_RETIREMENT_BANNER.toLowerCase()).toContain('retiring')
  })

  it('mentions App mode as preferred', () => {
    expect(PAT_RETIREMENT_BANNER.toLowerCase()).toContain('app mode')
  })
})

describe('TokenMode type', () => {
  it('github-app is a valid TokenMode', () => {
    const mode: TokenMode = 'github-app'
    expect(mode).toBe('github-app')
  })

  it('pat is a valid TokenMode', () => {
    const mode: TokenMode = 'pat'
    expect(mode).toBe('pat')
  })
})
