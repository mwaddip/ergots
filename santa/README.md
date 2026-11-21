# ergots' SANTA runner

[SANTA](https://github.com/mwaddip/santa) holds conformance vectors for Ergo implementations: inputs, each with the
answer the JVM reference gives, and the rules by which an answer is graded. This directory is the runner for ergots:
given a SANTA checkout, it selects the vector files in its scope, feeds every entry to ergots, grades the answers and
writes the results. It takes SANTA's repository as data only: the vectors, the grading rules
(`vectors/grading.json`) and the oracle files (`oracle/`) that prove a grader and a selection.

The runner belongs to the commit it sits in: any ergots commit is graded with that commit's own copy, so a change to
a package's API and the runner change it needs land together.

## Grading a checkout

```bash
santa/grade                     # this working tree, against SANTA main
santa/grade --santa <ref>       # against another SANTA branch, tag or commit
santa/grade --out <dir>         # the results directory (default: santa-out beside the clone)
```

`santa/grade` fetches SANTA into a clone of its own (`$ERGOTS_SANTA_DIR`, by default `ergots/santa` under the user
cache directory), checks the chosen commit out over whatever the clone held, and runs `santa-run` on this checkout,
uncommitted edits included. It prints one line per slice (tier / version / provenance) with the count right and
graded in every dimension, then the totals and the path of the results:

- `results.json`: per slice, the counts, and every red entry with its dimension, what SANTA expects and what ergots
  answered;
- `reds.tsv`: the red entries, one per line;
- `actuals/`: ergots' raw answer to every entry, at the vector file's path under `vectors/`.

It needs `git`, [`mise`](https://mise.jdx.dev) and `jq`. The vector files that carry a budget run under the runner's
own watchdog, which reads `/proc`, so a full grade runs on Linux. The script exits non-zero when the runner could
not build or run.

## What SANTA calls

SANTA's board runs the same entry point: `santa-run <impl-path> <santa-dir> <out-dir>` (SANTA's
`docs/contract/runner-integration.md`, §3). It builds the `@ergots/*` packages and this runner in the checkout it is
part of, then runs `dist/runner.js run`:

1. **The oracle checks.** The grader reproduces every verdict case, and the selection every selection case, of the
   checkout's `oracle/`; when either differs the run stops, naming the case, and nothing is graded.
2. **Selection.** The files of `runner.json`'s scope, by tier, version and, for wire files, kind.
3. **The run.** Every entry of every selected file goes through the arm of the file's schema (below). A file with a
   `limits` budget runs as a child process in a process group of its own; the runner polls the group's memory every
   10 ms and ends it past the budget's memory or wall time, and the entry's answer is then
   `{"error": "exceeded", "limit": "memory" | "time"}`.
4. **Grading.** Each answer is graded against the entry's expectation by the grading type `vectors/grading.json`
   assigns to its file.
5. **The outputs.** `<out-dir>/results.json` (`santa-runner-results/v1`) and `<out-dir>/actuals/`.

SANTA then re-grades the raw answers with its own grader and shows where the two disagree. `mise.toml` pins the Node
version `santa-run` uses.

The runner picks its arm by the vector's `schema`, by exact name and version:

| Schema | Arm | Calls |
|---|---|---|
| `santa-eval/v1` to `santa-eval/v5`, `santa-eval/v6-fullctx` | `runVector` | `parseTree`, `makeContext`, `evaluateWith` (`@ergots/ergoscript`) |
| `santa-wire/v1` | `runWireVector` | the parse and serialize pair of the kinds `Constant`, `Box`, `SigmaBoolean`, `ErgoTree` (`@ergots/ergoscript`) and `Transaction` (`@ergots/transaction`) |
| `santa-transaction/v1` | `runTransactionVector` | `parseTransaction`, `validateStateful` (`@ergots/transaction`) |
| `santa-authds/v1` | `runAuthdsVector` | `BatchAVLProver`, `verifyAvlBatchPartial` (`@ergots/avltree`) |
| `santa-nipopow/v1` | `runNipopowVector` | `updateInterlinks`, `prove`, `serializeProof` (`@ergots/nipopow`) |

Under any other schema every entry answers `{"error": "not-implemented"}`.

An entry's outcome is ergots' own: a value (with its cost), `errored` when ergots refuses the input with one of its
typed errors, `not-implemented` when ergots has no handler for the operation, and `panicked` (with the message in
`note`) for any other throw. In the transaction arm, any failure to read the transaction, its boxes or its headers
is `errored`, and a refusal by `validateStateful` is a rejection (`valid: false`, with ergots' error code as the
reason).

## The scope it declares

`runner.json` says which vectors the runner grades. Each key states what ergots' API offers:

| Key | Value | Reason |
|---|---|---|
| `version` | `v6` | The evaluator runs trees at every activated script version up to 3, the v6 protocol. |
| `tiers` | `eval` | `@ergots/ergoscript` evaluates an ErgoTree in a context (`evaluateWith`). |
| | `wire` | `@ergots/ergoscript` and `@ergots/transaction` parse and write back constants, boxes, sigma propositions, trees and transactions. |
| | `transaction` | `@ergots/transaction` validates a transaction against its input boxes and block context (`validateStateful`). |
| | `authds` | `@ergots/avltree` builds and verifies batch AVL+ proofs. |
| | `nipopow` | `@ergots/nipopow` derives a header's interlinks and builds NiPoPoW proofs. |
| `cost` | `true` | An evaluation reports its JIT cost and `validateStateful` returns the transaction's block cost. |

`kinds` and `activation` are left at SANTA's defaults: every wire kind is selected, and so are the vectors that turn
on a rule of the activated script version, since ergots' parsers and evaluator apply those rules.

## Layout and tests

```
santa/
├── santa-run        the entry point: build, then `runner.js run`
├── runner.json      the declared scope
├── mise.toml        the Node version santa-run uses
├── grade            grade this checkout locally
├── src/
│   ├── runner.ts    the arms, `runDocument`, and the CLI (`run`, `one`, and one vector file's actuals)
│   ├── harness/     selection, the grading interpreter, the oracle checks, the watchdog, results.json
│   └── …            decode.ts / encode.ts (SANTA's JSON values to and from ergots'), binding.ts (context
│                    bindings), codec-errors.ts (which throws are refusals)
└── test/            unit tests of the arms and the CLI; test/fixtures/ holds the SANTA entries they read
    └── harness/     the harness's own tests
```

`src/harness/` and `test/harness/` are the harness of SANTA's TypeScript runner `santa-comet`
(`mwaddip/santa-comet`, `package/src/harness/` and `package/test/harness/`), byte-identical to it: Node's standard
library only. A fix to it goes to SANTA, which carries it to every copy.

The directory is the workspace `@ergots/santa-runner` (private). `npm test` and `npm run typecheck` at the repo
root run its tests and typecheck with the packages'. Two of the harness's test files (`oracle.spec.ts`,
`run.spec.ts`) read a SANTA checkout; they run when `SANTA_DIR` names one:

```bash
SANTA_DIR=<a SANTA checkout> npm run test -w @ergots/santa-runner
```
