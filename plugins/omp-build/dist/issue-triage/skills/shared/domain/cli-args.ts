import { readFileSync } from 'node:fs'

/**
 * Argument-parsing guards shared by every triage command.
 */

/**
 * Consume the value of a flag, refusing one the caller never supplied.
 *
 * `--priority` with nothing after it left the option `undefined`, so every
 * downstream guard was skipped and the command reported success for a flag the
 * user typed (#525).
 *
 * `allowBlank` separates the two conditions that look alike: an enumerated or
 * reference flag can only be blank because a shell variable was unset, while
 * `--body ""` and `--label ""` are legitimate ways to say "none" and were
 * accepted before (PR #528 review).
 */
export function requireFlagValue(args: string[], index: number, flag: string, allowBlank = false): string {
  const value = args[index]
  if (value === undefined || (!allowBlank && value.trim() === '')) {
    console.error(`Error: ${flag} requires a value`)
    process.exit(1)
  }
  return value
}

/**
 * Consume a path flag and return the file's text.
 *
 * `--title` and `--body` travel as argv, so a caller that builds them from
 * untrusted text (a PR comment) has to quote them in a shell, where `$(…)`
 * and backticks still run. A file carries the text without a shell.
 */
export function readFlagFile(args: string[], index: number, flag: string): string {
  const path = requireFlagValue(args, index, flag)
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`Error: ${flag} cannot read ${path}: ${(error as Error).message}`)
    process.exit(1)
  }
}
