// Wire format for Autolykos v2 (header context):
//   [minerPk: 33 bytes][nonce: 8 bytes] = 41 bytes total
//
// This matches sigma-rust AutolykosSolution::serialize_bytes(version=2, w):
//   self.miner_pk.scorex_serialize(w)  // 33 bytes compressed secp256k1
//   w.write_all(&self.nonce)           // 8 bytes
//
// pow_onetime_pk and pow_distance are Autolykos v1 only; they are absent in v2
// header wire format. The parser always sets them to null.

import { ByteReader } from './scorex/reader.ts';
import { ByteWriter } from './scorex/writer.ts';
import { readFixed, writeFixed, EC_POINT_LEN } from './digests.ts';

export interface AutolykosSolution {
  minerPk: Uint8Array;            // 33 bytes
  powOnetimePk: Uint8Array | null;
  nonce: Uint8Array;              // 8 bytes
  powDistance: bigint | null;
}

const NONCE_LEN = 8;

export function parseAutolykosSolution(reader: ByteReader): AutolykosSolution {
  const minerPk = readFixed(reader, EC_POINT_LEN, 'minerPk');
  const nonce = readFixed(reader, NONCE_LEN, 'nonce');
  return { minerPk, powOnetimePk: null, nonce, powDistance: null };
}

export function serializeAutolykosSolution(s: AutolykosSolution): Uint8Array {
  const w = new ByteWriter();
  writeFixed(w, s.minerPk, EC_POINT_LEN, 'minerPk');
  writeFixed(w, s.nonce, NONCE_LEN, 'nonce');
  return w.toBytes();
}
