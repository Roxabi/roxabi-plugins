import { afterEach, describe, expect, it } from 'vitest'

import type { CorrectionActionBinding } from './correction-execution-contract'
import { nativeMustNotStart } from './correction-native-execution.fixture-port'
import { executor } from './correction-native-execution.fixture-runner'
import { cause, cleanupWorkspaces, git, workspace } from './correction-native-execution.fixture-world'

afterEach(cleanupWorkspaces)

describe('correction publication bindings', () => {
  it('refuses a default-branch publication binding before native work', async () => {
    const fixture = workspace()
    const broken = {
      ...fixture,
      binding: {
        ...fixture.binding,
        localBranch: fixture.binding.defaultBranch,
        destinationRef: `refs/heads/${fixture.binding.defaultBranch}`,
      },
    }
    const bindings: CorrectionActionBinding[] = []
    const run = executor(broken, nativeMustNotStart(), 'operation-default-branch', bindings)

    await expect(run.apply(cause, 1)).resolves.toMatchObject({
      ok: false,
      kind: 'terminal',
      diagnostics: ['publish-binding-invalid'],
    })
    expect(bindings).toHaveLength(0)
  })

  it('refuses a publication binding whose effective origin push URL differs', async () => {
    const fixture = workspace()
    const wrongRemote = workspace()
    git(fixture.cwd, ['remote', 'set-url', '--push', 'origin', wrongRemote.binding.pushUrl])
    const bindings: CorrectionActionBinding[] = []
    const run = executor(fixture, nativeMustNotStart(), 'operation-wrong-upstream', bindings)

    await expect(run.apply(cause, 1)).resolves.toMatchObject({
      ok: false,
      kind: 'terminal',
      diagnostics: ['publish-binding-stale'],
    })
    expect(bindings).toHaveLength(0)
  })
})
