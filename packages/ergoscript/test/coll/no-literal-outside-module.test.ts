/**
 * No collection value is created outside the module `coll/`.
 *
 * Every value of kind `Coll` in the evaluator comes out of one builder in
 * `packages/ergoscript/src/coll/`; the module decides the value's class
 * (`CollClass`), the item array and the element type. This scan keeps the
 * rule by parsing every `.ts` source file outside the module and failing on
 * one of the four node shapes below.
 *
 * ## What the scan flags
 *
 * 1. **An object literal with `kind` set to the string `Coll`.** The key is
 *    the identifier `kind`, the string key `'kind'` / `"kind"`, or a
 *    computed key `['kind']` resolving to the same string. The initialiser
 *    is a string literal `'Coll'` (single or double quoted), a template
 *    literal with no substitutions, an `as` / `satisfies` / parenthesised
 *    wrapping of one of these, an identifier whose declaration in the same
 *    file is a variable (`const`, `let` or `var`) bound to the string
 *    `'Coll'` (`const K = 'Coll' as const; { kind: K, elem, items, cls }`),
 *    or a conditional any branch of which resolves to that string. The
 *    shorthand `{ kind, elem, items }` form matches when the local `kind`
 *    in the file resolves to a variable bound to `'Coll'`.
 *
 * 2. **An object literal that spreads an expression and also sets `items`,
 *    `elem` or `cls`.** This is the shape of a copy of a collection value
 *    with a field replaced (`{ ...coll, items: new }`). A spread of an
 *    expression that is NOT a collection value — an `Expr` AST node copy in
 *    a walker, say — has the same shape and is covered by the allow-list
 *    below, keyed on the file, the reason and the flagged line's text.
 *
 * 3. **A write to a Coll field:** an assignment or compound assignment to a
 *    property `items`, `elem`, `cls` or `kind` of any target
 *    (`x.items = …`, `x['elem'] += …`, `x.kind = 'Coll'`); a `delete` of one
 *    of those names (`delete x.cls`); and a call to `Object.assign` any
 *    argument of which is an object literal whose keys include one of
 *    those four names — the mutating form `Object.assign(x, { items })` and
 *    the copy form `Object.assign({}, x, { items })` both match.
 *
 * 4. **A type-asserted object literal with `items` and `elem`.** An object
 *    literal with both an `items` key and an `elem` key, wrapped (through
 *    any chain of parentheses) in an `as`, `satisfies` or old-style
 *    `<T>expr` type assertion: `{ items, elem } as CollValue`,
 *    `{ items: xs, elem: t } satisfies CollValue`, `<CollValue>{ items,
 *    elem }`. An assertion on an existing value — an identifier, a call,
 *    a property access — is not a creation and is not flagged.
 *
 * ## What the scan does not see
 *
 * - An identifier imported from another file whose value is `'Coll'`: the
 *   scan resolves identifiers against the file it parses, not across files.
 *   No such import exists in the tree today.
 * - A value from `JSON.parse` or `structuredClone` cast to a collection
 *   type: no such call lives in `packages/*​/src`, in
 *   `tools/mainnet-validate/harness/src` or in
 *   `tools/mainnet-validate/harness/scripts`. A cast of a parsed value
 *   would not carry a `kind` at runtime unless that `kind` is in the
 *   parsed data, and the scan treats a `kind` of another string as not a
 *   collection.
 * - A class whose instance field is `kind = 'Coll'`, and an object literal
 *   whose `kind` is a method or a getter: a collection value in the
 *   evaluator is a plain object with the four fields `kind`, `elem`,
 *   `items`, `cls`, never a class instance. No such class or accessor
 *   exists in the tree today.
 * - `Object.assign(x, y)` where `y` is a variable, not a literal: the scan
 *   reads only the literal arguments of `Object.assign`.
 *
 * ## What is not a value creation (and does not match)
 *
 * - A type literal `{ kind: 'Coll'; elem: SType }` inside a `type`,
 *   `interface`, `Extract<…>`, a type parameter, or the right-hand side of
 *   an `as` on a non-literal value: the TypeScript AST represents these as
 *   `TypeLiteralNode` with `PropertySignature` children, not an
 *   `ObjectLiteralExpression`.
 * - A switch label `case 'Coll':`, a comparison `v.kind === 'Coll'`, or a
 *   comment that quotes the string: none is an object literal node.
 * - An array spread `[...obj.items]`: an `ArrayLiteralExpression`, not an
 *   object literal.
 *
 * ## Scope
 *
 * Every `.ts` file under `packages/*​/src` of every workspace package,
 * outside `packages/ergoscript/src/coll/`; plus every `.ts` file under
 * `tools/mainnet-validate/harness/src` and under
 * `tools/mainnet-validate/harness/scripts` (the only tool directory tree
 * with TypeScript sources). Test files are not scanned — a test may build
 * a collection literal on purpose to exercise a code path.
 *
 * The module's own boundary: inside `packages/ergoscript/src/coll/` an
 * object literal of kind `Coll` belongs in `build.ts`. The scan asserts
 * that `class.ts`, `ops.ts` and `index.ts` hold no such literal.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const COLL_FIELDS: ReadonlySet<string> = new Set(['items', 'elem', 'cls', 'kind'])

type FindingReason =
  | 'object-literal-kind-coll'
  | 'spread-with-coll-field'
  | 'write-to-coll-field'
  | 'typed-coll-shape'

interface Finding {
  readonly file: string
  readonly line: number
  readonly snippet: string
  readonly reason: FindingReason
}

/**
 * Parse one `.ts` file with the TypeScript compiler API and return every
 * node that creates or mutates a collection value. Line numbers are 1-based.
 */
function scanFile(filePath: string, text: string): Finding[] {
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
  const collNames = collectCollStringNames(sf)
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)
  const addFinding = (node: ts.Node, reason: FindingReason): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    findings.push({
      file: filePath,
      line: line + 1,
      snippet: (lines[line] ?? '').trim(),
      reason,
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const reason of checkObjectLiteral(node, collNames)) addFinding(node, reason)
    }
    if (isAssignLike(node)) {
      const target = node.left
      if (isCollFieldAccess(target)) addFinding(node, 'write-to-coll-field')
    }
    if (ts.isDeleteExpression(node) && isCollFieldAccess(node.expression)) {
      addFinding(node, 'write-to-coll-field')
    }
    if (ts.isCallExpression(node) && isObjectAssignCall(node)) {
      for (const arg of node.arguments) {
        const lit = unwrap(arg)
        if (ts.isObjectLiteralExpression(lit) && hasCollKey(lit)) {
          addFinding(node, 'write-to-coll-field')
          break
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

/** Strip `as`, `satisfies`, parentheses and old-style `<T>expr` assertions. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  for (;;) {
    if (ts.isAsExpression(e)) { e = e.expression; continue }
    if (ts.isSatisfiesExpression(e)) { e = e.expression; continue }
    if (ts.isParenthesizedExpression(e)) { e = e.expression; continue }
    if (ts.isTypeAssertionExpression(e)) { e = e.expression; continue }
    return e
  }
}

function isCollString(expr: ts.Expression): boolean {
  const e = unwrap(expr)
  if (ts.isStringLiteral(e)) return e.text === 'Coll'
  if (ts.isNoSubstitutionTemplateLiteral(e)) return e.text === 'Coll'
  return false
}

/**
 * Collect every `VariableDeclaration` (`const`, `let`, `var`) whose
 * initialiser resolves to the string `'Coll'`. A `kind` property that reads
 * one of these identifiers in the same file is as good as the literal.
 */
function collectCollStringNames(sf: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && node.initializer !== undefined
      && ts.isIdentifier(node.name)
      && isCollString(node.initializer)
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return names
}

/** Does the expression (through any assertion chain) resolve to `'Coll'`? */
function resolvesToColl(expr: ts.Expression, names: ReadonlySet<string>): boolean {
  const e = unwrap(expr)
  if (ts.isStringLiteral(e)) return e.text === 'Coll'
  if (ts.isNoSubstitutionTemplateLiteral(e)) return e.text === 'Coll'
  if (ts.isIdentifier(e)) return names.has(e.text)
  if (ts.isConditionalExpression(e)) {
    return resolvesToColl(e.whenTrue, names) || resolvesToColl(e.whenFalse, names)
  }
  return false
}

function checkObjectLiteral(
  node: ts.ObjectLiteralExpression,
  names: ReadonlySet<string>,
): FindingReason[] {
  const reasons = new Set<FindingReason>()
  let hasSpread = false
  let hasSpreadCompanionField = false
  let hasItems = false
  let hasElem = false
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      hasSpread = true
      continue
    }
    const name = propertyName(prop)
    if (name === undefined) continue
    if (name === 'items') hasItems = true
    if (name === 'elem') hasElem = true
    if (name === 'items' || name === 'elem' || name === 'cls') hasSpreadCompanionField = true
    if (name === 'kind') {
      if (ts.isPropertyAssignment(prop)) {
        if (resolvesToColl(prop.initializer, names)) reasons.add('object-literal-kind-coll')
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        if (names.has(prop.name.text)) reasons.add('object-literal-kind-coll')
      }
    }
  }
  if (hasSpread && hasSpreadCompanionField) reasons.add('spread-with-coll-field')
  if (hasItems && hasElem && wrappedInTypeAssertion(node)) {
    reasons.add('typed-coll-shape')
  }
  return [...reasons]
}

function wrappedInTypeAssertion(node: ts.Node): boolean {
  let parent: ts.Node | undefined = node.parent
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    parent = parent.parent
  }
  if (parent === undefined) return false
  return (
    ts.isAsExpression(parent)
    || ts.isSatisfiesExpression(parent)
    || ts.isTypeAssertionExpression(parent)
  )
}

function propertyName(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (
    !ts.isPropertyAssignment(prop)
    && !ts.isShorthandPropertyAssignment(prop)
    && !ts.isMethodDeclaration(prop)
    && !ts.isGetAccessorDeclaration(prop)
    && !ts.isSetAccessorDeclaration(prop)
  ) {
    return undefined
  }
  const name = prop.name
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  if (ts.isNumericLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) {
    const e = unwrap(name.expression)
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  }
  return undefined
}

/** `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `**=`, `&=`, `|=`, `^=`, `<<=`, `>>=`, `>>>=`, `&&=`, `||=`, `??=`. */
const ASSIGN_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

function isAssignLike(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && ASSIGN_TOKENS.has(node.operatorToken.kind)
}

/** A `x.items`, `x['items']` and friends — a property access of a Coll name. */
function isCollFieldAccess(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr)) {
    return COLL_FIELDS.has(expr.name.text)
  }
  if (ts.isElementAccessExpression(expr)) {
    const arg = unwrap(expr.argumentExpression)
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      return COLL_FIELDS.has(arg.text)
    }
  }
  return false
}

/** A `Object.assign(...)` call: callee is a property access whose receiver
 *  is the identifier `Object` and whose property is `assign`. */
function isObjectAssignCall(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return false
  if (callee.name.text !== 'assign') return false
  const receiver = callee.expression
  return ts.isIdentifier(receiver) && receiver.text === 'Object'
}

function hasCollKey(lit: ts.ObjectLiteralExpression): boolean {
  for (const prop of lit.properties) {
    const name = propertyName(prop)
    if (name !== undefined && COLL_FIELDS.has(name)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Fixtures: the scanner flags each forbidden form, leaves each allowed one
// ---------------------------------------------------------------------------

const F = 'fixture.ts'

describe('the scanner flags one object literal that creates a Coll value', () => {
  it('a single-quoted kind', () => {
    const src = `const v = { kind: 'Coll', elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a double-quoted kind', () => {
    const src = `const v = { kind: "Coll", elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a template-literal kind with no substitutions', () => {
    const src = 'const v = { kind: `Coll`, elem, items, cls }'
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a string-keyed `kind`', () => {
    const src = `const v = { 'kind': 'Coll', elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a computed key `[\'kind\']`', () => {
    const src = `const v = { ['kind']: 'Coll', elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('the string wrapped in `as const`', () => {
    const src = `const v = { kind: 'Coll' as const, elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('the string wrapped in `satisfies`', () => {
    const src = `const v = { kind: ('Coll' satisfies string), elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a same-file const identifier that resolves to the string', () => {
    const src = `const K = 'Coll' as const\nconst v = { kind: K, elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a same-file `let` binding that resolves to the string', () => {
    const src = `let K = 'Coll'\nconst v = { kind: K, elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a same-file `var` binding that resolves to the string', () => {
    const src = `var K = 'Coll'\nconst v = { kind: K, elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a shorthand property whose local resolves to the string', () => {
    const src = `const kind = 'Coll' as const\nconst v = { kind, elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a conditional whose true branch is the string', () => {
    const src = `const v = { kind: cond ? 'Coll' : 'Int', elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a conditional whose false branch is the string', () => {
    const src = `const v = { kind: cond ? 'Int' : 'Coll', elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a parenthesised and wrapped literal', () => {
    const src = `const v = ({ kind: (('Coll')), elem, items, cls })`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
})

describe('the scanner flags one object literal that spreads and also sets a Coll field', () => {
  it('spread with `items`', () => {
    const src = `const v = { ...x, items: [] }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['spread-with-coll-field'])
  })
  it('spread with `elem`', () => {
    const src = `const v = { ...x, elem: { tag: 'SInt' } }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['spread-with-coll-field'])
  })
  it('spread with `cls`', () => {
    const src = `const v = { ...x, cls: { shape: 'array' } }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['spread-with-coll-field'])
  })
  it('spread with shorthand `items`', () => {
    const src = `function f(x: unknown, items: unknown[]) { return { ...(x as object), items } }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['spread-with-coll-field'])
  })
})

describe('the scanner flags a write to a Coll field', () => {
  it('a property assignment `x.items = …`', () => {
    const src = `function f(x: { items: unknown[] }) { x.items = [] }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['write-to-coll-field'])
  })
  it('a compound assignment `x.cls += …`', () => {
    const src = `function f(x: { cls: string }) { x.cls += 'x' }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['write-to-coll-field'])
  })
  it("an element-access assignment `x['elem'] = …`", () => {
    const src = `function f(x: Record<string, unknown>) { x['elem'] = 1 }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['write-to-coll-field'])
  })
  it('`delete x.cls`', () => {
    const src = `function f(x: { cls?: unknown }) { delete x.cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['write-to-coll-field'])
  })
  it("`delete x['kind']`", () => {
    const src = `function f(x: Record<string, unknown>) { delete x['kind'] }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['write-to-coll-field'])
  })
  it('`Object.assign(x, { items })` (mutate target)', () => {
    const src = `function f(x: object, items: unknown[]) { Object.assign(x, { items }) }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['write-to-coll-field'])
  })
  it("`Object.assign({}, x, { items })` (copy form)", () => {
    const src = `function f(x: object, items: unknown[]) { return Object.assign({}, x, { items }) }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['write-to-coll-field'])
  })
})

describe('the scanner flags a type-asserted object literal with items and elem', () => {
  it('`{ items, elem } as CollValue`', () => {
    const src = `function f(items: unknown[], elem: unknown) { return { items, elem } as CollValue }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['typed-coll-shape'])
  })
  it('`{ items, elem } as SValue`', () => {
    const src = `function f(items: unknown[], elem: unknown) { return { items, elem } as SValue }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['typed-coll-shape'])
  })
  it('`{ items, elem } satisfies CollValue`', () => {
    const src = `function f(items: unknown[], elem: unknown) { return { items, elem } satisfies CollValue }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['typed-coll-shape'])
  })
  it('`<CollValue>{ items, elem }`', () => {
    const src = `function f(items: unknown[], elem: unknown) { return <CollValue>{ items, elem } }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['typed-coll-shape'])
  })
  it('parenthesised `({ items, elem }) as CollValue`', () => {
    const src = `function f(items: unknown[], elem: unknown) { return ({ items, elem }) as CollValue }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['typed-coll-shape'])
  })
})

describe('the scanner does not read a type position as a value creation', () => {
  it('a type alias with a Coll kind', () => {
    const src = `type V = { kind: 'Coll'; elem: unknown; items: unknown[] }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('an interface with a Coll kind', () => {
    const src = `interface V { kind: 'Coll'; elem: unknown }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('`Extract<SValue, { kind: \'Coll\' }>`', () => {
    const src = `type SValue = { kind: 'Coll' } | { kind: 'Int' }\ntype V = Extract<SValue, { kind: 'Coll' }>`
    expect(scanFile(F, src)).toEqual([])
  })
  it('a type assertion to a type literal that mentions Coll', () => {
    const src = `type SValue = { kind: 'Coll' | 'Int' }\nconst v: unknown = null\nconst c = v as Extract<SValue, { kind: 'Coll' }>`
    expect(scanFile(F, src)).toEqual([])
  })
  it('a type predicate mentioning Coll', () => {
    const src = `function isColl(v: { kind: string }): v is { kind: 'Coll' } { return v.kind === 'Coll' }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('a generic type argument that holds Coll', () => {
    const src = `function f<T extends { kind: 'Coll' }>(x: T): T { return x }`
    expect(scanFile(F, src)).toEqual([])
  })
})

describe('the scanner leaves a type assertion on an existing value alone', () => {
  it('`v as CollValue` on an identifier', () => {
    const src = `function f(v: unknown) { return v as CollValue }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('`inputVal as CollValue` on a parameter', () => {
    const src = `function f(inputVal: unknown) { const receiver = inputVal as CollValue; return receiver }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('`f() as CollValue` on a call', () => {
    const src = `function f() { return null }\nfunction g() { return f() as CollValue }`
    expect(scanFile(F, src)).toEqual([])
  })
  it("`v as Extract<SValue, { kind: 'Coll' }>` on an identifier", () => {
    const src = `function f(v: unknown) { return v as Extract<SValue, { kind: 'Coll' }> }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('an object literal of another shape asserted', () => {
    const src = `const v = { foo: 1 } as CollValue`
    expect(scanFile(F, src)).toEqual([])
  })
  it('an object literal with `items` but no `elem` asserted', () => {
    const src = `const v = { items: [] } as CollValue`
    expect(scanFile(F, src)).toEqual([])
  })
})

describe('the scanner leaves a non-creation alone', () => {
  it('a switch case label', () => {
    const src = `function f(v: { kind: string }) { switch (v.kind) { case 'Coll': return 1; default: return 0 } }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('a comparison', () => {
    const src = `function f(v: { kind: string }) { return v.kind === 'Coll' }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('an array spread of items', () => {
    const src = `function f(obj: { items: unknown[] }) { return [...obj.items] }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('an object literal with another kind', () => {
    const src = `const v = { kind: 'Int', value: 1 }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('an object spread without a Coll-shaped field', () => {
    const src = `const v = { ...x, foo: 1, bar: 2 }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('a comment that quotes the string', () => {
    const src = `// A { kind: 'Coll' } sits here\n/* and here: kind: 'Coll' */\nconst v = 1`
    expect(scanFile(F, src)).toEqual([])
  })
  it('an identifier that resolves to another string', () => {
    const src = `const K = 'Int' as const\nconst v = { kind: K, value: 1 }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('a comparison inside a template literal', () => {
    const src = 'function f(v: { kind: string }, expected: string) { return `SValue.kind=${v.kind} expected ${expected}` }'
    expect(scanFile(F, src)).toEqual([])
  })
  it('a function call that is not `Object.assign`', () => {
    const src = `function g(x: object) { Object.keys(x) }`
    expect(scanFile(F, src)).toEqual([])
  })
  it('`Object.assign(x, y)` with a variable source', () => {
    const src = `function f(x: object, y: object) { Object.assign(x, y) }`
    expect(scanFile(F, src)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Allow-list: text-keyed, stale entries fail the test
// ---------------------------------------------------------------------------

/**
 * One finding the reviewer has signed off as something other than a
 * collection value. The matcher pairs on file, reason and the flagged
 * line's trimmed text — a line edit that changes the text invalidates
 * the entry, and an entry with no matching finding fails the test.
 */
interface AllowEntry {
  readonly file: string
  readonly reason: FindingReason
  readonly text: string
  readonly rationale: string
}

const ALLOW: readonly AllowEntry[] = [
  {
    file: 'packages/ergoscript/src/eval/_substitute-deserialize.ts',
    reason: 'spread-with-coll-field',
    text: 'return items === e.items ? e : { ...e, items }',
    rationale:
      "the spread target `e` is the `Expr` parameter of `rewriteBottomUp(e: Expr, ...)`; the `Collection` case rebuilds that Expr node with substituted `items`. `Coll` is an SValue kind, not an Expr kind.",
  },
  {
    file: 'packages/ergoscript/src/eval/_substitute-deserialize.ts',
    reason: 'spread-with-coll-field',
    text: 'return items === e.items ? e : { ...e, items }',
    rationale:
      "the spread target `e` is the `Expr` parameter of `rewriteBottomUp(e: Expr, ...)`; the `Tuple` / `SigmaAnd` / `SigmaOr` case rebuilds that Expr node with substituted `items`. Identical text to the `Collection` case above; each finding pairs with one entry in order.",
  },
  {
    file: 'packages/ergoscript/src/eval/_substitute-deserialize.ts',
    reason: 'spread-with-coll-field',
    text: 'return items === e.items && result === e.result ? e : { ...e, items, result }',
    rationale:
      "the spread target `e` is the `Expr` parameter of `rewriteBottomUp(e: Expr, ...)`; the `BlockValue` case rebuilds that Expr node with substituted `items` and `result`.",
  },
]

interface Partition {
  readonly unallowed: readonly Finding[]
  readonly unused: readonly AllowEntry[]
}

function partition(findings: readonly Finding[], allow: readonly AllowEntry[], root: string): Partition {
  const used = new Set<number>()
  const unallowed: Finding[] = []
  for (const f of findings) {
    const rel = path.relative(root, f.file).replace(/\\/g, '/')
    const idx = allow.findIndex(
      (a, i) => !used.has(i) && a.file === rel && a.reason === f.reason && a.text === f.snippet,
    )
    if (idx === -1) unallowed.push(f)
    else used.add(idx)
  }
  const unused = allow.filter((_, i) => !used.has(i))
  return { unallowed, unused }
}

describe('the allow-list is text-keyed', () => {
  const root = '/repo'
  const file = 'packages/x/src/a.ts'
  const finding: Finding = {
    file: `${root}/${file}`,
    line: 42,
    snippet: 'return { ...e, items }',
    reason: 'spread-with-coll-field',
  }

  it('an entry whose file, reason and text match pairs with the finding and nothing is left over', () => {
    const allow: AllowEntry[] = [
      { file, reason: 'spread-with-coll-field', text: 'return { ...e, items }', rationale: 'ok' },
    ]
    const p = partition([finding], allow, root)
    expect(p.unallowed).toEqual([])
    expect(p.unused).toEqual([])
  })

  it('an entry whose text does not match leaves the finding unallowed and the entry unused', () => {
    const allow: AllowEntry[] = [
      { file, reason: 'spread-with-coll-field', text: 'something else entirely', rationale: 'stale' },
    ]
    const p = partition([finding], allow, root)
    expect(p.unallowed).toEqual([finding])
    expect(p.unused).toEqual(allow)
  })

  it('an entry whose reason does not match leaves the finding unallowed and the entry unused', () => {
    const allow: AllowEntry[] = [
      { file, reason: 'object-literal-kind-coll', text: 'return { ...e, items }', rationale: 'wrong reason' },
    ]
    const p = partition([finding], allow, root)
    expect(p.unallowed).toEqual([finding])
    expect(p.unused).toEqual(allow)
  })

  it('two identical entries pair with two identical findings; a third entry is unused', () => {
    const second: Finding = { ...finding, line: 50 }
    const allow: AllowEntry[] = [
      { file, reason: 'spread-with-coll-field', text: 'return { ...e, items }', rationale: 'first' },
      { file, reason: 'spread-with-coll-field', text: 'return { ...e, items }', rationale: 'second' },
      { file, reason: 'spread-with-coll-field', text: 'return { ...e, items }', rationale: 'surplus' },
    ]
    const p = partition([finding, second], allow, root)
    expect(p.unallowed).toEqual([])
    expect(p.unused).toEqual([allow[2]])
  })
})

// ---------------------------------------------------------------------------
// The scan over the sources
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../..')

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

interface Target {
  readonly name: string
  readonly files: readonly string[]
}

function collectTargets(root: string): Target[] {
  const targets: Target[] = []
  const pkgRoot = path.join(root, 'packages')
  const pkgDirs = fs.readdirSync(pkgRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  for (const name of pkgDirs) {
    const srcDir = path.join(pkgRoot, name, 'src')
    if (!fs.existsSync(srcDir)) continue
    // The one exclusion is `packages/ergoscript/src/coll/`, the module itself.
    const files = listTsFiles(srcDir).filter((f) => {
      const rel = path.relative(pkgRoot, f).replace(/\\/g, '/')
      return !rel.startsWith('ergoscript/src/coll/')
    })
    targets.push({ name, files })
  }
  const toolSrcDir = path.join(root, 'tools', 'mainnet-validate', 'harness', 'src')
  const toolScriptsDir = path.join(root, 'tools', 'mainnet-validate', 'harness', 'scripts')
  const toolFiles: string[] = []
  if (fs.existsSync(toolSrcDir)) toolFiles.push(...listTsFiles(toolSrcDir))
  if (fs.existsSync(toolScriptsDir)) toolFiles.push(...listTsFiles(toolScriptsDir))
  if (toolFiles.length > 0) {
    targets.push({ name: 'tools/mainnet-validate/harness', files: toolFiles })
  }
  return targets
}

describe('no collection value is created outside the module', () => {
  const targets = collectTargets(REPO_ROOT)
  const totalFiles = targets.reduce((n, t) => n + t.files.length, 0)
  const names = targets.map((t) => t.name).sort()

  it('the scan reaches the five workspace packages and the harness-tool tree', () => {
    expect(names).toEqual(
      ['avltree', 'ergoscript', 'nipopow', 'scorex', 'transaction', 'tools/mainnet-validate/harness'].sort(),
    )
    expect(targets.length, 'cardinality').toEqual(6)
    expect(totalFiles, `expected more than 200 files, saw ${totalFiles}`).toBeGreaterThan(200)
  })

  it('every source outside packages/ergoscript/src/coll/ builds no Coll literal', () => {
    const findings: Finding[] = []
    for (const target of targets) {
      for (const file of target.files) {
        const text = fs.readFileSync(file, 'utf8')
        findings.push(...scanFile(file, text))
      }
    }
    const p = partition(findings, ALLOW, REPO_ROOT)
    const unallowedReport = p.unallowed
      .map((f) => `${path.relative(REPO_ROOT, f.file)}:${f.line} [${f.reason}] ${f.snippet}`)
      .join('\n')
    const unusedReport = p.unused
      .map((a) => `${a.file} [${a.reason}] text=${JSON.stringify(a.text)} rationale=${a.rationale}`)
      .join('\n')
    expect(p.unallowed, `UNALLOWED FINDINGS:\n${unallowedReport}`).toEqual([])
    expect(p.unused, `UNUSED ALLOW ENTRIES:\n${unusedReport}`).toEqual([])
  })

  it('inside the module, Coll literals live in build.ts', () => {
    const modDir = path.join(REPO_ROOT, 'packages', 'ergoscript', 'src', 'coll')
    const files = listTsFiles(modDir)
    const findings: Finding[] = []
    for (const file of files) {
      if (path.basename(file) === 'build.ts') continue
      const text = fs.readFileSync(file, 'utf8')
      findings.push(...scanFile(file, text))
    }
    const report = findings
      .map((f) => `${path.relative(REPO_ROOT, f.file)}:${f.line} [${f.reason}] ${f.snippet}`)
      .join('\n')
    expect(findings, report).toEqual([])
  })
})
