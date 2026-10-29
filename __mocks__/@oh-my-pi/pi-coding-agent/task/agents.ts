import { vi } from 'vitest'

// A redirect mock avoids Vitest's shared callstack race for concurrent imports.
export const parseAgent = vi.fn()
