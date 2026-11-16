export type FixRootLifetime = Readonly<{
  agentId: string
  registryGeneration: number
  sessionId: string
  providerSessionId: string
}>

/** Monotone observation of the originating root's lifetime. */
export class FixFenceRoot {
  #current: (() => boolean) | null = null
  #lifetime: FixRootLifetime | null = null
  #lost = false

  bind(current: () => boolean, lifetime: FixRootLifetime, sealed: boolean): void {
    if (sealed || this.#current !== null) throw new Error('fix-root-already-bound')
    this.#current = current
    this.#lifetime = Object.freeze({ ...lifetime })
    if (!this.isCurrent()) throw new Error('fix-root-unavailable')
  }

  isCurrent(): boolean {
    if (this.#lost) return false
    if (this.#current === null) return true
    try {
      if (this.#current()) return true
    } catch {
      // A failed liveness observation is not evidence of a current root.
    }
    this.#lost = true
    return false
  }

  get lifetime(): FixRootLifetime | null {
    return this.#lifetime
  }
  get bound(): boolean {
    return this.#current !== null
  }
  get lost(): boolean {
    return this.#lost
  }
}
