import type { Header } from '@ergots/scorex';
import type { PoPowHeader } from '../src/popow-header.ts';
import type { PopowHeaderReader } from '../src/prover.ts';
import { bytesToHex } from './helpers.ts';

/** In-memory reader over a PoPowHeader chain, with call counting. */
export class MemoryReader implements PopowHeaderReader {
  calls = 0;
  constructor(private readonly chain: PoPowHeader[]) {}
  private byId(id: Uint8Array): PoPowHeader | null {
    return this.chain.find(p => bytesToHex(p.header.id) === bytesToHex(id)) ?? null;
  }
  async headersHeight(): Promise<number> { this.calls++; return this.chain.length; }
  async popowHeaderById(id: Uint8Array): Promise<PoPowHeader | null> { this.calls++; return this.byId(id); }
  async popowHeaderAtHeight(h: number): Promise<PoPowHeader | null> {
    this.calls++; return this.chain[h - 1] ?? null;
  }
  async lastHeaders(n: number): Promise<Header[]> {
    this.calls++; return this.chain.slice(-n).map(p => p.header);
  }
  async bestHeadersAfter(header: Header, n: number): Promise<Header[]> {
    this.calls++;
    return this.chain.slice(header.height, header.height + n).map(p => p.header);
  }
}
