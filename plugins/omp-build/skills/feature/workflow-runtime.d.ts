import type { Gh, Git } from './proof-base.ts'

export type { Gh, Git, GitResult } from './proof-base.ts'

export type Stringable = string | number | boolean | bigint | symbol | null | undefined | { toString(): string }

export declare function shellQuote(value: Stringable): string
export declare function ciWatchSh(): string
export declare function stripGitHookEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export declare const gitResult: Git
export declare function git(cwd: string, args: readonly string[]): Promise<string>
export declare const gh: Gh
export declare function preview(raw?: Stringable): string
export declare function errorText(error: Error | Stringable): string
export declare function stuckError(disarmError: Error | Stringable, readError?: Error | Stringable): Error
