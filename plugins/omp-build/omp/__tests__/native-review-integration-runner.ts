import { installFixtureSdkSettings } from '../../testing/native-sdk-settings-fixture.ts'

const [operation, cwd] = process.argv.slice(2)
if (!operation || !cwd) throw new Error('native review fixture arguments missing')
await installFixtureSdkSettings(cwd)

// Load fixtures that import the native runtime only after the isolated SDK settings are installed.
async function run(operation: string, cwd: string): Promise<unknown> {
  switch (operation) {
    case 'review-fix':
    case 'fresh-pause':
    case 'publication-pause': {
      const { invokeOmpReviewLifecycle } = await import('../../testing/feature-review-lifecycle.ts')
      return invokeOmpReviewLifecycle(cwd, operation === 'review-fix' ? 'fix' : operation)
    }
    case 'apply-falsify':
    case 'mixed-dispositions': {
      const { invokeOmpReviewApplyFalsify } = await import('../../testing/feature-review-lifecycle.ts')
      return invokeOmpReviewApplyFalsify(cwd, operation === 'mixed-dispositions')
    }
    case 'recall-fix': {
      const { invokeRecallFixContinuation } = await import('../../testing/feature-review-recall.ts')
      return invokeRecallFixContinuation(cwd)
    }
    case 'replacement': {
      const { invokeReplacementDispatch } = await import('../../testing/feature-review-replacement.ts')
      return invokeReplacementDispatch(cwd)
    }
    case 'latest':
    case 'owned-pause': {
      const { invokeReviewRace } = await import('../../testing/feature-review-races.ts')
      return invokeReviewRace(cwd, operation)
    }
    case 'classified-ingress': {
      const { invokeClassifiedIngressRace } = await import('../../testing/feature-classified-ingress-race.ts')
      return invokeClassifiedIngressRace(cwd)
    }
    default:
      throw new Error(`unknown native review fixture ${operation}`)
  }
}

process.stdout.write(`${JSON.stringify(await run(operation, cwd))}\n`)
