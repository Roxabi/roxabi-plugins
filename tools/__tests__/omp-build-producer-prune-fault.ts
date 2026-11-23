import { rmdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runProducer } from '../build-omp-build-contracts.ts'

await runProducer([], (path, directory) => {
  if (basename(path) === '.02-prune-fail') throw new Error('injected unlink failure')
  // A stale entry that aliases a produced output, as a differently cased name does on a case-insensitive filesystem.
  if (basename(path) === '.04-case-alias') unlinkSync(join(dirname(dirname(path)), 'dist', 'contracts.d.ts'))
  if (directory) rmdirSync(path)
  else unlinkSync(path)
})
