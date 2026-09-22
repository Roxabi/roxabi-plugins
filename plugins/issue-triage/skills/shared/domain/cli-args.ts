/**
 * Argument-parsing guards shared by every triage command.
 */

/**
 * Consume the value of a flag, refusing an absent or blank one.
 *
 * `--priority` with nothing after it, or `--priority "$P"` with an unset shell
 * variable, used to leave the option falsy — so every downstream guard was
 * skipped and the command reported success for a flag the user typed (#525).
 */
export function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index]
  if (value === undefined || value.trim() === '') {
    console.error(`Error: ${flag} requires a value`)
    process.exit(1)
  }
  return value
}
