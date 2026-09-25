import { randomUUID } from "node:crypto"

// ============================================================
// COLLISION-RESISTANT IDENTITY
// ============================================================
// Every producer-generated ID uses crypto.randomUUID() rather than wall-clock
// precision (Date.now()), per specs/006-runtime-stabilization/spec.md.

export function newTaskId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

/**
 * Allocates a collision-resistant ID for a Map-backed task store, retrying on
 * the astronomically unlikely event of a UUID collision (or an injected/test
 * UUID that already exists in the map).
 */
export function allocateId(prefix: string, exists: (id: string) => boolean, maxAttempts = 5): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = newTaskId(prefix)
    if (!exists(id)) return id
  }
  throw new Error(`Could not allocate a unique ID with prefix "${prefix}" after ${maxAttempts} attempts`)
}
