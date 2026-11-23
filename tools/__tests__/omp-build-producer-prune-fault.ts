import { rmdirSync, unlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { runProducer } from '../build-omp-build-contracts.ts'

await runProducer([], (path, directory) => {
  if (basename(path) === '.02-prune-fail') throw new Error('injected unlink failure')
  if (directory) rmdirSync(path)
  else unlinkSync(path)
})
