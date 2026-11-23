import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
const reader = createInstalledUwReadPort({ cwd, readAuthor: 'operator' })
try {
  const read = await reader.readUw({ repository: 'acme/app', target: 'acme/app#42' })
  process.stdout.write(
    `${JSON.stringify({
      accepted: read.accepted.status,
      observation: read.observation.status,
      observationDiagnostics: read.observation.status === 'incomplete' ? read.observation.diagnostics : [],
      admission: {
        framed: read.admission.framed.ok,
        deliverable: read.admission.deliverable.ok,
      },
      fixRecovery: read.fixRecovery,
      recoveryEvidence: read.histories.map((history) => ({
        scope: history.source.scope,
        comments: history.source.comments,
        diagnostics: history.diagnostics,
        operations: history.operations,
        owners: history.operations.filter((operation) => operation.claimedKinds.includes('fix-owner')),
      })),
    })}\n`,
  )
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`)
}
