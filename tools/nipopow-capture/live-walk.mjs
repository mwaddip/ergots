// Acceptance walk: proveWithReader over a live JVM node's REST API,
// byte-compared against the same node's own proof for the same (m, k, tip).
// Usage: node tools/nipopow-capture/live-walk.mjs [m] [k] [--expect-full-identity]
// Env: ERGO_NODE_URL (default public JVM node).
//
// ── Why this file has two modes (historical context) ──
//
// `PopowProcessor.scala:109-111` (`popowProof`, backing every
// `GET /nipopow/proof/{m}/{k}[/{headerId}]` response) unconditionally
// builds `PoPowParams(m, k, continuous = true)` — there is no query
// parameter to ask for `continuous = false`, then or now. Before 0.4.0,
// `@ergots/nipopow` had no continuous-mode support at all: `proveWithReader`
// unconditionally returned `continuous: false` and had no way to produce
// the extra prefix headers `NipopowProverWithDbAlgs.scala:93-105` injects
// under continuous mode (see the worked derivation below), and `verifyProof`
// rejected every `continuous: true` proof as `'continuous-unsupported'` —
// which, since the live endpoint only ever serves `continuous: true`, meant
// it rejected every live-served proof outright. So raw byte-identity
// against the live REST endpoint's response was unreachable, structurally,
// not as a data/environment fluke — `--expect-full-identity` (added in the
// prior phase, before continuous-mode support existed) was a flag for a
// check that could not yet pass. That gap is what this package's 0.4.0
// (the continuous-mode unit) closed — see "Resolved in 0.4.0" below.
//
// What the DEFAULT mode's PASS now proves (and only this): (a) our prefix
// is a subset of the live endpoint's — proveWithReader never selects a
// header the JVM's production prover didn't also select; (b) every extra
// ("surplus") header the JVM prefix carries beyond our subset is EXACTLY a
// difficulty-recalculation height continuous mode injects — checked
// against the same formula the JVM uses (`heightsForNextRecalculation`
// below), not assumed; (c) once that fully-attributed surplus is removed,
// the FULL serialized proof — suffixHead, suffixTail, and every shared
// prefix entry, not just the height list — is byte-identical. Any of
// those three checks failing is a FAIL, printed explicitly with which
// check and which heights, never a silent pass.
//
// Resolved in 0.4.0 (this unit): full raw byte-identity against the live
// response as-is. `--expect-full-identity` now requests a continuous-mode
// proof from `proveWithReader` (`{ m, k, continuous: true }`, mainnet
// epochLength/useLastEpochs defaults — no overrides) and byte-compares its
// full serialization against the live response's own bytes with NEITHER
// side's `continuous` flag normalized. It also runs
// `verifyProof(jvmBytes, { checkPoW: true })` directly against the
// unmodified live response — the interop headline this unit exists to
// prove (facts/nipopow.md "Live-endpoint byte-identity — the 0.4.0
// acceptance gate"). Default mode (this flag omitted) is unchanged: still
// normalizes `continuous` to `false` on both sides, still does the
// filtered-prefix + surplus-attribution comparison above, still useful
// against non-conformant or historical nodes.
import { headerFromJson } from './json-codec.mjs';
import { hexToBytes, bytesToHex } from './hex.mjs';
import { proveWithReader, makePopowHeader } from '@ergots/nipopow/prover';
import { serializeProof, verifyProof } from '@ergots/nipopow'; // parse/serialize/verify surface
import { serializeHeader, blake2b256, ByteReader, parseHeader } from '@ergots/scorex';

const NODE = process.env.ERGO_NODE_URL ?? 'http://213.239.193.208:9053';
const rawArgs = process.argv.slice(2);
const expectFullIdentity = rawArgs.includes('--expect-full-identity');
const positional = rawArgs.filter(a => a !== '--expect-full-identity');
const m = Number(positional[0] ?? 6);
const k = Number(positional[1] ?? 6);
const t0 = Date.now();

// Mainnet difficulty-recalculation constants (NOT queryable from the REST
// API — hardcoded, mainnet-only; a testnet run would need different
// values and this script does not attempt to support that).
// eip37EpochLength: ~/projects/ergo-jvm-pr/src/main/resources/mainnet.conf:15
// useLastEpochs:    ~/projects/ergo-jvm-pr/src/main/resources/application.conf:225
//                   (mainnet.conf does not override it; base default applies)
const EIP37_EPOCH_LENGTH_MAINNET = 128;
const USE_LAST_EPOCHS_MAINNET = 8;

// Port of DifficultyAdjustment.{nextRecalculationHeight,
// previousHeightsRequiredForRecalculation, heightsForNextRecalculation}
// (~/projects/ergo-jvm-pr/ergo-core/src/main/scala/org/ergoplatform/mining/difficulty/DifficultyAdjustment.scala:27-55).
// This is the SAME formula NipopowProverWithDbAlgs.scala:96 calls to decide
// which extra heights continuous mode injects into `prefix` — reproduced
// here (not assumed) so the surplus-attribution check below is a real
// verification, not a hardcoded expectation.
function nextRecalculationHeight(height, epochLength) {
  if (height % epochLength === 0) return height + 1;
  return (Math.floor(height / epochLength) + 1) * epochLength + 1;
}
function previousHeightsRequiredForRecalculation(height, epochLength, useLastEpochs) {
  if ((height - 1) % epochLength === 0 && epochLength > 1) {
    const out = [];
    for (let i = 0; i <= useLastEpochs; i++) {
      const h = (height - 1) - i * epochLength;
      if (h >= 0) out.push(h);
    }
    return out.reverse();
  } else if ((height - 1) % epochLength === 0 && height > epochLength * useLastEpochs) {
    const out = [];
    for (let i = 0; i <= useLastEpochs; i++) out.push((height - 1) - i * epochLength);
    return out.reverse();
  }
  return [height - 1];
}
function heightsForNextRecalculation(height, epochLength, useLastEpochs) {
  return previousHeightsRequiredForRecalculation(
    nextRecalculationHeight(height, epochLength), epochLength, useLastEpochs,
  );
}

// Precision guard (discovered running this script — see task-9-report.md).
// ROOT-CAUSE LOCATION: here, at the fetch/parse boundary — not
// json-codec.mjs. json-codec.mjs's `BigInt(j.powSolutions.d)` is correct;
// it only ever sees whatever its caller already parsed. The information is
// lost earlier, the instant a plain `JSON.parse` (== res.json()) rounds an
// oversized literal through an IEEE754 double — no code downstream of that
// can recover it. So the fix belongs at the one place the raw wire text is
// still available: the parse step itself, here in getJson.
//
// The JVM node's Autolykos v1 PoW-solution field `powSolutions.d` —
// present on every version-1 header, and genesis (always in every proof's
// `prefix`, unconditionally) is version 1 — is a raw, UNQUOTED,
// exact-precision BigInt on the wire that runs 60-70+ digits (verified
// live: genesis at height 1, raw text has
// "d":46909460813884299753486408728361968139945651324239558400157099627).
// A plain parse silently rounds this to a ~15-significant-digit double
// before BigInt(...) ever runs, producing a wrong AutolykosSolution and a
// wrong derived header id (the id gate in popowFromJson below caught it
// immediately: "id gate failed at h=1" on the very first run of this
// script, before this guard existed). Quoting any bare integer literal of
// 16+ digits before parsing sidesteps the double round-trip entirely —
// BigInt(string) parses the exact decimal digits, so json-codec.mjs's
// existing BigInt(...) calls need no change; only the parse step here does.
//
// LATENT GAP ELSEWHERE (deferred, not this task's file to fix):
// capture.mjs (Task 5, already merged) parses with a plain `res.json()`
// too, with the identical exposure — it has simply never been pointed at a
// version-1 (pre-height-417792) range, since its committed fixture only
// covers heights 1,100,000-1,100,020 (version 3). It would not silently
// corrupt a future fixture, though: capture.mjs has the same id-gate this
// script does, so pointing it at a v1 height would fail loudly (thrown
// error), not silently — but it would fail. Whoever next extends
// capture.mjs's range below height 417792 needs this same guard (or the
// `json-bigint`-based approach tools/mainnet-validate/harness already
// uses for the identical class of problem).
//
// No new dependency here either: a small, tightly-scoped text transform
// instead of pulling in json-bigint (separate npm project, not resolvable
// from tools/nipopow-capture/ — see the file header of json-codec.mjs).
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
console.log(`node=${NODE} m=${m} k=${k} tip=${tipId} (h=${tipHeight})${expectFullIdentity ? ' [--expect-full-identity]' : ''}`);

// Theirs: JVM node's own proof for the pinned tip, JSON → our structs → bytes.
const jvmJson = await getJson(`/nipopow/proof/${m}/${k}/${tipId}`);
if (expectFullIdentity) {
  console.log(`jvm response continuous=${jvmJson.continuous} (server always requests continuous=true, PopowProcessor.scala:110; kept as-is — this mode compares raw bytes, no normalization)`);
} else {
  console.log(`jvm response continuous=${jvmJson.continuous} (server always requests continuous=true, PopowProcessor.scala:110; forced to false below for the comparison — see file header note)`);
}
const jvmProof = {
  m: jvmJson.m, k: jvmJson.k,
  prefix: jvmJson.prefix.map(popowFromJson),
  suffixHead: popowFromJson(jvmJson.suffixHead),
  suffixTail: jvmJson.suffixTail.map(headerFromJson),
  // Default mode normalizes to false (pre-continuous-mode filtered-prefix
  // comparison, unchanged); --expect-full-identity takes the raw value the
  // live node reported (always true — server hardcodes it, see header note).
  continuous: expectFullIdentity ? jvmJson.continuous : false,
};
const jvmBytes = serializeProof(jvmProof);

// Ours: the backward walk over the same node. --expect-full-identity
// requests a continuous-mode proof (mainnet epochLength/useLastEpochs
// defaults — no overrides) to match what the live endpoint always serves;
// default mode stays non-continuous, unchanged.
const ours = await proveWithReader(
  reader,
  expectFullIdentity ? { m, k, continuous: true } : { m, k },
  hexToBytes(tipId),
);
const ourBytes = serializeProof(ours);

const ourHeights = ours.prefix.map(p => p.header.height);
const jvmHeights = jvmProof.prefix.map(p => p.header.height);
const ourSet = new Set(ourHeights);
const jvmSet = new Set(jvmHeights);
const jvmOnly = jvmHeights.filter(h => !ourSet.has(h));
const ourOnly = ourHeights.filter(h => !jvmSet.has(h));
const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

function printCommonStats() {
  console.log(`our prefix=${ours.prefix.length} bytes=${ourBytes.length}`);
  console.log(`jvm prefix=${jvmProof.prefix.length} bytes=${jvmBytes.length} (raw response, server continuous=${jvmJson.continuous})`);
  console.log(`jvm-only (surplus) heights: ${jvmOnly.join(',') || '(none)'}`);
  console.log(`our-only heights: ${ourOnly.join(',') || '(none)'}`);
  console.log(`elapsed=${elapsedSec}s`);
}

if (expectFullIdentity) {
  console.log('mode: --expect-full-identity (strict raw comparison; the gate the continuous-mode unit must satisfy)');
  printCommonStats();

  let ok = true;
  if (bytesToHex(ourBytes) === bytesToHex(jvmBytes)) {
    console.log('PASS (raw byte-identical)');
  } else {
    console.error('FAIL (--expect-full-identity): raw proofs differ — see heights above');
    ok = false;
  }

  // Interop headline (facts/nipopow.md "Live-endpoint byte-identity — the
  // 0.4.0 acceptance gate"): the unmodified live response, exactly as
  // received, must itself pass our own verifier under continuous mode.
  // Run regardless of the byte-comparison outcome above, so a single
  // invocation always captures both results for the acceptance record.
  try {
    const vr = verifyProof(jvmBytes, { checkPoW: true });
    console.log(`verify: PASS (suffixTip=${vr.suffixTipHeight}, totalHeaders=${vr.totalHeaders}, continuous=${vr.continuous})`);
  } catch (err) {
    console.error(`verify: FAIL — ${err.message}`);
    ok = false;
  }

  if (!ok) process.exit(1);
} else {
  console.log(
    "method: filtered-prefix full-serialization byte-compare " +
    "(jvm prefix restricted to our prefix's height set; continuous normalized to false on both sides)",
  );

  const failures = [];

  if (ourOnly.length > 0) {
    failures.push(`our prefix has heights jvm does not — unexplained, not a continuous-mode artifact: ${ourOnly.join(',')}`);
  }

  // Surplus-attribution tripwire: every jvm-only height must be a
  // difficulty-recalculation height continuous mode injects for THIS tip —
  // verified against the actual JVM formula (above), not assumed.
  const expectedSurplus = new Set(
    heightsForNextRecalculation(tipHeight, EIP37_EPOCH_LENGTH_MAINNET, USE_LAST_EPOCHS_MAINNET)
      .filter(h => h < tipHeight),
  );
  const unexplainedSurplus = jvmOnly.filter(h => !expectedSurplus.has(h));
  if (unexplainedSurplus.length > 0) {
    failures.push(`jvm surplus heights NOT explained by continuous-mode difficulty-recalculation: ${unexplainedSurplus.join(',')}`);
  }

  // Only meaningful once the height-level divergence is fully explained —
  // otherwise a content mismatch would be indistinguishable from the
  // already-flagged height-level one.
  let jvmFilteredBytes = null;
  if (failures.length === 0) {
    const jvmFiltered = {
      ...jvmProof,
      prefix: jvmProof.prefix
        .filter(p => ourSet.has(p.header.height))
        .sort((a, b) => a.header.height - b.header.height),
    };
    jvmFilteredBytes = serializeProof(jvmFiltered);
    if (bytesToHex(ourBytes) !== bytesToHex(jvmFilteredBytes)) {
      failures.push(
        'filtered-prefix serialized bytes differ despite fully-explained heights — ' +
        'a content-level divergence beyond continuous mode (suffixHead, suffixTail, or a shared prefix entry)',
      );
    }
  }

  printCommonStats();
  console.log(`expected continuous-mode recalculation heights below tip: ${[...expectedSurplus].join(',') || '(none)'}`);
  if (jvmFilteredBytes !== null) console.log(`jvm filtered-prefix bytes=${jvmFilteredBytes.length}`);

  if (failures.length === 0) {
    console.log('PASS (subset-identity + surplus fully attributed to continuous mode)');
  } else {
    console.error('FAIL:');
    for (const f of failures) console.error(' -', f);
    process.exit(1);
  }
}
