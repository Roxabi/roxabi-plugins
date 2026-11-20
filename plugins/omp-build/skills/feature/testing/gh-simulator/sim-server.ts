import { randomUUID } from 'node:crypto'
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { executeFaultCommand } from '../../../../testing/fix-recovery-gh-fault-core.ts'
import { executeSimCommand, type SimCommandResult } from './sim-execution.ts'

const token = process.argv[2]
const directory = process.argv[3]
if (!token || !directory) throw new Error('gh simulator server: missing token or directory')

type SocketData = {
  chunks: Buffer[]
  size: number
  handled: boolean
  response?: Buffer
  offset: number
}

function flushResponse(socket: Bun.Socket<SocketData>) {
  const response = socket.data.response
  if (!response) return
  while (socket.data.offset < response.length) {
    const written = socket.write(response.subarray(socket.data.offset))
    if (written < 0) {
      socket.data.response = undefined
      return
    }
    socket.data.offset += written
    if (socket.data.offset < response.length) return
  }
  socket.data.response = undefined
  socket.end()
}

function respond(socket: Bun.Socket<SocketData>, response: string) {
  socket.data.response = Buffer.from(response)
  socket.data.offset = 0
  flushResponse(socket)
}

function readFields(request: Buffer): string[] {
  const fields: string[] = []
  let start = 0
  for (let i = 0; i < request.length; i++) {
    if (request[i] !== 0) continue
    fields.push(request.toString('utf8', start, i))
    start = i + 1
  }
  return fields
}

function executeRequest(socket: Bun.Socket<SocketData>, fields: string[], argc: number, mode: 'sim' | 'fault') {
  try {
    const pid = fields[1]
    const cwd = readlinkSync(`/proc/${pid}/cwd`)
    const env: NodeJS.ProcessEnv = {}
    for (const item of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const separator = item.indexOf('=')
      if (separator > 0) env[item.slice(0, separator)] = item.slice(separator + 1)
    }
    env.OMP_GH_SIM_SERVER_REQUEST = '1'
    const stdinPath = fields[3 + argc]
    const oldCwd = process.cwd()
    const oldEnv = process.env
    let result: SimCommandResult & { awaitRelease?: string; awaitDeadline?: number }
    try {
      process.chdir(cwd)
      process.env = env
      result = (mode === 'fault' ? executeFaultCommand : executeSimCommand)(fields.slice(3, 3 + argc), {
        cwd,
        env,
        pid: Number(pid),
        readStdin: () => {
          if (!stdinPath) throw new Error('gh simulator: stdin was not staged')
          return readFileSync(stdinPath, 'utf8')
        },
      })
    } finally {
      process.env = oldEnv
      process.chdir(oldCwd)
    }
    let stderrPath = '-'
    if (result.stderr) {
      stderrPath = path.join(directory, `stderr-${randomUUID()}`)
      writeFileSync(stderrPath, result.stderr, { mode: 0o600 })
    }
    let releasePath = '-'
    if (result.awaitRelease) {
      releasePath = path.join(directory, `release-${randomUUID()}`)
      writeFileSync(releasePath, `${result.awaitRelease}\0${result.awaitDeadline}\0`, { mode: 0o600 })
    }
    respond(socket, `${result.status}\0${stderrPath}\0${releasePath}\0${result.stdout}`)
  } catch (error) {
    const stderrPath = path.join(directory, `stderr-${randomUUID()}`)
    writeFileSync(stderrPath, `gh simulator: ${String(error)}\n`, { mode: 0o600 })
    respond(socket, `1\0${stderrPath}\0-\0`)
  }
}

const server = Bun.listen<SocketData>({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open(socket) {
      socket.data = { chunks: [], size: 0, handled: false, offset: 0 }
    },
    data(socket, data) {
      if (socket.data.handled) return
      socket.data.chunks.push(Buffer.from(data))
      socket.data.size += data.length
      const fields = readFields(Buffer.concat(socket.data.chunks, socket.data.size))
      if (fields.length < 4) return
      const argc = Number(fields[2])
      if (!Number.isSafeInteger(argc) || argc < 0 || argc > 100000) {
        socket.data.handled = true
        respond(socket, '1\0!\0-\0')
        return
      }
      if (fields.length < 5 + argc) return
      socket.data.handled = true
      socket.data.chunks = []
      if (fields[0] !== token || !/^\d+$/.test(fields[1] ?? '')) {
        respond(socket, '1\0!\0-\0')
        return
      }
      const mode = fields[4 + argc]
      if (mode !== 'sim' && mode !== 'fault') {
        respond(socket, '1\0!\0-\0')
        return
      }
      executeRequest(socket, fields, argc, mode)
    },
    drain(socket) {
      flushResponse(socket)
    },
  },
})
process.stdout.write(`${server.port}\n`)
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
