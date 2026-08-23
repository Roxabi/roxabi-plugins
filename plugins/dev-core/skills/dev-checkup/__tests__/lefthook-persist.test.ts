import { describe, expect, it } from 'vitest'
import { lefthookHasPrincipalFreeze, lefthookSectionBindsPrincipalFreeze } from '../../shared/lefthook-persist'

/**
 * Persist detect: lefthook.yml binds check-principal-branch.sh on both hooks.
 * A comment or a single hook is not persist.
 */

const bothHooks = `pre-commit:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
    lint:
      run: bun run lint

pre-push:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
`

describe('lefthookHasPrincipalFreeze', () => {
  it('returns true when both hooks bind principal-freeze with check-principal-branch.sh', () => {
    expect(lefthookHasPrincipalFreeze(bothHooks)).toBe(true)
  })

  it('returns false when check-principal-branch.sh appears only in comments', () => {
    const yaml = `pre-commit:
  commands:
    lint:
      run: bun run lint
    # later: bash scripts/check-principal-branch.sh

pre-push:
  commands:
    test:
      run: bun run test
    # bash scripts/check-principal-branch.sh
`
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(false)
  })

  it('returns false when only pre-commit binds', () => {
    const yaml = `pre-commit:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
`
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(false)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-commit')).toBe(true)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-push')).toBe(false)
  })

  it('returns false when a stub-looking command is not under principal-freeze', () => {
    const yaml = `pre-commit:
  commands:
    freeze-stub:
      run: bash scripts/check-principal-branch.sh

pre-push:
  commands:
    freeze-stub:
      run: bash scripts/check-principal-branch.sh
`
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(false)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-commit')).toBe(false)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-push')).toBe(false)
  })

  it('returns false when the principal-freeze run line is commented out', () => {
    const yaml = `pre-commit:
  commands:
    principal-freeze:
      # run: bash scripts/check-principal-branch.sh

pre-push:
  commands:
    principal-freeze:
      # run: bash scripts/check-principal-branch.sh
`
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(false)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-commit')).toBe(false)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-push')).toBe(false)
  })

  it('returns true when both hooks run check-principal-branch.sh via plugins/dev-core/scripts', () => {
    const yaml = `pre-commit:
  commands:
    principal-freeze:
      run: bash plugins/dev-core/scripts/check-principal-branch.sh

pre-push:
  commands:
    principal-freeze:
      run: bash plugins/dev-core/scripts/check-principal-branch.sh
`
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(true)
  })

  it('returns false when principal-freeze run is exit 0 and does not include check-principal-branch.sh', () => {
    const yaml = `pre-commit:
  commands:
    principal-freeze:
      run: exit 0

pre-push:
  commands:
    principal-freeze:
      run: exit 0
`
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(false)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-commit')).toBe(false)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-push')).toBe(false)
  })
})
