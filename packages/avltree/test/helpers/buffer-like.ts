/**
 * A Uint8Array whose `slice` returns a VIEW, as Node's `Buffer#slice` does.
 * `Buffer` type-checks as a `Uint8Array`, so code that "copies" a caller's
 * buffer with `.slice()` copies nothing for a `Buffer` caller. This class
 * reproduces that under jsdom too, where `Buffer` is not available.
 */
export class ViewSlicingBytes extends Uint8Array {
  override slice(start?: number, end?: number): ReturnType<Uint8Array['slice']> {
    return this.subarray(start, end) as ReturnType<Uint8Array['slice']>
  }
}
