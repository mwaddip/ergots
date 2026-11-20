# ergots' SANTA runner

[SANTA](https://github.com/mwaddip/santa) holds conformance vectors for Ergo implementations: inputs, each with the
answer the JVM reference gives. A runner feeds those inputs to one implementation and writes down what it answers;
SANTA's `conform` compares the answers with the reference's and grades every entry.

This directory is the runner for ergots. It belongs to the commit it sits in: SANTA grades any ergots commit with
that commit's own copy, so a change to a package's API and the runner change it needs land together.

## Grading a checkout

```bash
santa/grade                     # this working tree, against SANTA main
santa/grade --santa <ref>       # against another SANTA branch, tag or commit
santa/grade --delta <base-ref>  # also grade <base-ref>, and print what changed between the two
```

`santa/grade` fetches SANTA into a clone of its own (`$ERGOTS_SANTA_DIR`, by default `ergots/santa` under the user
cache directory) and runs that clone's `./conform --hosted` on this checkout, uncommitted edits included. It prints
one line per slice (tier / version / provenance) with its counts, then the number of red entries and the path of
two files:

- `results.json`: every red entry with its dimension, what SANTA expects and what ergots answered;
- `reds.tsv`: the same, one line per red entry.

`--delta <base-ref>` runs SANTA's `./santa-pr`, the comparison the pull request check posts: entries newly red, now
green, red another way and still red, one row per vector file.

It needs `git`, [`mise`](https://mise.jdx.dev), `jq` and a systemd user manager on cgroup v2 (SANTA bounds each run's
memory and time with it), so it runs on Linux.

## The pull request check

`.github/workflows/santa.yml` runs SANTA's action on every pull request: it grades the pull request's base and the
pull request merged into it, each with its own copy of this runner, on SANTA's current vectors.
`.github/workflows/santa-comment.yml` posts the comparison as one comment on the pull request and updates it on
every push. The full per-entry list is in the check run's job summary.

## What SANTA calls

`santa-run <impl-path> <vectors-dir> <out-dir>` (SANTA's `docs/contract/runner-integration.md`, §3) builds the
`@ergots/*` packages and this runner in the checkout it is part of, then runs `dist/runner.js` once per vector file
and writes one actuals file per vector. `mise.toml` pins the Node version it runs under.

The runner picks its arm by the vector's `schema`, by exact name and version:

| Schema | Arm | Calls |
|---|---|---|
| `santa-eval/v1` to `santa-eval/v5`, `santa-eval/v6-fullctx` | `runVector` | `parseTree`, `makeContext`, `evaluateWith` (`@ergots/ergoscript`) |
| `santa-wire/v1` | `runWireVector` | the parse and serialize pair of each kind (`@ergots/ergoscript`, `@ergots/transaction`) |
| `santa-transaction/v1` | `runTransactionVector` | `parseTransaction`, `validateStateful` (`@ergots/transaction`) |
| `santa-authds/v1` | `runAuthdsVector` | `BatchAVLProver`, `verifyAvlBatchPartial` (`@ergots/avltree`) |
| `santa-nipopow/v1` | `runNipopowVector` | `updateInterlinks`, `prove`, `serializeProof` (`@ergots/nipopow`) |

Under any other schema every entry answers `{"error": "not-implemented"}`.

An entry's outcome is ergots' own: a value (with its cost), `errored` when ergots refuses the input with one of its
typed errors, `not-implemented` when ergots has no handler for the operation, and `panicked` (with the message in
`note`) for any other throw. The runner compares nothing; grading is SANTA's.

## The scope it declares

`runner.json` tells SANTA which vectors to stage for this runner. Each key states what ergots' API offers:

| Key | Value | Reason |
|---|---|---|
| `version` | `v6` | The evaluator runs trees at every activated script version up to 3, the v6 protocol. |
| `tiers` | `eval` | `@ergots/ergoscript` evaluates an ErgoTree in a context (`evaluateWith`). |
| | `wire` | `@ergots/ergoscript` and `@ergots/transaction` parse and write back constants, boxes, sigma propositions, trees and transactions. |
| | `transaction` | `@ergots/transaction` validates a transaction against its input boxes and block context (`validateStateful`). |
| | `authds` | `@ergots/avltree` builds and verifies batch AVL+ proofs. |
| | `nipopow` | `@ergots/nipopow` derives a header's interlinks and builds NiPoPoW proofs. |
| `cost` | `true` | An evaluation reports its JIT cost and `validateStateful` returns the transaction's block cost. |

`kinds` and `activation` are left at SANTA's defaults: every wire kind is staged, and vectors that turn on a rule of
the activated script version are staged too, since ergots' parsers and evaluator apply those rules.

## Layout and tests

```
santa/
├── santa-run        SANTA's entry point
├── runner.json      the declared scope
├── mise.toml        the Node version santa-run uses
├── grade            grade this checkout locally
├── src/             the runner: runner.ts (the arms and the CLI), decode.ts / encode.ts (SANTA's JSON values
│                    to and from ergots'), binding.ts (context bindings), codec-errors.ts (which throws are refusals)
└── test/            unit tests of the adapter; test/fixtures/ holds the SANTA entries they read
```

The directory is the workspace `@ergots/santa-runner` (private). `npm test` and `npm run typecheck` at the repo
root run its tests and typecheck with the packages'.
