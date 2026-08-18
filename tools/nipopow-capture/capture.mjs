// One-shot: capture consecutive mainnet PoPowHeaders into a committed fixture.
// Usage: node tools/nipopow-capture/capture.mjs [startHeight] [count]
// Env: ERGO_NODE_URL (default: a public JVM node).
import { writeFileSync } from 'node:fs';
import { headerFromJson, batchProofFromJson } from './json-codec.mjs';
import { bytesToHex } from './hex.mjs';
import { serializeHeader, blake2b256 } from '@ergots/scorex';

const NODE = process.env.ERGO_NODE_URL ?? 'http://213.239.193.208:9053';
const START = Number(process.argv[2] ?? 1_100_000);
const COUNT = Number(process.argv[3] ?? 21);

const out = { source: { nodeUrl: NODE, capturedAt: new Date().toISOString() }, network: 'mainnet', heights: [] };

for (let h = START; h < START + COUNT; h++) {
  const res = await fetch(`${NODE}/nipopow/popowHeaderByHeight/${h}`);
  if (!res.ok) throw new Error(`height ${h}: HTTP ${res.status}`);
  const j = await res.json();
  const header = headerFromJson(j.header);
  const serialized = serializeHeader(header);
  const derivedId = bytesToHex(blake2b256(serialized));
  if (derivedId !== j.header.id) {
    throw new Error(`height ${h}: id gate FAILED — derived ${derivedId} != node ${j.header.id}`);
  }
  out.heights.push({
    height: h,
    headerHex: bytesToHex(serialized),
    id: j.header.id,
    interlinks: j.interlinks,
    interlinksProof: batchProofFromJson(j.interlinksProof),
  });
  console.log(`h=${h} ok (${j.interlinks.length} interlinks)`);
}

// Sanity: the fixture must exercise the drop/fill path at least once.
// A superblock transition shows as interlinks CHANGING between consecutive
// heights (level-0 predecessors leave them unchanged).
const changed = out.heights.some((e, i) =>
  i > 0 && JSON.stringify(e.interlinks) !== JSON.stringify(out.heights[i - 1].interlinks));
if (!changed) throw new Error('no superblock transition in range — extend the range');

writeFileSync(new URL('../../packages/nipopow/test/fixtures/mainnet_consecutive.json', import.meta.url),
  JSON.stringify(out, null, 1));
console.log(`wrote ${out.heights.length} heights`);
