import { nativeImplementationWorld } from './native-implementation-world.ts'

/** Produce captured criterion records only from the caller's explicit native/Git world. */
export async function criterionImplementationRecords(input: Parameters<typeof nativeImplementationWorld>[0]) {
  return (await nativeImplementationWorld(input)).records
}
