export type NativeGh = (cwd: string, args: string[]) => Promise<string>

export async function readNativeIssueState(cwd: string, gh: NativeGh, number: number): Promise<unknown> {
  return JSON.parse(await gh(cwd, ['issue', 'view', String(number), '--json', 'state']))
}

export async function readNativeIssueStateText(cwd: string, gh: NativeGh, number: string): Promise<string> {
  return gh(cwd, ['issue', 'view', number, '--json', 'state', '--jq', '.state'])
}
