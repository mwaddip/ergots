#!/usr/bin/env node
/**
 * One-shot fixture surgery: adopt the JVM proof wire dialect's required
 * trailing `continuous` byte (Task 7b, 2026-08-18/19).
 *
 * WHY: the JVM `NipopowProof` serializer (canonical —
 * ~/projects/ergo-jvm-pr/.../NipopowProof.scala) always writes one trailing
 * byte (`w.put(if (obj.continuous) 1 else 0)`) that sigma-rust's
 * `ergo-nipopow` dialect omits. Every committed ergots proof fixture was
 * generated through the sigma-rust dialect (fixture-gen, now FROZEN — never
 * run or touch it), so every one of them is missing that byte. This script
 * appends the canonical `"00"` (continuous = false) byte to every hex field
 * in the fixture set that represents a *complete top-level NipopowProof wire
 * byte array* — i.e. everything that gets handed whole to `parseProof` /
 * `verifyProof` / `hasValidConnections`.
 *
 * FIELDS TOUCHED (controller-ruled scope, task-7b-report.md §2 "THE BLOCKER"
 * has the full regression analysis this ruling is based on):
 *
 *   packages/nipopow/test/fixtures/nipopow_proof.json
 *     - every entry's `bytes_hex`                              (brief §5, as written)
 *     - every entry's `byte_mutations[*].mutated_bytes_hex`     (ruling: same
 *       treatment as bytes_hex — these are full mutated-proof byte copies,
 *       not offset metadata; the mutated body byte stays mutated, the
 *       appended byte is the new canonical trailing continuous=false marker,
 *       so each mutation keeps testing exactly what it tested before)
 *     - every entry's `connection_mutations[*].mutated_bytes_hex` (ruling: same)
 *
 *   packages/nipopow/test/fixtures/compare.json
 *     - every entry's `a_hex` and `b_hex`                       (brief §5, as written)
 *
 * FIELDS DELIBERATELY NOT TOUCHED:
 *   - nipopow_proof.json: `packed_leaves_per_popow_header`,
 *     `interlinks_roots_per_popow_header`, `prefix_heights` — Merkle-leaf KV
 *     hex / root-digest hex / plain integers, never parsed as a proof byte
 *     stream (task-7b-report.md §1a).
 *   - envelope.json — `proof_envelopes[*].inner_proof_hex` fixtures are
 *     synthetic opaque filler (`0xaa`/`0xbb` repeats, one `0x01` sentinel),
 *     never real NipopowProof wire bytes, never passed to `parseProof` by
 *     envelope.test.ts (task-7b-report.md §1e). Left untouched; not opened
 *     for writing by this script.
 *
 * METHOD: full JSON.parse → in-place field mutation → JSON.stringify(data,
 * null, 2) + "\n". Verified (task-7b-report.md §2, pre-surgery check) that
 * this round-trips both target files byte-identically to their current
 * on-disk form when NO field is touched — so every line this script changes
 * in `git diff` is a genuine content change, not incidental reformatting.
 *
 * Run once: `node packages/nipopow/test/fixtures/append-continuous-byte.mjs`
 * Committed alongside the fixture diff it produced, for provenance.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function appendContinuousByte(hex) {
  return hex + '00';
}

function report(label, before, after, touchedCount) {
  console.log(`\n${label}`);
  console.log(`  before: ${before.length} bytes, sha256=${sha256(before)}`);
  console.log(`  after:  ${after.length} bytes, sha256=${sha256(after)}`);
  console.log(`  fields touched: ${touchedCount}`);
}

// ── nipopow_proof.json ───────────────────────────────────────────────────
{
  const path = resolve(__dirname, 'nipopow_proof.json');
  const before = readFileSync(path, 'utf8');
  const data = JSON.parse(before);

  let touched = 0;
  for (const entry of data) {
    entry.bytes_hex = appendContinuousByte(entry.bytes_hex);
    touched++;
    for (const m of entry.byte_mutations ?? []) {
      m.mutated_bytes_hex = appendContinuousByte(m.mutated_bytes_hex);
      touched++;
    }
    for (const m of entry.connection_mutations ?? []) {
      m.mutated_bytes_hex = appendContinuousByte(m.mutated_bytes_hex);
      touched++;
    }
  }

  const after = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(path, after, 'utf8');
  report('nipopow_proof.json', before, after, touched);
}

// ── compare.json ─────────────────────────────────────────────────────────
{
  const path = resolve(__dirname, 'compare.json');
  const before = readFileSync(path, 'utf8');
  const data = JSON.parse(before);

  let touched = 0;
  for (const entry of data) {
    entry.a_hex = appendContinuousByte(entry.a_hex);
    entry.b_hex = appendContinuousByte(entry.b_hex);
    touched += 2;
  }

  const after = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(path, after, 'utf8');
  report('compare.json', before, after, touched);
}

// ── envelope.json ────────────────────────────────────────────────────────
console.log('\nenvelope.json');
console.log('  UNTOUCHED — proof_envelopes[*].inner_proof_hex fixtures are synthetic');
console.log('  opaque filler, never real NipopowProof wire bytes (task-7b-report.md §1e).');
console.log('  Not opened for writing.');

console.log('\nDone.');
