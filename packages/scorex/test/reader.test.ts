import { describe, it, expect } from 'vitest';
import { ByteReader, ReaderError } from '../src/index.ts';

describe('ByteReader', () => {
  it('reads u8', () => {
    const r = new ByteReader(new Uint8Array([0x42, 0xff]));
    expect(r.readU8()).toBe(0x42);
    expect(r.readU8()).toBe(0xff);
    expect(r.remaining).toBe(0);
  });

  it('reads VLQ unsigned', () => {
    // 0 -> [0x00]; 127 -> [0x7f]; 128 -> [0x80, 0x01]; 16383 -> [0xff, 0x7f]
    expect(new ByteReader(new Uint8Array([0x00])).readVlqU()).toBe(0);
    expect(new ByteReader(new Uint8Array([0x7f])).readVlqU()).toBe(127);
    expect(new ByteReader(new Uint8Array([0x80, 0x01])).readVlqU()).toBe(128);
    expect(new ByteReader(new Uint8Array([0xff, 0x7f])).readVlqU()).toBe(16383);
  });

  it('reads ZigZag-VLQ signed', () => {
    // ZigZag: 0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, 2 -> 4
    expect(new ByteReader(new Uint8Array([0])).readVlqS()).toBe(0);
    expect(new ByteReader(new Uint8Array([1])).readVlqS()).toBe(-1);
    expect(new ByteReader(new Uint8Array([2])).readVlqS()).toBe(1);
    expect(new ByteReader(new Uint8Array([3])).readVlqS()).toBe(-2);
    expect(new ByteReader(new Uint8Array([4])).readVlqS()).toBe(2);
  });

  it('reads fixed-length byte slice', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5]));
    expect(r.readBytes(3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.remaining).toBe(2);
  });

  it('throws on read past end', () => {
    const r = new ByteReader(new Uint8Array([0x01]));
    r.readU8();
    expect(() => r.readU8()).toThrow(ReaderError);
  });

  it('throws on VLQ overflow (>10 bytes)', () => {
    const bombBytes = new Uint8Array(11).fill(0x80);
    expect(() => new ByteReader(bombBytes).readVlqU()).toThrow(ReaderError);
  });
});

describe('ByteReader positionLimit (lazy read window)', () => {
  /** Run `fn` expecting the window throw; assert class + code, return the error. */
  function expectPositionLimitThrow(fn: () => unknown): ReaderError {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReaderError);
    expect((caught as ReaderError).code).toBe('position-limit-exceeded');
    return caught as ReaderError;
  }

  it('defaults to the buffer length and never fires on a fresh reader (mixed primitives)', () => {
    const r = new ByteReader(new Uint8Array([0x42, 0x80, 0x01, 0x01, 0x00, 9, 8, 7]));
    expect(r.positionLimit).toBe(8);
    expect(r.readU8()).toBe(0x42); // u8
    expect(r.readVlqU()).toBe(128); // 2-byte VLQ
    expect(r.readBool()).toBe(true); // bool tag
    expect(r.readOption((rr) => rr.readU8())).toBeNull(); // option tag (0x00 = none)
    expect(r.readBytes(3)).toEqual(new Uint8Array([9, 8, 7])); // fixed run to EOF
    expect(r.isExhausted).toBe(true);
  });

  it('trips: a consuming read beginning past the limit throws position-limit-exceeded', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5]));
    r.positionLimit = 2;
    expect(r.readBytes(3)).toEqual(new Uint8Array([1, 2, 3])); // starts at 0 <= 2; cursor now 3
    const err = expectPositionLimitThrow(() => r.readU8()); // 3 > 2
    expect(err.message).toContain('position limit 2 is reached at position 3');
  });

  it('is strict >: a read beginning exactly AT the limit passes; one past it throws', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3]));
    r.positionLimit = 1;
    expect(r.readU8()).toBe(1); // position 0 < 1
    expect(r.readU8()).toBe(2); // position 1 === limit: passes (strict >)
    expectPositionLimitThrow(() => r.readU8()); // position 2 > 1
  });

  it('readBytes straddles the limit: entry check only, then all n bytes are read', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    r.positionLimit = 2;
    expect(r.readBytes(4)).toEqual(new Uint8Array([1, 2, 3, 4])); // start 0 <= 2, end 4 > 2
    expect(r.remaining).toBe(3); // bytes remain, so the next throw is the window, not EOF
    expectPositionLimitThrow(() => r.readU8());
  });

  it('readVlqBigInt straddles the limit: one entry check, continuation bytes unchecked', () => {
    // VLQ(100000) = [0xa0, 0x8d, 0x06] -- 3 bytes starting exactly AT the limit.
    const r = new ByteReader(new Uint8Array([0x00, 0xa0, 0x8d, 0x06, 0x55]));
    r.readU8(); // position 1
    r.positionLimit = 1;
    // Entry check passes (1 is not > 1); the 2nd and 3rd VLQ bytes are read at
    // positions 2 and 3, both past the limit -- a per-byte implementation
    // would throw here instead of returning the value (JVM getULong checks
    // once, then its VLQ loop reads bare).
    expect(r.readVlqBigInt()).toBe(100000n);
    expectPositionLimitThrow(() => r.readU8()); // next logical read: 4 > 1
  });

  it('readVlqBigInt beginning past the limit throws (kills the entry-check mutation)', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 0x05]));
    r.readBytes(2); // position 2
    r.positionLimit = 1;
    // readVlqBigInt's OWN entry check fires (2 > 1) before any byte is
    // consumed; without it the unchecked loop would happily return 5n.
    expectPositionLimitThrow(() => r.readVlqBigInt());
  });

  it('readBytes(n>0) beginning past the limit throws (kills the entry-check mutation)', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5]));
    r.readBytes(3); // position 3
    r.positionLimit = 2;
    // 2 bytes remain, so without readBytes' entry check this would succeed.
    expectPositionLimitThrow(() => r.readBytes(2));
  });

  it('readBytes(0) beginning past the limit throws (JVM getBytes checks before size)', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3]));
    r.readBytes(3); // position 3 (= EOF; zero-length reads would still succeed)
    r.positionLimit = 2;
    // Entry check precedes the size logic — zero-length parity with JVM
    // getBytes, which calls checkPositionLimit() before looking at size.
    expectPositionLimitThrow(() => r.readBytes(0));
  });

  it('save/set/restore: an inner window may exceed the outer; restore reinstates it', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    r.positionLimit = 2; // outer window
    r.readU8(); // position 1
    const saved = r.positionLimit;
    r.positionLimit = 6; // inner window EXCEEDS the outer -- legal (no clamp)
    expect(r.readU8()).toBe(2); // position 1 <= 6
    expect(r.readU8()).toBe(3); // position 2 <= 6
    expect(r.readU8()).toBe(4); // position 3: past the outer limit, inside the inner
    expect(r.readU8()).toBe(5); // position 4 <= 6
    r.positionLimit = saved; // restore the outer window (ErgoBoxCandidate.scala:191,235 pattern)
    expectPositionLimitThrow(() => r.readU8()); // position 5 > 2
  });

  it('forkSubReader does not inherit the parent limit: fresh default over its own buffer', () => {
    const parent = new ByteReader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    parent.positionLimit = 1; // tight parent window
    const sub = parent.forkSubReader(new Uint8Array([10, 20, 30, 40, 50]));
    expect(sub.positionLimit).toBe(5); // the sub's own buffer length, not the parent's 1
    expect(sub.readU8()).toBe(10); // position 0
    expect(sub.readU8()).toBe(20); // position 1
    expect(sub.readU8()).toBe(30); // position 2 > parent's numeric limit -- must NOT throw
    expect(sub.readU8()).toBe(40);
    expect(sub.readU8()).toBe(50);
  });

  it('setter is a plain assignment: no clamp above buffer length nor below position', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3]));
    r.positionLimit = 1000; // far above the 3-byte buffer
    expect(r.positionLimit).toBe(1000);
    r.readU8();
    r.readU8(); // position 2
    r.positionLimit = 1; // below the current position
    expect(r.positionLimit).toBe(1);
    expectPositionLimitThrow(() => r.readU8()); // 2 > 1
  });
});
