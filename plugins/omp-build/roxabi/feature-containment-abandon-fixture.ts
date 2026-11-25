import { Database } from 'bun:sqlite'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import { loadExtensions } from '@oh-my-pi/pi-coding-agent/extensibility/extensions/loader'
import { ExtensionRunner } from '@oh-my-pi/pi-coding-agent/extensibility/extensions/runner'
import { AuthStorage, SqliteAuthCredentialStore } from '@oh-my-pi/pi-coding-agent/session/auth-storage'
import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager'
import { admitFeature } from '../omp/omp-feature-admission.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { operatorDialogUi } from '../testing/operator-dialog-ui.ts'
import { createInstalledUwOperations } from './uw-installed-operations.ts'

const cwd = process.argv[2]
const artifacts = process.argv[3]
const mode = process.argv[4]
const root = mode === 'root'
const target = root
  ? { repository: 'acme/app', target: 'acme/app#42' }
  : { repository: 'acme/app', target: 'acme/app#43' }
const mandateId = root ? 'root-mandate' : 'child-mandate'
const loaded = await loadExtensions([], cwd)
const actions = (await loadExtensions([], cwd)).runtime
const database = new Database(':memory:')
const storage = new AuthStorage(new SqliteAuthCredentialStore(database))
const runner = new ExtensionRunner(
  loaded.extensions,
  loaded.runtime,
  cwd,
  SessionManager.inMemory(cwd),
  new ModelRegistry(storage),
  undefined,
  undefined,
  { getArtifactsDir: () => artifacts },
)
let displayed = ''
const ui = {
  ...runner.createContext().ui,
  ...operatorDialogUi(
    async () => 'confirm',
    (text) => {
      displayed = text
    },
  ),
}
runner.initialize(
  actions,
  {
    getModel: () => undefined,
    isIdle: () => true,
    abort: () => {
      throw new Error('Unexpected abort')
    },
    shutdown: () => {
      throw new Error('Unexpected shutdown')
    },
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    compact: async () => {
      throw new Error('Unexpected compaction')
    },
    getSystemPrompt: () => [],
  },
  undefined,
  ui,
  'tui',
)
const operator = createOperatorConfirmation(runner.createContext())
const operations = await createInstalledUwOperations({ cwd, operator })
if (root) {
  const result = await admitFeature({
    cwd,
    reference: '#42',
    control: 'abandon',
    principal: false,
    uw: operations,
  })
  if (result.kind !== 'abandoned' || !result.confirmed) {
    if (displayed !== '') throw new Error('Unexpected confirmation for a refused abandonment')
    console.log(JSON.stringify({ result }))
  } else {
    const read = await operations.readUw(target)
    if (read.observation.status !== 'complete')
      throw new Error(`Root observation incomplete: ${JSON.stringify(read.observation.diagnostics)}`)
    const history = read.histories.find((entry) => entry.source.scope.target === target.target)
    if (!history) throw new Error('Root abandonment history missing')
    const records = history.operations.flatMap((entry) =>
      entry.status === 'complete' &&
      entry.record?.kind === 'operator-control' &&
      entry.record.payload.control === 'abandon'
        ? [entry.record]
        : [],
    )
    assertConfirmation()
    console.log(JSON.stringify({ result, records }))
  }
} else {
  const result = await operations.abandon(target, { scope: target, recordId: mandateId, kind: 'mandate' })
  if (result.status !== 'abandoned') throw new Error(`Child abandonment refused: ${JSON.stringify(result)}`)
  const read = await operations.readUw(target)
  if (read.observation.status !== 'complete') throw new Error('Child observation incomplete after abandonment')
  const history = read.histories.find((entry) => entry.source.scope.target === target.target)
  if (!history) throw new Error('Child abandonment history missing')
  assertConfirmation()
  console.log(JSON.stringify(history))
}
function assertConfirmation() {
  const observed = displayed.replace(/\s+/g, '')
  if (!observed.includes(target.target) || !observed.includes(mandateId) || !observed.includes('abandon'))
    throw new Error('Abandon confirmation omitted the target, mandate, or operation')
}
database.close()
