import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const [operation, cwd] = process.argv.slice(2)
if (!cwd) throw new Error('fixture-cwd-missing')
await installFixtureSdkSettings(cwd)
const { invokeDispositionBoundary, invokeDispositionPartition } = await import('./fix-disposition-lifecycle.ts')
const run = () => {
  switch (operation) {
    case 'omp-disposition-partition-valid':
      return invokeDispositionPartition(cwd, false)
    case 'omp-disposition-partition-broken':
      return invokeDispositionPartition(cwd, true)
    case 'omp-disposition-original-unavailable':
      return invokeDispositionBoundary(cwd, 'original-history')
    case 'omp-disposition-foreign-synthesis':
      return invokeDispositionBoundary(cwd, 'foreign-synthesis')
    default:
      throw new Error('fixture-operation-invalid')
  }
}
process.stdout.write(JSON.stringify(await run()))
