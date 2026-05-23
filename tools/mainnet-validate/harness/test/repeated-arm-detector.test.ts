/**
 * Unit tests for the 2j-b repeated-arm detector.
 *
 * Covers:
 *  - Empty log → not tripped
 *  - Below threshold → not tripped
 *  - At threshold → tripped with metadata
 *  - Above threshold → still tripped, count reflects total
 *  - Multiple arms with one at threshold → tripped on the right arm
 *  - Multiple arms both at threshold → tripped on highest-count
 *  - threshold < 1 → throws
 */
import { describe, it, expect } from 'vitest';

import { detectRepeatedArm } from '../src/repeated-arm-detector.js';
import type { LoopLogEntry } from '../src/loop-log.js';

function makeEntry(iteration: number, affectedArm: string): LoopLogEntry {
    return {
        iteration,
        timestamp: '2026-05-23T00:00:00.000Z',
        halt: {
            height: 1000 + iteration,
            phase: 'evaluate-cost',
            errorCode: 'cost-drift',
            location: {},
        },
        diagnosis: {
            rootCause: '',
            sigmaRustCites: [],
            ourCodeCites: [],
            proposedFix: {
                summary: '',
                affectedArm,
                filesToTouch: [],
            },
            redFixtureSpec: {
                fixturePath: '',
                inputDescription: '',
                expectedValue: '',
                expectedCost: 0,
            },
            confidence: 99,
            uncertaintySources: [],
        },
        fix: {
            outcome: 'SUCCESS',
            overridesEcho: '',
            testCountBefore: 0,
            testCountAfter: 0,
        },
        smokeResult: {
            walkedFromHeight: 0,
            walkedToHeight: null,
            outcome: 'pending',
        },
    };
}

describe('detectRepeatedArm', () => {
    it('empty log → not tripped', () => {
        expect(detectRepeatedArm([])).toEqual({ tripped: false });
    });

    it('single arm below threshold → not tripped', () => {
        const log = [makeEntry(1, 'const-placeholder'), makeEntry(2, 'const-placeholder')];
        expect(detectRepeatedArm(log, 3)).toEqual({ tripped: false });
    });

    it('single arm at threshold → tripped with arm + count + iterations', () => {
        const log = [
            makeEntry(1, 'const-placeholder'),
            makeEntry(2, 'const-placeholder'),
            makeEntry(3, 'const-placeholder'),
        ];
        expect(detectRepeatedArm(log, 3)).toEqual({
            tripped: true,
            arm: 'const-placeholder',
            count: 3,
            iterations: [1, 2, 3],
        });
    });

    it('single arm above threshold → still tripped, count is total', () => {
        const log = [
            makeEntry(1, 'coll-map'),
            makeEntry(2, 'coll-map'),
            makeEntry(3, 'coll-map'),
            makeEntry(4, 'coll-map'),
        ];
        expect(detectRepeatedArm(log, 3)).toEqual({
            tripped: true,
            arm: 'coll-map',
            count: 4,
            iterations: [1, 2, 3, 4],
        });
    });

    it('multiple arms, only one at threshold → tripped on the right arm', () => {
        const log = [
            makeEntry(1, 'a'),
            makeEntry(2, 'b'),
            makeEntry(3, 'a'),
            makeEntry(4, 'a'),
            makeEntry(5, 'b'),
        ];
        expect(detectRepeatedArm(log, 3)).toEqual({
            tripped: true,
            arm: 'a',
            count: 3,
            iterations: [1, 3, 4],
        });
    });

    it('multiple arms both at threshold → tripped on highest-count', () => {
        const log = [
            makeEntry(1, 'a'),
            makeEntry(2, 'a'),
            makeEntry(3, 'a'),
            makeEntry(4, 'b'),
            makeEntry(5, 'b'),
            makeEntry(6, 'b'),
            makeEntry(7, 'b'),
        ];
        expect(detectRepeatedArm(log, 3)).toEqual({
            tripped: true,
            arm: 'b',
            count: 4,
            iterations: [4, 5, 6, 7],
        });
    });

    it('configurable threshold (5 instead of 3) → respects threshold', () => {
        const log = [
            makeEntry(1, 'x'),
            makeEntry(2, 'x'),
            makeEntry(3, 'x'),
            makeEntry(4, 'x'),
        ];
        expect(detectRepeatedArm(log, 5)).toEqual({ tripped: false });
        expect(detectRepeatedArm(log, 4)).toEqual({
            tripped: true,
            arm: 'x',
            count: 4,
            iterations: [1, 2, 3, 4],
        });
    });

    it('threshold < 1 throws', () => {
        expect(() => detectRepeatedArm([], 0)).toThrow(/threshold must be >= 1/);
        expect(() => detectRepeatedArm([], -1)).toThrow(/threshold must be >= 1/);
    });
});
