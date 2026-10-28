import { dispatchGoalWorkflow } from './goal-scenario-workflow.ts'
import { workflowGh } from './goal-simulator-port.ts'

const [, , fn, cwd, payloadText] = process.argv
const result = await dispatchGoalWorkflow(fn, cwd ?? '', JSON.parse(payloadText ?? '{}'), workflowGh)
if (result === null) {
  process.stderr.write(`unknown workflow call ${fn ?? ''}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify(result)}\n`)
