// Temporary Q904 runner instrumentation; remove after capture.
import { diagnostic } from './ci-diagnostic.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

export { diagnostic }

export async function loadDiagnosticExtension() {
  diagnostic('phase', 'child-entry')
  await installFixtureSdkSettings(process.argv[3] ?? '')
  diagnostic('phase', 'child-sdk-settings')
  // SDK settings must be installed before evaluating the extension.
  const { default: extension } = await import('../omp/index.ts')
  diagnostic('phase', 'child-omp-import')
  return extension
}
