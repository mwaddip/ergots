/**
 * Loader for stateful transaction fixtures.
 *
 * Each fixture under test/fixtures/stateful/<txid>.json contains a
 * self-contained (tx + spent input boxes + data-input boxes + 10 preceding
 * headers + preHeader + parameters) tuple captured from testnet via the
 * gen-stateful-fixtures.ts generator.
 *
 * This module exports:
 *   listStatefulFixtures()       — list fixture names (txids) available
 *   loadStatefulFixture(name)    — load raw JSON (hexes as strings)
 *   loadStatefulFixtureAsDeps()  — parse everything into ergots types:
 *       tx: ErgoLikeTransaction (via parseTransaction)
 *       deps: { inputBoxes, dataInputBoxes, stateContext: { headers, preHeader, parameters } }
 *   hexToBytes()                 — shared hex→Uint8Array helper
 *
 * The `_load.ts` name signals a test-only helper; it is never imported by src/.
 * node:fs / node:path / node:url are acceptable in test/ files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ByteReader, parseHeader } from '@ergots/scorex';
import type { Header } from '@ergots/scorex';
import { parseSValue } from '@ergots/ergoscript';
import type { ErgoBox, PreHeader } from '@ergots/ergoscript';

import { parseTransaction } from '../../src/index.ts';
import type { ErgoLikeTransaction } from '../../src/index.ts';
import type { ChainParameters } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// paths

const _dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'stateful',
);

// ---------------------------------------------------------------------------
// raw fixture shape

export interface StatefulFixtureRaw {
    id: string;
    note: string;
    network: string;
    height: number;
    txBytesHex: string;
    inputBoxesHex: string[];
    dataInputBoxesHex: string[];
    /** 10 scorex-serialized header bytes, newest-first. */
    headersHex: string[];
    preHeader: {
        version: number;
        parentId: string;
        /** Stored as string to preserve u64 precision. */
        timestamp: string;
        nBits: number;
        height: number;
        minerPk: string;
        votes: string;
    };
    parameters: {
        maxBlockCost: number;
        storageFeeFactor: number;
        minValuePerByte: number;
        inputCost: number;
        dataInputCost: number;
        outputCost: number;
        tokenAccessCost: number;
    };
}

// ---------------------------------------------------------------------------
// hex helper

export function hexToBytes(h: string): Uint8Array {
    const a = new Uint8Array(h.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return a;
}

// ---------------------------------------------------------------------------
// list + raw load

export function listStatefulFixtures(): string[] {
    return fs
        .readdirSync(_dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
}

export function loadStatefulFixture(name: string): StatefulFixtureRaw {
    const raw = fs.readFileSync(path.join(_dir, `${name}.json`), 'utf8');
    return JSON.parse(raw) as StatefulFixtureRaw;
}

// ---------------------------------------------------------------------------
// parsed deps types

export interface StatefulFixtureDeps {
    inputBoxes: ErgoBox[];
    dataInputBoxes: ErgoBox[];
    stateContext: {
        headers: Header[];
        preHeader: PreHeader;
        parameters: ChainParameters;
    };
}

// ---------------------------------------------------------------------------
// parse helper: box bytes → ErgoBox

function parseBoxBytes(bytes: Uint8Array): ErgoBox {
    const reader = new ByteReader(bytes);
    const sv = parseSValue({ tag: 'SBox' }, 0, reader);
    if (sv.kind !== 'Box') throw new Error(`parseSValue returned kind=${sv.kind}, expected Box`);
    return sv.value;
}

// ---------------------------------------------------------------------------
// loadStatefulFixtureAsDeps — the primary consumer for Tasks 7/8

export function loadStatefulFixtureAsDeps(
    name: string,
): { tx: ErgoLikeTransaction; deps: StatefulFixtureDeps } {
    const j = loadStatefulFixture(name);

    // tx
    const tx = parseTransaction(hexToBytes(j.txBytesHex));

    // boxes
    const inputBoxes: ErgoBox[] = j.inputBoxesHex.map((h) => parseBoxBytes(hexToBytes(h)));
    const dataInputBoxes: ErgoBox[] = j.dataInputBoxesHex.map((h) =>
        parseBoxBytes(hexToBytes(h)),
    );

    // headers — scorex parseHeader, newest-first (same order as stored)
    const headers: Header[] = j.headersHex.map((h) =>
        parseHeader(new ByteReader(hexToBytes(h))),
    );

    // preHeader — timestamp from string → BigInt (precision-safe u64)
    const ph = j.preHeader;
    const preHeader: PreHeader = {
        version: ph.version,
        parentId: hexToBytes(ph.parentId),
        timestamp: BigInt(ph.timestamp),
        nBits: ph.nBits,
        height: ph.height,
        minerPk: hexToBytes(ph.minerPk),
        votes: hexToBytes(ph.votes),
    };

    // parameters
    const parameters: ChainParameters = j.parameters;

    return {
        tx,
        deps: {
            inputBoxes,
            dataInputBoxes,
            stateContext: { headers, preHeader, parameters },
        },
    };
}
