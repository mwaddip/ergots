import { describe, it, expect } from 'vitest';
import { ByteReader } from '../src/index.ts';

// The activated script version a reader's trees are parsed under: the first half of the JVM's
// VersionContext, a thread-local there (sigma-state v6.0.6 sigma/VersionContext.scala:17, :68-69).
describe('ByteReader.activatedVersion', () => {
  it('is unset on a fresh reader: a parse outside any version context', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3]));
    expect(r.activatedVersion).toBeUndefined();
    expect('activatedVersion' in r).toBe(true);
  });

  it('holds what a caller sets, a negative version included', () => {
    const r = new ByteReader(new Uint8Array([1]));
    r.activatedVersion = 3;
    expect(r.activatedVersion).toBe(3);
    r.activatedVersion = -128;
    expect(r.activatedVersion).toBe(-128);
    r.activatedVersion = undefined;
    expect(r.activatedVersion).toBeUndefined();
  });

  it.each([-128, -1, 0, 1, 127])('holds every signed byte: %i', (v) => {
    const r = new ByteReader(new Uint8Array([1]));
    r.activatedVersion = v;
    expect(r.activatedVersion).toBe(v);
  });

  // The JVM's activated version is a Byte. A value that is none would compare as nothing in a tree parse.
  it.each([
    ['NaN', NaN], ['a fraction', 3.5], ['128', 128], ['-129', -129], ['Infinity', Infinity],
    ['a string', '3'], ['null', null], ['a boolean', true], ['a bigint', 3n],
  ])('%s is a TypeError, and the value it had stays', (_name, v) => {
    const r = new ByteReader(new Uint8Array([1]));
    r.activatedVersion = 2;
    expect(() => { r.activatedVersion = v as never; }).toThrow(TypeError);
    expect(() => { r.activatedVersion = v as never; }).toThrow(/an integer from -128 to 127 or undefined/);
    expect(r.activatedVersion).toBe(2);
  });

  it('reads and position changes leave it as set', () => {
    const r = new ByteReader(new Uint8Array([0x05, 0x80, 0x01, 0xaa, 0xbb]));
    r.activatedVersion = 2;
    r.readU8();
    r.readVlqU();
    r.readBytes(2);
    r.position = 0;
    r.positionLimit = 3;
    expect(r.activatedVersion).toBe(2);
  });

  it('a fork carries it', () => {
    const parent = new ByteReader(new Uint8Array([1, 2, 3]));
    parent.activatedVersion = 2;
    const sub = parent.forkSubReader(new Uint8Array([9]));
    expect(sub.activatedVersion).toBe(2);
  });

  it('a fork of a reader without one has none', () => {
    const sub = new ByteReader(new Uint8Array([1])).forkSubReader(new Uint8Array([9]));
    expect(sub.activatedVersion).toBeUndefined();
    expect('activatedVersion' in sub).toBe(true);
  });

  it('a fork keeps its own: the parent set afterwards does not reach it', () => {
    const parent = new ByteReader(new Uint8Array([1, 2, 3]));
    parent.activatedVersion = 3;
    const sub = parent.forkSubReader(new Uint8Array([9]));
    parent.activatedVersion = 1;
    expect(sub.activatedVersion).toBe(3);
    sub.activatedVersion = 0;
    expect(parent.activatedVersion).toBe(1);
  });
});
