import { executeDurableUwCommand } from '../roxabi/uw-command-read.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'

const [cwd, requestFile] = process.argv.slice(2)
if (!cwd || !requestFile) throw new Error('matrix-input-missing')
const operations = await createInstalledUwOperations({
  cwd,
  operator: {
    async executeConfirmed() {
      throw new Error('Unexpected operator action')
    },
  },
})
const result = await executeDurableUwCommand({ kind: 'action', requestFile }, operations)
if (result.kind !== 'result') throw new Error(result.reason)
process.stdout.write(`${JSON.stringify(result.value)}\n`)
