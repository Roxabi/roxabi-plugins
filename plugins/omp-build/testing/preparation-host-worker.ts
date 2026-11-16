import { open } from 'node:fs/promises'

const fifo = process.env.PREPARATION_TEST_FIFO
if (!fifo) throw new Error('fixture-fifo-missing')
const watchdog = setTimeout(() => process.exit(124), 35_000)
const gate = await open(fifo, 'r+')
process.stderr.write('ready\n')
await gate.read(Buffer.alloc(16), 0, 16, null)
await gate.close()
process.stdout.write('actual-worker-output\n')
clearTimeout(watchdog)
