/**
 * Unit tests for `cli.ts`. Covers:
 *
 *   1. Missing required flag (`--store-path`) throws.
 *   2. All defaults populate when only the required flag is given.
 *   3. `--start-height` is parsed as an integer override.
 *   4. Unknown flag is rejected (does NOT silently ignore).
 *   5. `--network` accepts the documented variants and rejects others.
 *   6. Numeric flags reject non-integer / negative values.
 *   7. A flag at end-of-argv without a value throws.
 */

import { describe, expect, it } from 'vitest';

import { parseCliArgs, CLI_DEFAULTS } from '../src/cli.js';

describe('parseCliArgs', () => {
    it('throws when --store-path is missing', () => {
        expect(() => parseCliArgs([])).toThrow(/--store-path is required/);
    });

    it('populates every default when only --store-path is given', () => {
        const args = parseCliArgs(['--store-path', '/some/store.redb']);
        expect(args.storePath).toBe('/some/store.redb');
        expect(args.shimPath).toBe(CLI_DEFAULTS.shimPath);
        expect(args.sidecarPath).toBe(CLI_DEFAULTS.sidecarPath);
        expect(args.checkpointPath).toBe(CLI_DEFAULTS.checkpointPath);
        expect(args.errorReportPath).toBe(CLI_DEFAULTS.errorReportPath);
        expect(args.network).toBe(CLI_DEFAULTS.network);
        expect(args.sleepMs).toBe(CLI_DEFAULTS.sleepMs);
        expect(args.startHeight).toBeUndefined();
        expect(args.maxHeight).toBeUndefined();
    });

    it('parses --start-height as an integer override', () => {
        const args = parseCliArgs([
            '--store-path', '/x.redb',
            '--start-height', '100000',
        ]);
        expect(args.startHeight).toBe(100000);
    });

    it('parses --max-height and --sleep-ms as integers', () => {
        const args = parseCliArgs([
            '--store-path', '/x.redb',
            '--max-height', '100001',
            '--sleep-ms', '250',
        ]);
        expect(args.maxHeight).toBe(100001);
        expect(args.sleepMs).toBe(250);
    });

    it('rejects unknown flags', () => {
        expect(() =>
            parseCliArgs(['--store-path', '/x.redb', '--bogus-flag', 'value']),
        ).toThrow(/unknown flag: --bogus-flag/);
    });

    it('accepts --network mainnet and --network testnet', () => {
        const mainnet = parseCliArgs(['--store-path', '/x.redb', '--network', 'mainnet']);
        expect(mainnet.network).toBe('mainnet');
        const testnet = parseCliArgs(['--store-path', '/x.redb', '--network', 'testnet']);
        expect(testnet.network).toBe('testnet');
    });

    it('rejects an invalid --network value', () => {
        expect(() =>
            parseCliArgs(['--store-path', '/x.redb', '--network', 'devnet']),
        ).toThrow(/requires "mainnet" or "testnet"/);
    });

    it('rejects a non-integer numeric value', () => {
        expect(() =>
            parseCliArgs(['--store-path', '/x.redb', '--start-height', 'abc']),
        ).toThrow(/non-negative integer/);
    });

    it('rejects a negative numeric value', () => {
        expect(() =>
            parseCliArgs(['--store-path', '/x.redb', '--sleep-ms', '-1']),
        ).toThrow(/non-negative integer/);
    });

    it('throws on a flag at end of argv with no value', () => {
        expect(() =>
            parseCliArgs(['--store-path', '/x.redb', '--start-height']),
        ).toThrow(/requires a value/);
    });

    it('respects multiple overrides supplied together', () => {
        const args = parseCliArgs([
            '--store-path', '/store.redb',
            '--shim-path', '/some/shim',
            '--sidecar-path', '/some/sidecar.redb',
            '--checkpoint-path', '/some/checkpoint.json',
            '--error-report-path', '/some/error.json',
            '--network', 'testnet',
            '--start-height', '1',
            '--max-height', '100',
            '--sleep-ms', '50',
        ]);
        expect(args).toEqual({
            storePath: '/store.redb',
            shimPath: '/some/shim',
            sidecarPath: '/some/sidecar.redb',
            checkpointPath: '/some/checkpoint.json',
            errorReportPath: '/some/error.json',
            network: 'testnet',
            startHeight: 1,
            maxHeight: 100,
            sleepMs: 50,
        });
    });
});
