import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ParsedFlags } from './sim-graphql.ts'
import type { State } from './sim-types.ts'

export type Context = ParsedFlags & {
  state: State
  argv: string[]
  cmd: string | undefined
  sub: string | undefined
  expression: string | undefined
  cwd: string
  readStdin: () => string
  writeStdout: (text: string) => void
}

export type Route = (context: Context) => boolean

/** `--body-file -` is the only stdin read. Named files are prefixed with the invocation cwd; dot segments stay literal. */
export function readBodyFile(context: Context, file: string): string {
  if (file === '-') return context.readStdin()
  if (isAbsolute(file)) return readFileSync(file, 'utf8')
  const prefixed = `${context.cwd.endsWith('/') ? context.cwd : `${context.cwd}/`}${file}`
  try {
    return readFileSync(prefixed, 'utf8')
  } catch (error) {
    throw restoreRequestedPath(error, prefixed, file)
  }
}

function restoreRequestedPath(error: unknown, resolved: string, requested: string): unknown {
  if (!(error instanceof Error)) return error
  const shown = `'${resolved}'`
  if (!error.message.includes(shown)) return error
  return new Error(error.message.split(shown).join(`'${requested}'`))
}
