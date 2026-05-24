/**
 * Pre-gate test (per spec §7.3): verifies our @ergots/scorex serializeHeader
 * produces byte-identical output to the node's Header::scorex_serialize_bytes,
 * and that blake2b256 of those bytes equals the indexed headerId.
 *
 * Failures here mean a Scorex serialization mismatch; surfaces as a focused
 * header-format bug rather than a confusing whole-pipeline halt.
 *
 * Skipped in CI; runs locally with LIVE_NODE_URL env.
 */

import { describe, it, expect } from 'vitest';
import { ByteReader, parseHeader, serializeHeader } from '@ergots/scorex';
import { blake2b } from '@noble/hashes/blake2.js';
import { NodeClient } from '../../src/rest/node-client.js';

const LIVE_NODE = process.env['LIVE_NODE_URL'];

function hexDecode(s: string): Uint8Array {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
}
function hex(b: Uint8Array): string {
    let s = ''; for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0'); return s;
}

(LIVE_NODE ? describe : describe.skip)('header-bytes round-trip pre-gate', () => {
    it('serializeHeader(parseHeader(headerBytes)) === headerBytes && blake2b256 === headerId for h=2', async () => {
        const c = new NodeClient(LIVE_NODE!);
        const ids = await c.getHeaderIdsAtHeight(2);
        const headerId = ids[0]!;
        const fragments = await c.getValidationFragments(headerId);
        const serverBytes = hexDecode(fragments.headerBytes);
        const parsed = parseHeader(new ByteReader(serverBytes));
        const reSerialized = serializeHeader(parsed);
        expect(hex(reSerialized)).toBe(hex(serverBytes));
        const computedId = hex(blake2b(serverBytes, { dkLen: 32 }));
        expect(computedId).toBe(headerId);
        await c.close();
    });
});
