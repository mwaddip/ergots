import {
  SValueParseError, SValueSerializeError, STypeParseError, STypeSerializeError, ErgoTreeParseError,
  ErgoTreeSerializeError,
  SigmaBooleanParseError, SigmaBooleanSerializeError, ExprParseError,
} from '@ergots/ergoscript'
import { ReaderError } from '@ergots/scorex'
import { TxParseError } from '@ergots/transaction'

/** ergots' typed wire-codec error classes — a codec REJECTION of the bytes (a faithful reject ⇒
 *  `errored`), distinct from an untyped throw (a library/runner defect ⇒ the panic-net). The ErgoTree
 *  round-trip COMPOSES the SValue/SType/Expr/tree codecs, so a tree with a bad constant or type throws
 *  the constituent codec's typed error (e.g. an SHeader-typed segregated constant ⇒ SValueParseError),
 *  not ErgoTreeParseError. Mirrors ergots' own test/conformance/_santa.ts isWireParseError set. */
export function isWireCodecError(err: unknown): boolean {
  return err instanceof SValueParseError || err instanceof SValueSerializeError
    || err instanceof STypeParseError || err instanceof STypeSerializeError
    || err instanceof ErgoTreeParseError || err instanceof ErgoTreeSerializeError
    || err instanceof SigmaBooleanParseError || err instanceof SigmaBooleanSerializeError
    || err instanceof ExprParseError
    || err instanceof ReaderError
    // A tx-codec rejection of the bytes is a faithful `errored`.
    || err instanceof TxParseError
    // ExprTpeError: a node the JVM refuses to build (ergots' sized-tree work lets it propagate as a
    // hard reject). By name too: ergots master does not export the class from the package root.
    || (err instanceof Error && err.name === 'ExprTpeError')
}
