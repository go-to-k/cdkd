/**
 * Issue #3077. Two halves:
 *
 *  1. the helper itself -- `definedAttributes` drops exactly `undefined` /
 *     `null` and keeps every other value (`''`, `false`, `0`, `[]`, `{}`);
 *     `stringifyIfAssigned` never produces `'undefined'`;
 *  2. a SOURCE-SHAPE fence over `src/provisioning/providers/**`: no `?? ''`
 *     / `|| ''` (the template-literal spelling included), and no bare `''`
 *     manufactured where an attribute value is built -- a property value, a
 *     `const` / `let` initializer, an `=` right-hand side, a `?:` branch --
 *     may be REACHABLE from an `attributes` value (the shape
 *     `docs/provider-development.md` forbids) through the shapes the walk
 *     follows -- the literal, a same-function `const` / `let` an identifier
 *     resolves to and every reassignment of it, builder writes onto it, a
 *     same-file helper's `return`s, the ARGUMENTS and the RECEIVER of any
 *     call at those positions, and a spread -- with a floor per followed
 *     shape so a walk that silently stops following one cannot pass, and a
 *     fixture-driven probe (a fake provider under a temp dir) that reds every
 *     shape the fence claims to see.
 *
 * The fence is the sweep that found the class turned into a test: on the
 * pre-fix tree it measures the count the PR body records (the first,
 * literal-only cut saw 71 sites in 11 files -- two review rounds of PR
 * go-to-k/cdkd#3103 found the other shapes), and a prose rule had let all of
 * them ship. Two sites are ALLOW-LISTED by exact line text rather than
 * fixed, because they take a different premise: `AWS::EC2::SecurityGroup`'s
 * `VpcId` is the TEMPLATE's own property, not a read-back, and the resolver's
 * fallback for that attribute is `undefined` -- which `Fn::Join` stringifies
 * to `'undefined'` -- so omitting the key there is worse than `''` until the
 * resolver arm reads the group's VPC live (tracked in the follow-up issue the
 * PR names). Each allow-list entry must still MATCH, so a fixed site fails the
 * test until its entry is removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript-v6';
import {
  definedAttributes,
  stringifyIfAssigned,
} from '../../../src/provisioning/attribute-map.js';

describe('definedAttributes (issue #3077)', () => {
  it('omits undefined and null, and keeps every other value verbatim -- an empty string included', () => {
    const out = definedAttributes({
      Undefined: undefined,
      Null: null,
      Empty: '',
      False: false,
      Zero: 0,
      EmptyList: [],
      EmptyObject: {},
      Str: 'i-1',
    });
    expect(out).toStrictEqual({
      Empty: '',
      False: false,
      Zero: 0,
      EmptyList: [],
      EmptyObject: {},
      Str: 'i-1',
    });
    // Absent, not present-but-undefined: a persisted record must not carry
    // the key at all (`Object.keys` walkers see a present-undefined key).
    for (const key of ['Undefined', 'Null']) {
      expect(Object.hasOwn(out, key)).toBe(false);
    }
    // A `''` that came off the wire is a KNOWN value the caller owns (a
    // running instance's empty public DNS name); the helper stops cdkd
    // manufacturing one, never AWS reporting one. Measured the other way in
    // review: dropping it made a private-subnet instance's `PublicIp`
    // degrade to the instance id on every resolution.
    expect(out['Empty']).toBe('');
  });

  it('returns a fresh object rather than mutating its input', () => {
    const input = { A: 'a', B: undefined };
    const out = definedAttributes(input);
    expect(out).not.toBe(input);
    expect(Object.hasOwn(input, 'B')).toBe(true);
  });
});

describe('stringifyIfAssigned (issue #3077)', () => {
  it('stringifies an assigned number, including 0, and passes a string through', () => {
    expect(stringifyIfAssigned(5432)).toBe('5432');
    expect(stringifyIfAssigned(0)).toBe('0');
    expect(stringifyIfAssigned('8182')).toBe('8182');
  });

  it('answers undefined for an unassigned field so the key is dropped, never the literal "undefined"', () => {
    expect(stringifyIfAssigned(undefined)).toBeUndefined();
    expect(stringifyIfAssigned(null)).toBeUndefined();
    // The trap this exists for: deleting `?? ''` from `String(x ?? '')`.
    expect(String(undefined)).toBe('undefined');
    // `toStrictEqual`: `toEqual` ignores an `undefined`-valued key, so an
    // identity `definedAttributes` would still pass it (review nit).
    expect(definedAttributes({ Port: stringifyIfAssigned(undefined) })).toStrictEqual({});
  });
});

// ---------------------------------------------------------------------------
// Source-shape fence.
// ---------------------------------------------------------------------------

const PROVIDERS_DIR = join(process.cwd(), 'src', 'provisioning', 'providers');

/**
 * The two sites deliberately left on the old shape, keyed by file and the
 * exact expression text. The match is an EQUALITY, one hit per entry: removing
 * a site from the code without removing it here fails, and a THIRD copy of an
 * allow-listed text fails too (a `some()` match let it through -- maintainer
 * review of PR go-to-k/cdkd#3103), so the list cannot rot in either direction.
 */
const ALLOW_LISTED_SITES: ReadonlyArray<readonly [string, string]> = [
  // One entry per OCCURRENCE (the create and the update literal), consumed
  // one-for-one by the "still matches" case below -- the two identical
  // tuples are deliberate, not a duplicate.
  ['ec2-provider.ts', "(properties['VpcId'] as string) ?? ''"],
  ['ec2-provider.ts', "(properties['VpcId'] as string) ?? ''"],
];

interface Hit {
  file: string;
  line: number;
  text: string;
}

interface Scan {
  hits: Hit[];
  files: number;
  /** `attributes` VALUES seen (property, shorthand, or `const attributes`). */
  attributeValues: number;
  /** Identifier values resolved to a same-function declaration (the hoisted shape). */
  hoistedResolved: number;
  /** Call values resolved to a same-file method / function body (the helper-return shape). */
  helperCallsResolved: number;
  /** `attrs['X'] = …` / `attrs.X = …` assignments followed (the builder shape). */
  builderAssignments: number;
  /** Values NOT followed because they sat past the depth cap -- the one silent drop, floored below. */
  depthDropped: number;
}

/**
 * Walk every provider source and collect each `?? ''` / `|| ''` (and each
 * bare `''` property value) REACHABLE from an `attributes` value, plus a
 * count per input SHAPE the walk claims to handle -- the parser floors below.
 * The first cut of this fence scanned only the literal's own subtree and
 * missed 21 sites in six files (round 1 of PR go-to-k/cdkd#3103's review): a
 * `const arn = x ?? ''` one hop above the literal, an
 * `attributes['X'] = y ?? ''` builder, a `this.toAttributes(m)` helper whose
 * body carried the `?? ''`, and the `|| ''` spelling. Round 2 found the
 * arguments of a call at an attribute position unscanned (a hoisted `const`
 * passed INTO `definedAttributes({ K: x })`, or `this.build(resp, x ?? '')`),
 * a `let x = ''` reassigned with `|| ''`, and a bare `DefaultNetworkAcl: ''`.
 * Each shape now has a floor, so a walk that silently stops following one
 * cannot pass.
 *
 * Documented reach, i.e. what the walk does NOT follow: a call nested inside
 * a property value's own expression is not RESOLVED to its callee's body (a
 * fallback spelled inline in that expression IS seen, since the property's
 * whole subtree is scanned); a per-member arrow helper declared as a
 * `const` (`ec2-provider.ts`'s `publicMember` is that shape, and its
 * `?? ''` is the deliberate known-empty of a settled instance -- invisible
 * to this walk rather than allow-listed, so a wrong site spelled that way
 * would pass too); a helper resolved by BARE NAME (`findCallee` takes the first
 * same-named method / function in the file, so a file declaring several
 * classes with a same-named method can attribute a hit to the wrong class or
 * miss one); and `findDeclaration`, which takes the first same-named
 * declaration in the enclosing function.
 *
 * Also out of reach, each pinned as a NOT FOLLOWED fixture below: a key
 * recorded present-but-`undefined` without the helper (`{ Port: r.port }`)
 * -- this fence catches the MANUFACTURE of `''`, and a present-`undefined`
 * key vanishes at JSON persistence anyway; a binding-pattern default
 * (`const { arn = '' } = resp` -- `findDeclaration` needs an identifier
 * name); the compound assignments `??=` / `||=` (only `=` is a builder write,
 * and neither is a fallback expression); and `Object.assign(attributes, {...})`
 * (a call that is not at an attributes position). The fence is conservative
 * in the other direction too: a `let s = ''` accumulator later grown with `+=`
 * and a `''` inside `JSON.stringify({...})` at an attributes value both read as
 * hits, because the walk sees only the initializer / the nested literal.
 */
function scanProviders(providersDir: string = PROVIDERS_DIR): Scan {
  const files = readdirSync(providersDir)
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const scan: Scan = {
    hits: [],
    files: files.length,
    attributeValues: 0,
    hoistedResolved: 0,
    helperCallsResolved: 0,
    builderAssignments: 0,
    depthDropped: 0,
  };

  /** `''` or an empty template literal -- the two spellings of the manufactured value. */
  const isEmptyStringLiteral = (node: ts.Node): boolean =>
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === '';

  const isEmptyStringFallback = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    isEmptyStringLiteral(node.right);

  const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
    let cur: ts.Node | undefined = node.parent;
    while (cur !== undefined && !ts.isFunctionLike(cur)) cur = cur.parent;
    return cur;
  };

  for (const file of files) {
    const path = join(providersDir, file);
    const sf = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visited = new Set<ts.Node>();

    const recorded = new Set<number>();
    const record = (n: ts.Node): void => {
      // One hit per source position: the `const attributes = {}` declaration
      // and the `attributes` shorthand that returns it both reach the same
      // builder writes.
      if (recorded.has(n.getStart())) return;
      recorded.add(n.getStart());
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
      scan.hits.push({ file, line: line + 1, text: n.getText().replace(/\s+/g, ' ') });
    };

    /** The same-file method or function declaration a call resolves to, by bare name. */
    const findCallee = (call: ts.CallExpression): ts.Node | undefined => {
      const callee = call.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      if (name === undefined) return undefined;
      let found: ts.Node | undefined;
      const look = (n: ts.Node): void => {
        if (found) return;
        if (
          (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) &&
          n.name !== undefined &&
          n.name.getText() === name &&
          n.body !== undefined
        ) {
          found = n;
          return;
        }
        ts.forEachChild(n, look);
      };
      look(sf);
      return found;
    };

    /** The `const`/`let` declaration of `name` inside `fn`, if any. */
    const findDeclaration = (name: string, fn: ts.Node): ts.VariableDeclaration | undefined => {
      let found: ts.VariableDeclaration | undefined;
      const look = (n: ts.Node): void => {
        if (found) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
          found = n;
          return;
        }
        ts.forEachChild(n, look);
      };
      look(fn);
      return found;
    };

    /**
     * Every `name[...] = rhs` / `name.x = rhs` (a builder write) and every
     * plain `name = rhs` (a `let` reassignment) inside `fn`, yielding the rhs.
     */
    const builderWrites = (name: string, fn: ts.Node): ts.Expression[] => {
      const out: ts.Expression[] = [];
      const look = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const target = n.left;
          const isBuilderWrite =
            (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target)) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === name;
          const isReassignment = ts.isIdentifier(target) && target.text === name;
          if (isBuilderWrite || isReassignment) out.push(n.right);
        }
        ts.forEachChild(n, look);
      };
      look(fn);
      return out;
    };

    /** Strip `await` / parentheses / `as` / `satisfies` / `!` around a value. */
    const unwrap = (node: ts.Node): ts.Node => {
      let cur = node;
      for (;;) {
        if (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur)) cur = cur.expression;
        else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
        else if (ts.isNonNullExpression(cur)) cur = cur.expression;
        else return cur;
      }
    };

    /**
     * A bare `''` manufactured where an attribute value is BUILT: a property
     * value (`Key: ''`), a `const` / `let` initializer (`const arn = ''`), the
     * right-hand side of an `=` (`attrs['Arn'] = ''`, `x = ''`), or a `?:`
     * branch (`cond ? resp.Id : ''`). An empty string in any other position
     * (an argument to `.join('')`, a comparison `=== ''`) is not a value the
     * map records.
     */
    const isManufacturedEmpty = (node: ts.Node): boolean => {
      if (!isEmptyStringLiteral(node)) return false;
      const parent = node.parent;
      if (parent === undefined) return false;
      if (ts.isPropertyAssignment(parent)) return parent.initializer === node;
      if (ts.isVariableDeclaration(parent)) return parent.initializer === node;
      if (ts.isBinaryExpression(parent)) {
        return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node;
      }
      if (ts.isConditionalExpression(parent)) {
        return parent.whenTrue === node || parent.whenFalse === node;
      }
      return false;
    };

    /** Record every `?? ''` / `|| ''` / manufactured `''` in the subtree; follows nothing. */
    const scanLiteral = (node: ts.Node): void => {
      if (isEmptyStringFallback(node) || isManufacturedEmpty(node)) record(node);
      ts.forEachChild(node, scanLiteral);
    };

    /** A helper call: scan each `return` of its same-file body as an attributes value. */
    const followCall = (call: ts.CallExpression, depth: number): boolean => {
      const callee = findCallee(call);
      if (
        callee === undefined ||
        !(ts.isMethodDeclaration(callee) || ts.isFunctionDeclaration(callee))
      ) {
        return false;
      }
      scan.helperCallsResolved += 1;
      const returns: ts.Expression[] = [];
      const collect = (n: ts.Node): void => {
        if (ts.isReturnStatement(n) && n.expression !== undefined) returns.push(n.expression);
        // Do not descend into nested functions: their returns are not this helper's.
        if (n !== callee && ts.isFunctionLike(n)) return;
        ts.forEachChild(n, collect);
      };
      collect(callee.body!);
      for (const r of returns) scanAttributesValue(r, callee, depth + 1);
      return true;
    };

    /**
     * The arguments AND the receiver of a call at an attribute position,
     * whether or not the callee was followed: `definedAttributes({ K: hoisted })`
     * carries the literal INSIDE the call, `this.build(resp, x ?? '')` carries
     * the fallback in an argument the helper's body never spells, and
     * `[resp.Id ?? ''].join('')` carries it in the RECEIVER of a method call
     * (`this` is not a receiver worth following; a method on it is the
     * followed-callee case).
     */
    const scanCallArguments = (call: ts.CallExpression, fn: ts.Node | undefined, depth: number): void => {
      for (const arg of call.arguments) scanAttributesValue(arg, fn, depth + 1);
      const callee = unwrap(call.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const receiver = unwrap(callee.expression);
        if (receiver.kind !== ts.SyntaxKind.ThisKeyword) {
          scanAttributesValue(receiver, fn, depth + 1);
        }
      }
    };

    /**
     * One attributes VALUE. Follows exactly the four shapes the fence claims:
     * the literal (each property value's own subtree), an identifier's
     * same-function initializer (a hoisted `const x = … ?? ''`), builder
     * writes onto that identifier (`x['K'] = … ?? ''`), and a same-file
     * helper's `return`s. It does NOT follow a call nested inside a property
     * value's expression, nor a local arrow helper applied per member -- the
     * documented reach of this walk, bounded so a tag-map or physical-id
     * helper two hops away cannot report a false positive.
     */
    const scanAttributesValue = (raw: ts.Node, fn: ts.Node | undefined, depth: number): void => {
      // The cap bounds a pathological chain; `visited` is what bounds cycles.
      // Spread -> helper return -> `definedAttributes(...)` argument -> a
      // member's own call argument reaches depth 4 and must be followed: with
      // the cap at 2 the spread-shaped MUTANT stayed green, i.e. the fence
      // missed it. What sits past the cap is COUNTED, not silently dropped:
      // the fence below caps `depthDropped`, because a cap is the one place
      // this walk stops following a shape with no floor to notice.
      if (depth > 4) {
        scan.depthDropped += 1;
        return;
      }
      if (visited.has(raw)) return;
      visited.add(raw);
      const value = unwrap(raw);
      if (ts.isIdentifier(value) && fn !== undefined) {
        const decl = findDeclaration(value.text, fn);
        if (decl === undefined) return;
        scan.hoistedResolved += 1;
        if (decl.initializer !== undefined) scanAttributesValue(decl.initializer, fn, depth + 1);
        for (const rhs of builderWrites(value.text, fn)) {
          scan.builderAssignments += 1;
          scanLiteral(rhs);
        }
        return;
      }
      if (ts.isCallExpression(value)) {
        followCall(value, depth);
        scanCallArguments(value, fn, depth);
        return;
      }
      if (ts.isObjectLiteralExpression(value)) {
        for (const prop of value.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const pv = unwrap(prop.initializer);
            if (ts.isIdentifier(pv) && fn !== undefined) {
              const decl = findDeclaration(pv.text, fn);
              if (decl !== undefined) {
                scan.hoistedResolved += 1;
                if (decl.initializer !== undefined) scanLiteral(decl.initializer);
                for (const rhs of builderWrites(pv.text, fn)) scanLiteral(rhs);
              }
            } else if (ts.isCallExpression(pv)) {
              followCall(pv, depth);
              scanCallArguments(pv, fn, depth);
            } else {
              scanLiteral(prop);
            }
          } else if (ts.isShorthandPropertyAssignment(prop) && fn !== undefined) {
            const decl = findDeclaration(prop.name.text, fn);
            if (decl !== undefined) {
              scan.hoistedResolved += 1;
              if (decl.initializer !== undefined) scanLiteral(decl.initializer);
              for (const rhs of builderWrites(prop.name.text, fn)) scanLiteral(rhs);
            }
          } else if (ts.isSpreadAssignment(prop)) {
            scanAttributesValue(prop.expression, fn, depth + 1);
          } else {
            scanLiteral(prop);
          }
        }
        return;
      }
      scanLiteral(value);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText() === 'attributes') {
        scan.attributeValues += 1;
        scanAttributesValue(node.initializer, enclosingFunction(node), 0);
      }
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'attributes') {
        scan.attributeValues += 1;
        scanAttributesValue(node.name, enclosingFunction(node), 0);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'attributes' &&
        node.initializer !== undefined
      ) {
        scan.attributeValues += 1;
        scanAttributesValue(node.name, enclosingFunction(node), 0);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return scan;
}

// Measured on the tree this fence shipped with; each is ~12% under the count.
const FLOORS = {
  attributeValues: 330, // measured 376
  hoistedResolved: 190, // measured 220
  helperCallsResolved: 34, // measured 40
  builderAssignments: 76, // measured 86
};
// Values past the depth cap, measured 2026-09-14: 19, all arguments of
// physical-id / poll helpers (`route53` `.replace(...)`, `emr-cluster`,
// `fsx-filesystem`, `s3-bucket` `region || 'us-east-1'`), none a recorded
// shape. A CAP rather than a floor: growth past it means a new deep chain the
// walk no longer sees, which is the drop to investigate.
const DEPTH_DROPPED_CAP = 25;

/**
 * The fence's verdict over a scan: hits that match no allow-list entry, and
 * the allow-list entries left over after each hit consumes at most ONE entry.
 * An equality in both directions: `unexpected` holds every hit beyond the
 * allow-list (a third copy of an allow-listed text lands here, since the two
 * entries are consumed by the first two hits), and `unconsumed` holds every
 * entry no hit matched (a fixed site that kept its entry).
 */
function allowListVerdict(scan: Scan): { unexpected: string[]; unconsumed: string[] } {
  const remaining = [...ALLOW_LISTED_SITES];
  const unexpected: string[] = [];
  for (const h of scan.hits) {
    const i = remaining.findIndex(([file, text]) => file === h.file && text === h.text);
    if (i >= 0) remaining.splice(i, 1);
    else unexpected.push(`${h.file}:${h.line}: ${h.text}`);
  }
  return { unexpected, unconsumed: remaining.map(([file, text]) => `${file}: ${text}`) };
}

describe('no provider records an attribute as `?? \'\'` (issue #3077 fence)', () => {
  const scan = scanProviders();

  it('parsed a real population of provider files, attribute values and every followed shape (parser floors)', () => {
    // Measured 2026-09-14 on the tree this fence shipped with: 82 provider
    // files and the FLOORS counts above. Floors sit ~12% under the measurement
    // so ordinary editing is free and a walk that silently stops following one
    // shape is not -- each shape the walk claims to handle has its own floor,
    // because an aggregate alone hides one dead shape.
    expect(scan.files).toBeGreaterThanOrEqual(72);
    expect(scan.attributeValues).toBeGreaterThanOrEqual(FLOORS.attributeValues);
    expect(scan.hoistedResolved).toBeGreaterThanOrEqual(FLOORS.hoistedResolved);
    expect(scan.helperCallsResolved).toBeGreaterThanOrEqual(FLOORS.helperCallsResolved);
    expect(scan.builderAssignments).toBeGreaterThanOrEqual(FLOORS.builderAssignments);
    expect(
      scan.depthDropped,
      'values past the depth cap grew: a new deep chain the walk no longer sees -- find it and either raise the cap with a reason or shorten the chain'
    ).toBeLessThanOrEqual(DEPTH_DROPPED_CAP);
  });

  it('finds no `?? \'\'` / `|| \'\'` / manufactured `\'\'` reachable from an attributes value beyond the allow-listed sites, one hit per entry', () => {
    expect(
      allowListVerdict(scan).unexpected,
      'record the attribute through `definedAttributes` (src/provisioning/attribute-map.ts) so an unassigned read-back is ABSENT, not \'\''
    ).toEqual([]);
  });

  it('still matches every allow-listed site, so a fixed site retires its entry', () => {
    expect(
      allowListVerdict(scan).unconsumed,
      'allow-list entries no longer present in the source'
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven probe: every shape the fence claims to see reds on a fake
// provider, and the shapes it declares out of reach are pinned as misses so a
// widening is a deliberate edit here rather than a surprise.
// ---------------------------------------------------------------------------

/** One fake provider per shape; `hit` is the expression text the fence must report. */
const SHAPE_FIXTURES: ReadonlyArray<{ name: string; source: string; hit: string | null }> = [
  {
    name: 'literal ?? \'\'',
    source: `return { physicalId: id, attributes: { Arn: resp.arn ?? '' } };`,
    hit: "resp.arn ?? ''",
  },
  {
    name: 'literal || \'\'',
    source: `return { physicalId: id, attributes: { Arn: resp.arn || '' } };`,
    hit: "resp.arn || ''",
  },
  {
    name: 'empty template literal fallback',
    source: 'return { physicalId: id, attributes: { Arn: resp.arn ?? `` } };',
    hit: 'resp.arn ?? ``',
  },
  {
    name: 'bare \'\' property',
    source: `return { physicalId: id, attributes: { Arn: '' } };`,
    hit: "''",
  },
  {
    name: 'hoisted const ?? \'\'',
    source: `const arn = resp.arn ?? ''; return { physicalId: id, attributes: { Arn: arn } };`,
    hit: "resp.arn ?? ''",
  },
  {
    name: 'hoisted const initialized to \'\'',
    source: `const arn = ''; return { physicalId: id, attributes: { Arn: arn } };`,
    hit: "''",
  },
  {
    name: 'let initialized to \'\' then reassigned (the pre-fix VPC shape)',
    source: `let x = ''; try { x = resp.id!; } catch {} return { physicalId: id, attributes: { Arn: x } };`,
    hit: "''",
  },
  {
    name: 'let reassigned with || \'\'',
    source: `let x: string | undefined; x = resp.id || ''; return { physicalId: id, attributes: { Arn: x } };`,
    hit: "resp.id || ''",
  },
  {
    name: 'builder write ?? \'\'',
    source: `const attributes: Record<string, unknown> = {}; attributes['Arn'] = resp.arn ?? ''; return { physicalId: id, attributes };`,
    hit: "resp.arn ?? ''",
  },
  {
    name: 'builder write of bare \'\'',
    source: `const attributes: Record<string, unknown> = {}; attributes['Arn'] = ''; return { physicalId: id, attributes };`,
    hit: "''",
  },
  {
    name: 'conditional branch \'\' (then)',
    source: `return { physicalId: id, attributes: { Arn: resp.id === undefined ? '' : resp.id } };`,
    hit: "''",
  },
  {
    name: 'conditional branch \'\' (else)',
    source: `return { physicalId: id, attributes: { Arn: cond ? resp.id : '' } };`,
    hit: "''",
  },
  {
    name: 'same-file helper return',
    source: `return { physicalId: id, attributes: this.toAttributes(resp) }; } private toAttributes(r: Resp): Record<string, unknown> { return { Arn: r.arn ?? '' };`,
    hit: "r.arn ?? ''",
  },
  {
    name: 'call argument (a hoisted const inside definedAttributes)',
    source: `const arn = resp.arn ?? ''; return { physicalId: id, attributes: definedAttributes({ Arn: arn }) };`,
    hit: "resp.arn ?? ''",
  },
  {
    name: 'followed helper\'s argument',
    source: `return { physicalId: id, attributes: this.build(resp, resp.name ?? '') }; } private build(r: Resp, n: string): Record<string, unknown> { return { Name: n };`,
    hit: "resp.name ?? ''",
  },
  {
    name: 'method-call receiver',
    source: `return { physicalId: id, attributes: { Arn: [resp.arn ?? ''].join('') } };`,
    hit: "resp.arn ?? ''",
  },
  {
    name: 'spread of a helper return',
    source: `return { physicalId: id, attributes: { ...this.toAttributes(resp) } }; } private toAttributes(r: Resp): Record<string, unknown> { return definedAttributes({ Arn: r.arn ?? '' });`,
    hit: "r.arn ?? ''",
  },
  // Declared out of reach -- pinned as MISSES so widening the walk is a
  // deliberate edit of this table, never a silent change of verdict.
  {
    name: 'NOT FOLLOWED: per-member arrow helper (ec2-provider.ts publicMember)',
    source: `const member = (v: string | undefined): string => v ?? ''; return { physicalId: id, attributes: { Arn: member(resp.arn) } };`,
    hit: null,
  },
  {
    name: 'a fallback spelled inline anywhere in a property value\'s expression IS seen',
    source: `return { physicalId: id, attributes: { Arn: 'arn:' + String(resp.arn ?? '') } };`,
    hit: "resp.arn ?? ''",
  },
  {
    name: 'NOT FOLLOWED: a call nested inside a property value\'s expression is not resolved to its body',
    source: `return { physicalId: id, attributes: { Arn: 'arn:' + this.suffix(resp) } }; } private suffix(r: Resp): string { return r.arn ?? '';`,
    hit: null,
  },
  {
    name: 'NOT a manufactured value: \'\' as a join separator',
    source: `return { physicalId: id, attributes: { Arn: [resp.a, resp.b].join('') } };`,
    hit: null,
  },
  {
    name: 'NOT FOLLOWED: a present-but-undefined key recorded without the helper',
    source: `return { physicalId: id, attributes: { Arn: resp.arn } };`,
    hit: null,
  },
  {
    name: 'NOT FOLLOWED: binding-pattern default (const { arn = \'\' } = resp)',
    source: `const { arn = '' } = resp; return { physicalId: id, attributes: { Arn: arn } };`,
    hit: null,
  },
  {
    name: 'NOT FOLLOWED: compound assignment ??= / ||= on a builder',
    source: `const attributes: Record<string, unknown> = { Arn: resp.arn }; attributes['Arn'] ??= ''; attributes['Name'] ||= ''; return { physicalId: id, attributes };`,
    hit: null,
  },
  {
    name: 'NOT FOLLOWED: Object.assign onto the builder',
    source: `const attributes: Record<string, unknown> = {}; Object.assign(attributes, { Arn: resp.arn ?? '' }); return { physicalId: id, attributes };`,
    hit: null,
  },
];

function fakeProvider(body: string): string {
  return [
    "import { definedAttributes } from '../attribute-map.js';",
    'type Resp = { arn?: string; name?: string; id?: string; a?: string; b?: string };',
    'declare const cond: boolean;',
    'export class FakeProvider {',
    '  create(id: string, resp: Resp) {',
    `    ${body}`,
    '  }',
    '}',
    '',
  ].join('\n');
}

describe('the fence reds every shape it claims to see (fixture-driven probe)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'attribute-map-fence-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(SHAPE_FIXTURES)('$name', ({ source, hit }) => {
    const shapeDir = mkdtempSync(join(dir, 'shape-'));
    writeFileSync(join(shapeDir, 'fake-provider.ts'), fakeProvider(source));
    const scan = scanProviders(shapeDir);
    // A builder fixture reaches two (the `const attributes` declaration and the
    // shorthand that returns it); one hit per source position either way.
    expect(scan.attributeValues, 'the fixture must reach an attributes value').toBeGreaterThanOrEqual(1);
    const texts = scan.hits.map((h) => h.text);
    if (hit === null) {
      expect(texts).toEqual([]);
    } else {
      expect(texts).toEqual([hit]);
    }
  });

  it('refuses a THIRD copy of an allow-listed text (the allow-list is an equality, not a some())', () => {
    const shapeDir = mkdtempSync(join(dir, 'allow-'));
    const copy = "VpcId: (properties['VpcId'] as string) ?? '',";
    writeFileSync(
      join(shapeDir, 'ec2-provider.ts'),
      [
        'export class FakeProvider {',
        '  one(properties: Record<string, unknown>) {',
        `    return { physicalId: 'a', attributes: { ${copy} } };`,
        '  }',
        '  two(properties: Record<string, unknown>) {',
        `    return { physicalId: 'b', attributes: { ${copy} } };`,
        '  }',
        '  three(properties: Record<string, unknown>) {',
        `    return { physicalId: 'c', attributes: { ${copy} } };`,
        '  }',
        '}',
        '',
      ].join('\n')
    );
    const scan = scanProviders(shapeDir);
    expect(scan.hits).toHaveLength(3);
    const verdict = allowListVerdict(scan);
    expect(verdict.unconsumed).toEqual([]);
    expect(verdict.unexpected).toHaveLength(1);
    expect(verdict.unexpected[0]).toContain("(properties['VpcId'] as string) ?? ''");
  });
});
