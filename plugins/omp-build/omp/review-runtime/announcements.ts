import type { NativeBatch } from './contracts'
import type { ActiveBatch } from './state'

/** Tracks announcement admission and feature continuation independently of execution. */
export class NativeAnnouncements {
  #features = new WeakSet<NativeBatch>()
  #inhibited = false

  markFeature(batch: NativeBatch): void {
    this.#features.add(batch)
  }
  isFeature(batch: NativeBatch): boolean {
    return this.#features.has(batch)
  }
  isInhibited(): boolean {
    return this.#inhibited
  }
  release(): void {
    this.#inhibited = false
  }
  inhibit(active: ActiveBatch | null): void {
    this.#inhibited = true
    if (
      active &&
      this.#features.has(active.batch) &&
      active.announced &&
      !active.announcementDispatched &&
      active.admittedToolCallId === null
    )
      active.announcementDispatched = true
  }
  announce(active: ActiveBatch | null, batch: NativeBatch): boolean {
    if (
      (this.#inhibited && this.#features.has(batch)) ||
      !active ||
      active.settling ||
      active.batch !== batch ||
      active.announced
    )
      return false
    active.announced = true
    return true
  }
  takeIdle(active: ActiveBatch | null, batch: NativeBatch, idle: boolean): NativeBatch | null {
    if (
      !active ||
      (this.#inhibited && this.#features.has(active.batch)) ||
      active.settling ||
      active.batch !== batch ||
      !active.announced ||
      active.announcementDispatched ||
      !idle
    )
      return null
    active.announcementDispatched = true
    return active.batch
  }
  consume(active: ActiveBatch | null): NativeBatch | null {
    if (
      !active ||
      (this.#inhibited && this.#features.has(active.batch)) ||
      active.settling ||
      !active.announced ||
      active.announcementDispatched ||
      active.admittedToolCallId !== null
    )
      return null
    active.announcementDispatched = true
    return active.batch
  }
}
