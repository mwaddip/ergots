import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    parseHeaderIdsAtHeightResponse,
    parseBlockResponse,
    parseValidationFragmentsResponse,
    parseBoxBytesResponse,
} from '../../src/rest/types.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'rest');
const fx = (n: string): unknown => JSON.parse(readFileSync(join(fixtures, n), 'utf8'));

describe('REST response parsers', () => {
    it('parses /blocks/at/{h}', () => {
        const r = parseHeaderIdsAtHeightResponse(fx('h2-headerIds.json'));
        expect(r).toBeInstanceOf(Array);
        expect(r[0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('parses /blocks/{id}', () => {
        const r = parseBlockResponse(fx('h2-block.json'));
        expect(r.header.height).toBe(2);
        expect(r.blockTransactions.transactions.length).toBeGreaterThanOrEqual(1);
    });

    it('parses /blocks/{id}/validation-fragments', () => {
        const r = parseValidationFragmentsResponse(fx('h2-validation-fragments.json'));
        expect(r.headerBytes).toMatch(/^[0-9a-f]+$/);
        for (const t of r.transactions) {
            expect(t.signingMessage).toMatch(/^[0-9a-f]+$/);
        }
    });

    it('parses /api/v1/boxes/{id}/bytes', () => {
        const r = parseBoxBytesResponse(fx('box-emission-genesis-bytes.json'));
        expect(r.bytes).toMatch(/^[0-9a-f]+$/);
    });

    it('rejects malformed input with field-path message', () => {
        expect(() => parseValidationFragmentsResponse({})).toThrow(/headerBytes/);
        expect(() => parseBoxBytesResponse({ bytes: 123 })).toThrow(/string/);
    });
});
