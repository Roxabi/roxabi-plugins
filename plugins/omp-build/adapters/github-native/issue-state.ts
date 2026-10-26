export type NativeGh = (cwd: string, args: string[]) => Promise<string>

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function readNativeIssueState(cwd: string, gh: NativeGh, number: number): Promise<unknown> {
  return JSON.parse(await gh(cwd, ['issue', 'view', String(number), '--json', 'state']))
}

export async function readNativeIssueStateText(cwd: string, gh: NativeGh, number: string): Promise<string> {
  return gh(cwd, ['issue', 'view', number, '--json', 'state', '--jq', '.state'])
}

export async function readNativeIssueUpdatedAt(cwd: string, gh: NativeGh, number: number): Promise<string | null> {
  const item = record(JSON.parse(await gh(cwd, ['issue', 'view', String(number), '--json', 'updatedAt'])))
  return item !== null && typeof item.updatedAt === 'string' && item.updatedAt.length > 0 ? item.updatedAt : null
}
