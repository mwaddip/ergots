/**
 * Unit tests for `cli.ts`. Covers:
 *
 *   1. All REST URL defaults populate when no flags are given.
 *   2. `--node-url` and `--indexer-url` override the defaults.
 *   3. `--start-height` is parsed as an integer override.
 *   4. Unknown flag is rejected (does NOT silently ignore).
 *   5. Pre-REST flags (`--store-path`) are rejected as unknown.
 *   6. `--network` accepts the documented variants and rejects others.
 *   7. Numeric flags reject non-integer / negative values.
 *   8. A flag at end-of-argv without a value throws.
 */

import { describe, expect, it } from 'vitest';

import { parseCliArgs, CLI_DEFAULTS } from '../src/cli.js';

describe('parseCliArgs', () => {
    it('applies REST URL defaults when neither flag provided', () => {
        const args = parseCliArgs([]);
        expect(args.nodeUrl).toBe('http://localhost:9052');
        expect(args.indexerUrl).toBe('http://localhost:9054');
    });

    it('populates every default when no flags are given', () => {
        const args = parseCliArgs([]);
        expect(args.nodeUrl).toBe(CLI_DEFAULTS.nodeUrl);
        expect(args.indexerUrl).toBe(CLI_DEFAULTS.indexerUrl);
        expect(args.checkpointPath).toBe(CLI_DEFAULTS.checkpointPath);
        expect(args.errorReportPath).toBe(CLI_DEFAULTS.errorReportPath);
        expect(args.network).toBe(CLI_DEFAULTS.network);
        expect(args.sleepMs).toBe(CLI_DEFAULTS.sleepMs);
        expect(args.mode).toBe('oracle');
        expect(args.startHeight).toBeUndefined();
        expect(args.maxHeight).toBeUndefined();
    });

    it('parses --node-url + --indexer-url', () => {
        const args = parseCliArgs(['--node-url', 'http://remote:9052', '--indexer-url', 'http://remote:9054']);
        expect(args.nodeUrl).toBe('http://remote:9052');
        expect(args.indexerUrl).toBe('http://remote:9054');
    });

    it('rejects pre-REST --store-path as unknown flag', () => {
        expect(() => parseCliArgs(['--store-path', '/some/path'])).toThrow(/unknown flag/);
    });

    it('parses --start-height as an integer override', () => {
        const args = parseCliArgs([
            '--start-height', '100000',
        ]);
        expect(args.startHeight).toBe(100000);
    });

    it('parses --max-height and --sleep-ms as integers', () => {
        const args = parseCliArgs([
            '--max-height', '100001',
            '--sleep-ms', '250',
        ]);
        expect(args.maxHeight).toBe(100001);
        expect(args.sleepMs).toBe(250);
    });

    it('rejects unknown flags', () => {
        expect(() =>
            parseCliArgs(['--bogus-flag', 'value']),
        ).toThrow(/unknown flag: --bogus-flag/);
    });

    it('accepts --network mainnet and --network testnet', () => {
        const mainnet = parseCliArgs(['--network', 'mainnet']);
        expect(mainnet.network).toBe('mainnet');
        const testnet = parseCliArgs(['--network', 'testnet']);
        expect(testnet.network).toBe('testnet');
    });

    it('rejects an invalid --network value', () => {
        expect(() =>
            parseCliArgs(['--network', 'devnet']),
        ).toThrow(/requires "mainnet" or "testnet"/);
    });

    it('rejects a non-integer numeric value', () => {
        expect(() =>
            parseCliArgs(['--start-height', 'abc']),
        ).toThrow(/non-negative integer/);
    });

    it('rejects a negative numeric value', () => {
        expect(() =>
            parseCliArgs(['--sleep-ms', '-1']),
        ).toThrow(/non-negative integer/);
    });

    it('throws on a flag at end of argv with no value', () => {
        expect(() =>
            parseCliArgs(['--start-height']),
        ).toThrow(/requires a value/);
    });

    it('respects multiple overrides supplied together', () => {
        const args = parseCliArgs([
            '--node-url', 'http://remote:9052',
            '--indexer-url', 'http://remote:9054',
            '--checkpoint-path', '/some/checkpoint.json',
            '--error-report-path', '/some/error.json',
            '--network', 'testnet',
            '--start-height', '1',
            '--max-height', '100',
            '--sleep-ms', '50',
        ]);
        expect(args).toEqual({
            nodeUrl: 'http://remote:9052',
            indexerUrl: 'http://remote:9054',
            checkpointPath: '/some/checkpoint.json',
            errorReportPath: '/some/error.json',
            network: 'testnet',
            startHeight: 1,
            maxHeight: 100,
            sleepMs: 50,
            mode: 'oracle',
        });
    });

    it('defaults --mode to "oracle" when flag is absent', () => {
        const args = parseCliArgs([]);
        expect(args.mode).toBe('oracle');
    });

    it('parses --mode lib', () => {
        const args = parseCliArgs(['--mode', 'lib']);
        expect(args.mode).toBe('lib');
    });

    it('parses --mode oracle explicitly', () => {
        const args = parseCliArgs(['--mode', 'oracle']);
        expect(args.mode).toBe('oracle');
    });

    it('rejects an invalid --mode value', () => {
        expect(() =>
            parseCliArgs(['--mode', 'bogus']),
        ).toThrow(/flag --mode requires "oracle" or "lib", got "bogus"/);
    });
});
