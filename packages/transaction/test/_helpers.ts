import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export function loadFixture(name: string): { bytes: Uint8Array; meta: { id: string; note: string } } {
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, `${name}.bin`)));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  return { bytes, meta };
}
export function listFixtures(): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.bin')).map((f) => f.replace(/\.bin$/, ''));
}
export function hexToBytes(h: string): Uint8Array {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
}
export function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
