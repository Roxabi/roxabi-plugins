import { invokeClassifiedIngressRace } from './feature-classified-ingress-race.ts'
import { invokeContextNative } from './feature-context-native-driver.ts'
import { invokeOmpIncompleteNative } from './feature-recovery-incomplete-native.ts'
import { invokeOmpLifetime } from './feature-recovery-lifetime.ts'
import { invokeOmpLiveInterleave } from './feature-recovery-live-interleave.ts'
import { invokeOmpReviewApplyFalsify, invokeOmpReviewLifecycle } from './feature-review-lifecycle.ts'
import { invokeSuccessiveReviewLineage } from './feature-review-lineage.ts'
import { invokeReviewRace } from './feature-review-races.ts'
import { invokeRecallFixContinuation } from './feature-review-recall.ts'
import { invokeReplacementDispatch } from './feature-review-replacement.ts'
import { invokeDispositionBoundary, invokeDispositionPartition } from './fix-disposition-lifecycle.ts'

type Payload = { control: 'continue' | 'resume' | 'pause' | 'abandon'; actionFile: string }
type Bridge = (
  injectUnconfirmedPause?: boolean,
  interrupt?: boolean,
) => Promise<{ messages: string[]; pausePr: number | null }>

export async function invokeSdkDriver(
  operationName: string,
  directory: string,
  payload: Payload,
  invokeOmpBridge: Bridge,
): Promise<unknown> {
  switch (operationName) {
    case 'omp-feature':
      return invokeOmpBridge(false, false)
    case 'omp-pause':
      return invokeOmpBridge()
    case 'omp-unconfirmed-pause':
      return invokeOmpBridge(true)
    case 'omp-lifetime':
      return invokeOmpLifetime(directory)
    case 'omp-incomplete-native':
    case 'omp-invalid-native':
      return invokeOmpIncompleteNative(directory, operationName === 'omp-incomplete-native')
    case 'omp-live-interleave':
      return invokeOmpLiveInterleave(directory)
    case 'omp-context-initial-negative':
      return invokeContextNative(directory, '', false, true)
    case 'omp-context-initial-common-negative':
      return invokeContextNative(directory, '', false, true, 'missing-context')
    case 'omp-context-initial-positive':
      return invokeContextNative(directory, '', true, true)
    case 'omp-context-negative':
      return invokeContextNative(directory, payload.actionFile, false)
    case 'omp-context-positive':
      return invokeContextNative(directory, payload.actionFile, true)
    case 'omp-review-apply-falsify':
      return invokeOmpReviewApplyFalsify(directory)
    case 'omp-review-mixed-dispositions':
      return invokeOmpReviewApplyFalsify(directory, true)
    case 'omp-disposition-partition-valid':
      return invokeDispositionPartition(directory, false)
    case 'omp-disposition-partition-broken':
      return invokeDispositionPartition(directory, true)
    case 'omp-disposition-original-unavailable':
      return invokeDispositionBoundary(directory, 'original-history')
    case 'omp-disposition-foreign-synthesis':
      return invokeDispositionBoundary(directory, 'foreign-synthesis')
    default:
      return invokeReviewDriver(operationName, directory, payload)
  }
}

async function invokeReviewDriver(operationName: string, directory: string, payload: Payload): Promise<unknown> {
  switch (operationName) {
    case 'omp-review-lifecycle':
      return invokeOmpReviewLifecycle(
        directory,
        payload.control === 'pause' ? 'fresh-pause' : payload.control === 'resume' ? 'publication-pause' : 'fix',
      )
    case 'omp-review-lineage':
      return invokeSuccessiveReviewLineage(directory)
    case 'omp-review-recall-fix':
      return invokeRecallFixContinuation(directory)
    case 'omp-review-replacement-real':
      return invokeReplacementDispatch(directory)
    case 'omp-review-race-latest':
    case 'omp-review-race-pause':
    case 'omp-review-race-owned-pause':
      return invokeReviewRace(
        directory,
        operationName === 'omp-review-race-latest'
          ? 'latest'
          : operationName === 'omp-review-race-owned-pause'
            ? 'owned-pause'
            : 'pause',
      )
    case 'omp-classified-ingress-race':
      return invokeClassifiedIngressRace(directory)
    default:
      throw new Error(`unknown operation ${operationName}`)
  }
}
