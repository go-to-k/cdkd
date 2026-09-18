/**
 * Issue [#3364](https://github.com/go-to-k/cdkd/issues/3364) — every
 * `SecretMasker` PARAMETER in `dynamodb-table-provider.ts` is REQUIRED, with no
 * identity default.
 *
 * Why this file exists at all, when the typechecker is already the fence: the
 * typechecker fences the CALL SITES, and nothing fences the SIGNATURES. Re-adding
 * ` = (text) => text` to any one of them is a one-token edit that typechecks,
 * passes every behavioural suite (a unit case that passes no context cannot tell
 * a defaulted identity from an explicitly-passed one), and passes
 * `vp run audit:provider-secret-mask:check`, which accepts anything DECLARED
 * `SecretMasker` — and it silently re-opens the hole at every call site at once.
 * Issue #2007 records why that is worse than no masker: its presence stops the
 * next author looking.
 *
 * Parsed with the TS compiler API rather than grepped, because the shape is
 * defeatable by a line break between the parameter name and its initializer.
 *
 * SCOPE, stated so a later reader does not over-read it: this file covers
 * `dynamodb-table-provider.ts` ONLY. Five sibling providers still carry
 * parameter-default maskers and are tracked separately; this fence is
 * deliberately not widened to them, because a repo-wide assertion would be RED
 * on arrival and would have to be allow-listed, which is the shape that goes
 * inert.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';

const SUBJECT = fileURLToPath(
  new URL('../../../src/provisioning/providers/dynamodb-table-provider.ts', import.meta.url)
);

/**
 * The floor that keeps the assertion from passing VACUOUSLY.
 *
 * A fence saying "no `SecretMasker` parameter carries an initializer" is
 * trivially satisfied by a file with no `SecretMasker` parameters at all — a
 * rename, a refactor that stops threading the capability, or a walk that
 * silently stops matching. Taken as a LITERAL from a source the walk does not
 * read (`grep -c 'maskSecrets: SecretMasker$'` on the tree this shipped with),
 * so the fence cannot compute its own expectation.
 *
 * Sixteen: the twelve issue #3364 converted, plus the four issue #3291 and its
 * siblings had already made required (`indexCapacityForSend`,
 * `indexCeilingForSend`, `coerceOnDemandCeilingsForSend`,
 * `warnUnusableOnDemandCeiling`). A raise is fine; a DROP means the walk stopped
 * seeing parameters it used to see.
 */
const MIN_MASKER_PARAMETERS = 16;

interface MaskerParameter {
  readonly owner: string;
  readonly line: number;
  readonly hasInitializer: boolean;
  readonly isOptional: boolean;
}

function collectMaskerParameters(): MaskerParameter[] {
  const sf = ts.createSourceFile(
    SUBJECT,
    readFileSync(SUBJECT, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const found: MaskerParameter[] = [];

  /** The nearest enclosing named function-like declaration, for the report. */
  const ownerOf = (node: ts.Node): string => {
    let cur: ts.Node | undefined = node.parent;
    while (cur !== undefined) {
      if (ts.isFunctionLike(cur)) {
        const name = (cur as { name?: ts.Node }).name;
        if (name !== undefined && ts.isIdentifier(name as ts.Identifier)) {
          return (name as ts.Identifier).text;
        }
        return '<anonymous>';
      }
      cur = cur.parent;
    }
    return '<module>';
  };

  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && node.type !== undefined) {
      // Match the TYPE, not the parameter NAME: a masker parameter spelled
      // `mask` / `maskFn` is the same capability and the same hole, and a
      // name-keyed walk would miss it (the #2176 lesson — a sweep keyed on the
      // known copies' spellings missed two).
      if (node.type.getText() === 'SecretMasker') {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        found.push({
          owner: ownerOf(node),
          line: line + 1,
          hasInitializer: node.initializer !== undefined,
          isOptional: node.questionToken !== undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('AWS::DynamoDB::Table provider: the masker parameter is REQUIRED (issue #3364)', () => {
  const parameters = collectMaskerParameters();

  it('finds every SecretMasker parameter in the provider', () => {
    expect(parameters.length).toBeGreaterThanOrEqual(MIN_MASKER_PARAMETERS);
  });

  it('declares none of them with an identity (or any) default', () => {
    const defaulted = parameters
      .filter((p) => p.hasInitializer)
      .map((p) => `${p.owner} (line ${p.line})`);
    expect(defaulted).toEqual([]);
  });

  it('declares none of them optional', () => {
    // The sibling spelling: `maskSecrets?: SecretMasker` is the same hole
    // reached without an initializer — the argument is droppable and the
    // callee's own `?? identity` read (or a crash) decides what happens.
    const optional = parameters
      .filter((p) => p.isOptional)
      .map((p) => `${p.owner} (line ${p.line})`);
    expect(optional).toEqual([]);
  });
});
