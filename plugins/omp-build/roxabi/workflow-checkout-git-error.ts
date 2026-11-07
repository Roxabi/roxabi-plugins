function failedGitStatus(error: object): number {
  if (!('status' in error) || typeof error.status !== 'number') return 1
  return error.status
}

function failedGitOutput(error: object, field: 'stdout' | 'stderr'): string {
  if (field === 'stdout') return 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  return 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
}

export function failedGitResult(error: unknown): { code: number; stdout: string; stderr: string } {
  if (error === null || typeof error !== 'object') return { code: 1, stdout: '', stderr: '' }
  return {
    code: failedGitStatus(error),
    stdout: failedGitOutput(error, 'stdout'),
    stderr: failedGitOutput(error, 'stderr'),
  }
}
