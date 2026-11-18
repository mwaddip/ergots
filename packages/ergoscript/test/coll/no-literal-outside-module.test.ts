/**
 * No collection value is created outside the module `coll/`.
 *
 * Every value of kind `Coll` in the evaluator comes out of one builder in
 * `packages/ergoscript/src/coll/`; the module decides the value's class
 * (`CollClass`), the item array and the element type. This scan keeps the
 * rule by parsing every `.ts` source file outside the module and failing on
 * an object literal that creates such a value.
 *
 * ## What the scan flags
 *
 * 1. **An object literal with `kind` set to the string `Coll`.** The key is
 *    the identifier `kind`, the string key `'kind'` / `"kind"`, or a
 *    computed key `['kind']` resolving to the same string. The initialiser
 *    is a string literal `'Coll'` (single or double quoted), a template
 *    literal with no substitutions, an `as`/`satisfies` expression wrapping
 *    one of these, or an identifier whose declaration in the same file is a
 *    const bound to the string `'Coll'` (`const K = 'Coll' as const; { kind:
 *    K, elem, items, cls }`). The shorthand `{ kind, elem, items }` form
 *    matches when the local `kind` in the file resolves to that const.
 *
 * 2. **An object literal that spreads an expression and also sets `items`,
 *    `elem` or `cls`.** This is the shape of a copy of a collection value
 *    with a field replaced (`{ ...coll, items: new }`). A spread of an
 *    expression that is NOT a collection value — an `Expr` AST node copy in
 *    a walker, say — has the same shape and is covered by the allow-list
 *    below, with a reason, a file and a line.
 *
 * ## What the scan does not see
 *
 * - An identifier imported from another file whose value is `'Coll'`: the
 *   scan resolves identifiers against the file it parses, not across files.
 *   No such import exists in the tree today.
 * - A value from `JSON.parse` or `structuredClone` cast to a collection
 *   type: no `JSON.parse` call lives in `packages/*​/src` or in
 *   `tools/mainnet-validate/harness/src`. A cast of a parsed value would
 *   not carry a `kind` at runtime unless that `kind` is in the parsed data,
 *   and the scan treats a `kind` of another string as not a collection.
 * - An assignment to a property `.items`, `.cls`, `.elem` or `.kind` of a
 *   target (`x.items = …`, `Object.assign(x, { items })`, `delete x.cls`):
 *   no such assignment to any of these names exists in the tree today, so
 *   the scan does not read ExpressionStatement forms.
 *
 * ## What is not a value creation (and does not match)
 *
 * - A type literal `{ kind: 'Coll'; elem: SType }` inside a `type`,
 *   `interface`, `Extract<…>`, `as`, `satisfies` or type parameter: the
 *   TypeScript AST represents these as `TypeLiteralNode` with
 *   `PropertySignature` children, not an `ObjectLiteralExpression`.
 * - A switch label `case 'Coll':`, a comparison `v.kind === 'Coll'`, or a
 *   comment that quotes the string: none is an object literal node.
 * - An array spread `[...obj.items]`: an `ArrayLiteralExpression`, not an
 *   object literal.
 *
 * ## Scope
 *
 * Every `.ts` file under `packages/*​/src` of every workspace package,
 * outside `packages/ergoscript/src/coll/`; plus every `.ts` file under
 * `tools/mainnet-validate/harness/src` (the only tool that imports the
 * `@ergots/*` packages). Test files are not scanned — a test may build a
 * collection literal on purpose to exercise a code path.
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

type FindingReason = 'object-literal-kind-coll' | 'spread-with-coll-field'

interface Finding {
  readonly file: string
  readonly line: number
  readonly snippet: string
  readonly reason: FindingReason
}

/**
 * Parse one `.ts` file with the TypeScript compiler API and return every
 * object literal that creates a collection value. Line numbers are 1-based.
 */
function scanFile(filePath: string, text: string): Finding[] {
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
  const collConsts = collectCollStringConsts(sf)
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const reason of check(node, collConsts)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        findings.push({
          file: filePath,
          line: line + 1,
          snippet: (lines[line] ?? '').trim(),
          reason,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

/** Strip `as`, `satisfies`, parentheses and old-style `<T>expr` type assertions. */
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
 * Collect every top-level or nested VariableDeclaration whose initialiser
 * resolves to the string `'Coll'`. A `kind` property that reads one of these
 * identifiers in the same file is as good as the literal.
 */
function collectCollStringConsts(sf: ts.SourceFile): ReadonlySet<string> {
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

function check(node: ts.ObjectLiteralExpression, consts: ReadonlySet<string>): FindingReason[] {
  const reasons = new Set<FindingReason>()
  let hasSpread = false
  let hasCollField = false
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      hasSpread = true
      continue
    }
    const name = propertyName(prop)
    if (name === undefined) continue
    if (name === 'items' || name === 'elem' || name === 'cls') {
      hasCollField = true
    }
    if (name === 'kind') {
      if (ts.isPropertyAssignment(prop)) {
        if (isCollString(prop.initializer)) {
          reasons.add('object-literal-kind-coll')
          continue
        }
        const init = unwrap(prop.initializer)
        if (ts.isIdentifier(init) && consts.has(init.text)) {
          reasons.add('object-literal-kind-coll')
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        if (consts.has(prop.name.text)) {
          reasons.add('object-literal-kind-coll')
        }
      }
    }
  }
  if (hasSpread && hasCollField) reasons.add('spread-with-coll-field')
  return [...reasons]
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

// ---------------------------------------------------------------------------
// Fixtures: the scanner flags each forbidden form and leaves each allowed one
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
  it('a shorthand property whose local resolves to the string', () => {
    const src = `const kind = 'Coll' as const\nconst v = { kind, elem, items, cls }`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('a parenthesised and wrapped literal', () => {
    const src = `const v = ({ kind: (('Coll')), elem, items, cls })`
    expect(scanFile(F, src).map((f) => f.reason)).toEqual(['object-literal-kind-coll'])
  })
  it('an object literal that is also asserted at the type level', () => {
    const src = `const v = { kind: 'Coll', elem, items, cls } as unknown`
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
})

// ---------------------------------------------------------------------------
// The scan over the sources
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../..')

/**
 * Lines a reviewer has signed off as something OTHER than a collection value:
 * each entry names a file, a 1-based line and a reason. A match of the entry's
 * file AND line AND the scanner's reason drops that one finding.
 */
interface AllowEntry {
  readonly file: string
  readonly line: number
  readonly reason: FindingReason
  readonly rationale: string
}

const ALLOW: readonly AllowEntry[] = [
  {
    file: 'packages/ergoscript/src/eval/_substitute-deserialize.ts',
    line: 511,
    reason: 'spread-with-coll-field',
    rationale:
      "the spread target `e` is the `Expr` parameter of `rewriteBottomUp(e: Expr, ...)`; the `Collection` case rebuilds that Expr node with substituted `items`. `Coll` is an SValue kind, not an Expr kind.",
  },
  {
    file: 'packages/ergoscript/src/eval/_substitute-deserialize.ts',
    line: 517,
    reason: 'spread-with-coll-field',
    rationale:
      "the spread target `e` is the `Expr` parameter of `rewriteBottomUp(e: Expr, ...)`; the `Tuple` / `SigmaAnd` / `SigmaOr` case rebuilds that Expr node with substituted `items`.",
  },
  {
    file: 'packages/ergoscript/src/eval/_substitute-deserialize.ts',
    line: 542,
    reason: 'spread-with-coll-field',
    rationale:
      "the spread target `e` is the `Expr` parameter of `rewriteBottomUp(e: Expr, ...)`; the `BlockValue` case rebuilds that Expr node with substituted `items` and `result`.",
  },
]

function isAllowed(f: Finding, root: string): boolean {
  const rel = path.relative(root, f.file).replace(/\\/g, '/')
  return ALLOW.some((a) => a.file === rel && a.line === f.line && a.reason === f.reason)
}

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
  readonly packageName: string
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
    targets.push({ packageName: name, files })
  }
  const toolDir = path.join(root, 'tools', 'mainnet-validate', 'harness', 'src')
  if (fs.existsSync(toolDir)) {
    targets.push({
      packageName: 'tools/mainnet-validate/harness',
      files: listTsFiles(toolDir),
    })
  }
  return targets
}

describe('no collection value is created outside the module', () => {
  const targets = collectTargets(REPO_ROOT)
  const totalFiles = targets.reduce((n, t) => n + t.files.length, 0)
  const packageNames = targets.map((t) => t.packageName)

  it('the scan reaches every workspace package and tool source', () => {
    for (const expected of ['scorex', 'avltree', 'nipopow', 'ergoscript', 'transaction', 'tools/mainnet-validate/harness']) {
      expect(packageNames, `expected ${expected} among ${packageNames.join(', ')}`).toContain(expected)
    }
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
    const unallowed = findings.filter((f) => !isAllowed(f, REPO_ROOT))
    const report = unallowed
      .map((f) => `${path.relative(REPO_ROOT, f.file)}:${f.line} [${f.reason}] ${f.snippet}`)
      .join('\n')
    expect(unallowed, report).toEqual([])
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
