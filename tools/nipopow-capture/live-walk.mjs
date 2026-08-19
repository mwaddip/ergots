// Acceptance walk: proveWithReader over a live JVM node's REST API,
// byte-compared against the same node's own proof for the same (m, k, tip).
// Usage: node tools/nipopow-capture/live-walk.mjs [m] [k]
// Env: ERGO_NODE_URL (default public JVM node).
//
// NOTE on `continuous` (task-9-report.md has the full source-verified
// analysis): the JVM node's REST endpoint always requests continuous mode —
// `PopowProcessor.scala:110`, `popowProof(m, k, headerIdOpt)`, unconditionally
// builds `PoPowParams(m, k, continuous = true)`; there is no query param to
// ask for `continuous = false`. `@ergots/nipopow` does not implement
// continuous mode at all (facts/nipopow.md "Does NOT ship"), so
// `proveWithReader`'s result always has `continuous: false`
// (packages/nipopow/src/prover.ts:190). The `jvmProof` object below is
// forced to `continuous: false` so the trailing wire byte — which our port
// can structurally never vary — drops out of the comparison; the live
// response's actual `continuous` value is logged unmodified, separately,
// for the record. This is NOT only a trailing-byte difference:
// `NipopowProverWithDbAlgs.scala:93-105` also injects extra
// difficulty-recalculation-height headers into `prefix` whenever
// `continuous` is true, unconditionally, before the normal KMZ17 walk runs.
// On mainnet (`eip37EpochLength = 128`, `useLastEpochs = 8`) that is up to 8
// extra prefix entries at 128-height-aligned positions near the tip that
// `proveWithReader` has no way to produce. See task-9-report.md for the
// worked prediction and the observed result.
import { headerFromJson } from './json-codec.mjs';
import { hexToBytes, bytesToHex } from './hex.mjs';
import { proveWithReader, makePopowHeader } from '@ergots/nipopow/prover';
import { serializeProof } from '@ergots/nipopow';           // parse/serialize surface
import { serializeHeader, blake2b256, ByteReader, parseHeader } from '@ergots/scorex';

const NODE = process.env.ERGO_NODE_URL ?? 'http://213.239.193.208:9053';
const m = Number(process.argv[2] ?? 6);
const k = Number(process.argv[3] ?? 6);
const t0 = Date.now();

// Precision guard (discovered running this script — see task-9-report.md):
// plain JSON.parse (== res.json()) rounds any integer literal beyond
// Number.MAX_SAFE_INTEGER (2^53-1, 16 digits) to the nearest double. The
// JVM node's Autolykos v1 PoW-solution field `powSolutions.d` — present on
// every version-1 header, and genesis (always in every proof's `prefix`,
// unconditionally) is version 1 — is a raw, UNQUOTED, exact-precision
// BigInt on the wire that runs 60-70+ digits (verified live: genesis at
// height 1, raw text has
// "d":46909460813884299753486408728361968139945651324239558400157099627).
// A plain parse silently rounds this to a ~15-significant-digit double
// before json-codec.mjs's `BigInt(j.powSolutions.d)` ever runs, producing a
// wrong AutolykosSolution and a wrong derived header id (the id gate in
// popowFromJson below caught it immediately: "id gate failed at h=1" on the
// very first run of this script). Quoting any bare integer literal of 16+
// digits before parsing sidesteps the double round-trip entirely —
// BigInt(string) parses the exact decimal digits, so json-codec.mjs's
// existing `BigInt(...)` calls need no change; only the parse step here
// does. No new dependency: a small, tightly-scoped text transform instead
// of pulling in json-bigint (already used for the same class of problem in
// tools/mainnet-validate/harness/src/rest/json-bigint.ts, but that's a
// separate npm project not resolvable from here).
function guardBigIntegers(text) {
  return text.replace(/([:,[]\s*)(-?\d{16,})(\s*[,\]}])/g, '$1"$2"$3');
}

// Simple sequential retry-once (task-9-brief.md Step 1 caveat): the live
// node occasionally answers a transient error (rate limit / reset) on an
// otherwise-valid path. One retry, no backoff, no distinction between
// network errors and non-2xx status — kept deliberately simple per brief.
async function getJson(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${NODE}${path}`);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return JSON.parse(guardBigIntegers(await res.text()));
    } catch (err) {
      if (attempt >= 2) throw err;
      console.warn(`retry 1/1 for ${path}: ${err.message}`);
    }
  }
}

/** Convert node PoPowHeader JSON → our PoPowHeader, id-gated, genesis-synthesized. */
function popowFromJson(j) {
  const header = headerFromJson(j.header);
  const derived = bytesToHex(blake2b256(serializeHeader(header)));
  if (derived !== j.header.id) throw new Error(`id gate failed at h=${j.header.height}`);
  const interlinks = (header.height === 1 ? [j.header.id] : j.interlinks).map(hexToBytes);
  // Rebuild the proof ourselves (makePopowHeader) — Task 5 proved this
  // reproduces the node's proofs field-for-field.
  return makePopowHeader(header, interlinks);
}

const reader = {
  async headersHeight() { return (await getJson('/info')).fullHeight; },
  async popowHeaderById(id) {
    try { return popowFromJson(await getJson(`/nipopow/popowHeaderById/${bytesToHex(id)}`)); }
    catch { return null; }
  },
  async popowHeaderAtHeight(h) {
    try { return popowFromJson(await getJson(`/nipopow/popowHeaderByHeight/${h}`)); }
    catch { return null; }
  },
  async lastHeaders() { throw new Error('unused: walk runs in anchored mode'); },
  async bestHeadersAfter(header, n) {
    const out = [];
    for (let h = header.height + 1; h <= header.height + n; h++) {
      const j = await getJson(`/nipopow/popowHeaderByHeight/${h}`);
      out.push(headerFromJson(j.header));
    }
    return out;
  },
};

// Pin the tip so both sides prove the same suffix (anchored mode).
const tipHeight = (await getJson('/info')).fullHeight - 10; // small reorg margin
const tipId = (await getJson(`/nipopow/popowHeaderByHeight/${tipHeight}`)).header.id;
console.log(`node=${NODE} m=${m} k=${k} tip=${tipId} (h=${tipHeight})`);

// Theirs: JVM node's own proof for the pinned tip, JSON → our structs → bytes.
const jvmJson = await getJson(`/nipopow/proof/${m}/${k}/${tipId}`);
console.log(`jvm response continuous=${jvmJson.continuous} (server always requests continuous=true, PopowProcessor.scala:110; forced to false below for the comparison — see file header note)`);
const jvmProof = {
  m: jvmJson.m, k: jvmJson.k,
  prefix: jvmJson.prefix.map(popowFromJson),
  suffixHead: popowFromJson(jvmJson.suffixHead),
  suffixTail: jvmJson.suffixTail.map(headerFromJson),
  continuous: false,
};
const jvmBytes = serializeProof(jvmProof);

// Ours: the backward walk over the same node.
const ours = await proveWithReader(reader, { m, k }, hexToBytes(tipId));
const ourBytes = serializeProof(ours);

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

if (bytesToHex(ourBytes) === bytesToHex(jvmBytes)) {
  console.log(`PASS: byte-identical proofs (${ourBytes.length} bytes, prefix ${ours.prefix.length}) [${elapsedSec}s]`);
} else {
  console.error('FAIL: proofs differ');
  const ourHeights = ours.prefix.map(p => p.header.height);
  const jvmHeights = jvmProof.prefix.map(p => p.header.height);
  console.error(' our prefix heights:', ourHeights.join(','));
  console.error(' jvm prefix heights:', jvmHeights.join(','));
  const ourSet = new Set(ourHeights);
  const jvmSet = new Set(jvmHeights);
  const jvmOnly = jvmHeights.filter(h => !ourSet.has(h));
  const ourOnly = ourHeights.filter(h => !jvmSet.has(h));
  console.error(' heights only in jvm prefix:', jvmOnly.join(',') || '(none)');
  console.error(' heights only in our prefix:', ourOnly.join(',') || '(none)');
  console.error(` our=${ourBytes.length} bytes, jvm=${jvmBytes.length} bytes [${elapsedSec}s]`);
  process.exit(1);
}
