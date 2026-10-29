import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { actionInputDigest } from '../../engine/action-input.ts'
import { sealActionSnapshot } from '../../roxabi/uw-action-snapshot.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { batch } from '../../testing/review-runtime-support.ts'
import { registerHostActionBinding } from '../review-runtime/action-registry.ts'

const dirs: string[] = []
const agent = 'R-workflow-plan'
const childId = 'slot-a'
const assignment = 'Map the accepted criteria'

function cleanupDirectories() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function preparedBatch() {
  const prepared = batch([childId])
  const task = prepared.tasks.tasks[0]
  if (!task) throw new Error('expected one native task')
  const bytes = readFileSync(new URL('../../agents/R-workflow-plan.md', import.meta.url))
  const inputs = standaloneReviewInputs()
  const plugin = inputs.manifest.plugin
  const manifest = {
    ...inputs.manifest,
    plugin: {
      ...plugin,
      files: [
        {
          source: 'git-file' as const,
          repository: plugin.repository,
          commit: plugin.commit,
          path: `${plugin.root}/agents/${agent}.md`,
          digest: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    },
  }
  const fingerprint = actionInputDigest(manifest)
  const directory = mkdtempSync(join(tmpdir(), 'omp-executed-child-'))
  dirs.push(directory)
  const profilePath = join(directory, 'plugin', 'agents', `${agent}.md`)
  mkdirSync(dirname(profilePath), { recursive: true })
  writeFileSync(profilePath, bytes)
  const index = Buffer.from('# action\n')
  const indexPath = join(directory, 'index.md')
  writeFileSync(indexPath, index)
  const snapshot = sealActionSnapshot(
    { id: 'fixture-child', actionId: childId, manifestDigest: fingerprint, indexPath, location: 'local' },
    [
      { path: 'index.md', bytes: index },
      { path: `plugin/agents/${agent}.md`, bytes },
    ],
  )
  if (!snapshot.ok) throw new Error('could not seal action fixture')
  task.agent = agent
  task.task = assignment
  task.action = { snapshot: snapshot.value, inputs: { ...inputs, manifest, fingerprint } }
  registerHostActionBinding(task.action.snapshot, task.action.inputs)
  const output = bytes
    .toString('utf8')
    .split('\n')
    .find((line) => line.startsWith('output: '))
  if (!output) throw new Error('fixture profile has no output schema')
  return { prepared, outputSchema: JSON.parse(output.slice('output: '.length)), directory }
}

export { agent, assignment, childId, cleanupDirectories, preparedBatch }
