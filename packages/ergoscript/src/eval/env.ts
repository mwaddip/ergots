/**
 * Env — val-def binding store. Immutable extend (clones internally on
 * each extension; original is never mutated). Mirrors sigma-rust's
 * `Env::extend` (`ergotree-interpreter/src/eval/env.rs:28-32`).
 *
 * Our immutable variant naturally implements nested-block scoping (a
 * new Env from `extend` goes out of scope when the function returns).
 * Sigma-rust uses a mutable `&mut Env` and has to manually save/restore
 * shadowed bindings; we don't.
 */

import type { SValue } from '../mir/types'

export class Env {
  private constructor(private readonly store: Map<number, SValue>) {}

  static empty(): Env {
    return new Env(new Map())
  }

  extend(id: number, v: SValue): Env {
    const next = new Map(this.store)
    next.set(id, v)
    return new Env(next)
  }

  get(id: number): SValue | undefined {
    return this.store.get(id)
  }

  has(id: number): boolean {
    return this.store.has(id)
  }
}
