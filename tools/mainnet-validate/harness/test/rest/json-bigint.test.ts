import { describe, it, expect } from 'vitest'
import { parseLossless, stringifyLossless } from '../../src/rest/json-bigint'

describe('rest/json-bigint', () => {
    it('preserves i64::MAX through parse', () => {
        const i64Max = '9223372036854775807'
        const parsed = parseLossless(`{"amount":${i64Max}}`) as { amount: bigint }
        expect(typeof parsed.amount).toBe('bigint')
        expect(parsed.amount.toString()).toBe(i64Max)
    })

    it('preserves i64::MIN through parse', () => {
        const i64Min = '-9223372036854775808'
        const parsed = parseLossless(`{"x":${i64Min}}`) as { x: bigint }
        expect(typeof parsed.x).toBe('bigint')
        expect(parsed.x.toString()).toBe(i64Min)
    })

    it('keeps safe-range integers as Number', () => {
        const parsed = parseLossless('{"x":42,"y":776999000000}') as { x: number; y: number }
        expect(typeof parsed.x).toBe('number')
        expect(parsed.x).toBe(42)
        expect(typeof parsed.y).toBe('number')
        expect(parsed.y).toBe(776999000000)
    })

    it('round-trips a mainnet-shaped box with i64::MAX asset amount', () => {
        const json =
            '{"boxId":"abc","value":776999000000,' +
            '"assets":[{"tokenId":"baa3","amount":9223372036854775807}]}'
        const parsed = parseLossless(json) as {
            boxId: string
            value: number | bigint
            assets: { tokenId: string; amount: bigint }[]
        }
        expect(typeof parsed.value).toBe('number')
        expect(typeof parsed.assets[0]!.amount).toBe('bigint')
        const restringified = stringifyLossless(parsed)
        // The serializer must emit the bigint as a JSON number literal,
        // NOT a quoted string — sigma-rust's JSON box parser expects a
        // number and will reject quoted amounts.
        expect(restringified).toContain('"amount":9223372036854775807')
        // And a parse round-trip recovers the same shape.
        const reparsed = parseLossless(restringified) as typeof parsed
        expect(reparsed.assets[0]!.amount.toString()).toBe('9223372036854775807')
    })
})
