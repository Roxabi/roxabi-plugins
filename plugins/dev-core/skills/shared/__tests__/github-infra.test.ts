import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TokenMode } from '../adapters/github-infra'
import { APP_MINT_STEP, emitAppMintStep, PAT_RETIREMENT_BANNER, REQUIRED_SECRETS } from '../adapters/github-infra'
import { ACTION_PINS } from '../workflows/workflow-pins'

// APP_MINT_STEP now lives in the pure workflow-pins.ts (#369) so the generators do not import
// this adapter; the source-level lock follows it there.
const WORKFLOW_PINS_SRC = join(dirname(fileURLToPath(import.meta.url)), '../workflows/workflow-pins.ts')

describe('APP_MINT_STEP', () => {
  it('uses ACTION_PINS.createAppToken (single pin SSoT)', () => {
    expect(APP_MINT_STEP).toContain(ACTION_PINS.createAppToken)
  })

  it('source interpolates ACTION_PINS.createAppToken (not a same-SHA hardcode)', () => {
    // Runtime toContain alone still passes if APP_MINT_STEP hardcodes the expanded pin string.
    // A source-level lock (on workflow-pins.ts, APP_MINT_STEP's home since #369) closes that bypass.
    const source = readFileSync(WORKFLOW_PINS_SRC, 'utf-8')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: assert source template form — intentional plain string
    expect(source).toContain('${ACTION_PINS.createAppToken}')
    // The App mint step must interpolate the pin, never hardcode a `uses: owner/repo@<sha>` literal.
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
