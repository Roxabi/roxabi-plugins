import { actionRequest, confirmPreparedAction, uwSubject } from '../roxabi/delivery-action.ts'
import type { RecordInputRef, UwActionRequest } from '../roxabi/uw-action-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'

const cwd = process.argv[2]
const raw = process.argv[3]
if (!cwd || !raw) throw new Error('stale-prepare-input-missing')
const input = JSON.parse(raw) as { code: UwActionRequest['code']; ref: RecordInputRef }
const operations = await createInstalledUwOperations({
  cwd,
  operator: {
    async executeConfirmed() {
      throw new Error('Unexpected operator action')
    },
  },
})
const prepared = await confirmPreparedAction(
  operations,
  actionRequest({
    actionId: 'stale-attribution-intake',
    purpose: 'correction',
    subject: uwSubject({ repository: 'acme/app', target: 'acme/app#42' }, input.ref.record.scope),
    code: input.code,
    stageSources: [input.ref],
  }),
)
process.stdout.write(`${JSON.stringify(prepared.ok ? { ok: true } : prepared)}\n`)
