// Wire format for AutolykosSolution (header context):
//
// Autolykos v1 (header version == 1):
//   [minerPk: 33 bytes][powOnetimePk: 33 bytes][nonce: 8 bytes]
//   [d_len: 1 byte][d_bytes: d_len bytes]
//
// Autolykos v2 (header version >= 2):
//   [minerPk: 33 bytes][nonce: 8 bytes] = 41 bytes total
//
// This matches sigma-rust AutolykosSolution::serialize_bytes(version, w).
// The `version` is the enclosing Header's version field.

import { ByteReader } from './scorex/reader.ts';
import { ByteWriter } from './scorex/writer.ts';
import { readFixed, writeFixed, EC_POINT_LEN } from './digests.ts';

export interface AutolykosSolution {
  minerPk: Uint8Array;            // 33 bytes
  powOnetimePk: Uint8Array | null; // v1 only: 33 bytes
  nonce: Uint8Array;              // 8 bytes
  powDistance: bigint | null;     // v1 only: big-endian unsigned int from d_bytes
}

const NONCE_LEN = 8;

export function parseAutolykosSolution(reader: ByteReader, version: number): AutolykosSolution {
  const minerPk = readFixed(reader, EC_POINT_LEN, 'minerPk');
  if (version === 1) {
    // Autolykos v1: additional fields
    const powOnetimePk = readFixed(reader, EC_POINT_LEN, 'powOnetimePk');
    const nonce = readFixed(reader, NONCE_LEN, 'nonce');
    const dLen = reader.readU8();
    let powDistance = 0n;
    if (dLen > 0) {
      const dBytes = readFixed(reader, dLen, 'powDistance');
      for (const b of dBytes) {
        powDistance = (powDistance << 8n) | BigInt(b);
      }
    }
    return { minerPk, powOnetimePk, nonce, powDistance };
  } else {
    // Autolykos v2: only minerPk + nonce
    const nonce = readFixed(reader, NONCE_LEN, 'nonce');
    return { minerPk, powOnetimePk: null, nonce, powDistance: null };
  }
}

export function serializeAutolykosSolution(s: AutolykosSolution, version: number): Uint8Array {
  const w = new ByteWriter();
  writeFixed(w, s.minerPk, EC_POINT_LEN, 'minerPk');
  if (version === 1) {
    // Autolykos v1: write powOnetimePk, nonce, d_len, d_bytes
    if (!s.powOnetimePk) throw new Error('AutolykosSolution v1: powOnetimePk is required');
    if (s.powDistance === null) throw new Error('AutolykosSolution v1: powDistance is required');
    writeFixed(w, s.powOnetimePk, EC_POINT_LEN, 'powOnetimePk');
    writeFixed(w, s.nonce, NONCE_LEN, 'nonce');
    if (s.powDistance === 0n) {
      w.writeU8(0);
    } else {
      // Encode BigInt as big-endian bytes, minimal length
      let d = s.powDistance;
      const dBytes: number[] = [];
      while (d > 0n) {
        dBytes.unshift(Number(d & 0xffn));
        d >>= 8n;
      }
      w.writeU8(dBytes.length);
      w.writeBytes(new Uint8Array(dBytes));
    }
  } else {
    // Autolykos v2: only nonce
    writeFixed(w, s.nonce, NONCE_LEN, 'nonce');
  }
  return w.toBytes();
}
