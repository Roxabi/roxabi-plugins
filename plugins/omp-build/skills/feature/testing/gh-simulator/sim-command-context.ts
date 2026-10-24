import type { ParsedFlags } from './sim-graphql.ts'
import type { State } from './sim-types.ts'

export type Context = ParsedFlags & {
  state: State
  argv: string[]
  cmd: string | undefined
  sub: string | undefined
  expression: string | undefined
}

export type Route = (context: Context) => boolean
