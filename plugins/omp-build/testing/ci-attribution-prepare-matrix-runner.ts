import { actionRequest, confirmPreparedAction, uwSubject } from '../roxabi/delivery-action.ts'
import type { RecordInputRef, UwActionRequest } from '../roxabi/uw-action-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'

const cwd = process.argv[2]
const raw = process.argv[3]
if (!cwd || !raw) throw new Error('matrix-input-missing')
const input = JSON.parse(raw) as {
  code: UwActionRequest['code']
  scope: { repository: string; target: string }
  refs: RecordInputRef[]
}
const operations = await createInstalledUwOperations({
  cwd,
  operator: {
    async executeConfirmed() {
      throw new Error('Unexpected operator action')
    },
  },
})
const result = await confirmPreparedAction(
  operations,
  actionRequest({
    actionId: 'attribution-matrix-intake',
    purpose: 'correction',
    subject: uwSubject({ repository: 'acme/app', target: 'acme/app#42' }, input.scope),
    code: input.code,
    stageSources: input.refs,
  }),
)
process.stdout.write(`${JSON.stringify(result.ok ? { ok: true, inputs: result.value.inputs } : result)}\n`)
