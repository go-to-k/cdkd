import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { preserveLiveValuesAtUnresolvedTokens } from '../../../src/cli/commands/drift.js';
import {
  DYNAMIC_REFERENCE_INNER,
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  dynamicReferenceTokens,
  isSingleDynamicReferenceToken,
  redactSecretsForState,
  scrubResourceRecord,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  STATE_SOURCED_READBACK_RULES,
  WHOLE_DYNAMIC_REFERENCE_PATTERN,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/**
 * Issue [#1936](https://github.com/go-to-k/cdkd/issues/1936): three spellings of
 * the `{{resolve:...}}` token pattern disagreed, and the strictest one persisted
 * PLAINTEXT.
 *
 * The authority is `IntrinsicFunctionResolver.resolveDynamicReferences`'s own
 * scan, `/\{\{resolve:([^}]+)\}\}/g` — what cdkd will actually try to resolve.
 * `secret-redaction.ts`'s `isSingleDynamicReferenceToken` and `drift.ts`'s
 * `isWholeDynamicReference` both spelled the inner class `[^{}]*`, so a
 * reference whose inner text contains a `{` was RESOLVED by cdkd and then
 * classified as not-a-token by every predicate downstream — the whole-token
 * source arm refused it, and on an empty-secrets-map path the resolved
 * plaintext reached `state.json`.
 *
 * Every case below is a MUTATION PROBE target: reverting
 * `DYNAMIC_REFERENCE_INNER` to `[^{}]*` must red them.
 */

/**
 * A reference whose inner text carries a `{` — a Secrets Manager JSON key, per
 * the issue. The `{` is UNBALANCED on purpose: the resolver's `[^}]+` stops at
 * the first `}`, so a balanced `my{key}` would terminate the token early and be
 * a different (genuinely mixed) shape. This is exactly the string the two
 * spellings classify differently and nothing else is.
 */
const BRACED_EXPRESSION = '{{resolve:secretsmanager:app/db:SecretString:my{key}}';

/** What that reference resolves to. Must never reach a persisted bag. */
const BRACED_PLAINTEXT = 'hunter2-the-actual-database-password';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Strip JSDoc blocks and full-line `//` comments, so a fence scans CODE only. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

describe('the dynamic-reference token pattern agrees with the resolver (issue #1936)', () => {
  it('is byte-identical to the resolver’s own scan capture', () => {
    // The fence the issue asked for: assert the resolver's pattern and the
    // helpers' pattern are the SAME STRING, not merely that each looks right on
    // its own. Read out of the resolver's source because that module is the
    // AUTHORITY and does not export the pattern — a hand-copied literal here
    // would be a fourth spelling, which is the very thing being fenced.
    const resolverSource = readFileSync(
      `${REPO_ROOT}src/deployment/intrinsic-function-resolver.ts`,
      'utf8'
    );
    const authority = /\/\\\{\\\{resolve:\(([^)]+)\)\\\}\\\}\/g/.exec(resolverSource);
    expect(authority, 'resolveDynamicReferences’ scan pattern moved or changed shape').not.toBe(
      null
    );
    expect(authority![1]).toBe(DYNAMIC_REFERENCE_INNER);
  });

  it('builds the anchored whole-token pattern from that class', () => {
    // Assert the BUILT ARTIFACT rather than timing anything: this module's
    // skeleton patterns have documented catastrophic-backtracking sensitivity,
    // and a timing fence on a synchronous blowup wedges the worker instead of
    // failing.
    expect(WHOLE_DYNAMIC_REFERENCE_PATTERN.source).toBe('^\\{\\{resolve:[^}]+\\}\\}$');
    expect(WHOLE_DYNAMIC_REFERENCE_PATTERN.global).toBe(false);
  });

  it('accepts a reference whose inner text contains an opening brace', () => {
    expect(isSingleDynamicReferenceToken(BRACED_EXPRESSION)).toBe(true);
  });

  it('still refuses the shapes the strict spelling was thought to guard', () => {
    // The strict `[^{}]*` was believed to fence a concatenated or spliced
    // token. It bought nothing: an ANCHORED `[^}]+` cannot cross the first `}`
    // either, so these were already refused. Stated as assertions rather than
    // prose because the belief is what kept the disagreement alive.
    expect(isSingleDynamicReferenceToken('{{resolve:a}}{{resolve:b}}')).toBe(false);
    expect(isSingleDynamicReferenceToken('pre{{resolve:ssm:/public}}post')).toBe(false);
    expect(isSingleDynamicReferenceToken('{{resolve:}}')).toBe(false);
    expect(isSingleDynamicReferenceToken('not a reference at all')).toBe(false);
  });

  it('builds the token pattern in exactly two places, both in this module', () => {
    // ENUMERATING BAD SPELLINGS LOSES THE RACE. Three earlier revisions of this
    // fence each closed one more spelling (a bare class after `resolve:`, an
    // escaped colon, the resolver's capturing form) and a review immediately
    // probed a fourth that passed: re-duplicating the ASSEMBLED pattern,
    // `new RegExp(\`\\{\\{resolve:${'$'}{DYNAMIC_REFERENCE_INNER}\\}\\}\`, 'g')` —
    // verbatim the drift.ts line issue #2088 deleted. It is behaviourally
    // identical, so nothing else reds it, and it is the exact re-fork this
    // change exists to prevent. Two more were reported unclosed in the same
    // pass (a `.+?` class never opens with `[^`; an escaped colon inside a
    // CONSTRUCTOR string is `resolve\\:` with two backslashes, not one).
    //
    // So state the GOOD condition instead and all four collapse: a regex that
    // matches a `{{resolve:` token must escape both braces, in a literal
    // (`\{\{resolve`) or a constructor template (`\\{\\{resolve`), and this
    // module is the only place allowed to write one. A plain string test like
    // drift.ts's `value.includes('{{resolve:')` has no backslashes and is
    // deliberately NOT matched — those are substring checks, not patterns.
    const CONSTRUCTS_TOKEN_PATTERN = /\\+\{\\+\{resolve/g;
    // The RESOLVER is the authority every other spelling derives from, so it
    // owns one — found by this fence flagging it, which is the rule working:
    // an exempt-by-name list would have hidden a SECOND spelling appearing
    // there, and the resolver is precisely where that would matter most.
    const OWNERS: Record<string, number> = {
      'src/deployment/intrinsic-function-resolver.ts': 1,
      // WHOLE_DYNAMIC_REFERENCE_PATTERN and DYNAMIC_REFERENCE_TOKEN_SCAN.
      'src/deployment/secret-redaction.ts': 2,
    };

    for (const [relative, expected] of Object.entries(OWNERS)) {
      const sites = (
        stripComments(readFileSync(`${REPO_ROOT}${relative}`, 'utf8')).match(
          CONSTRUCTS_TOKEN_PATTERN
        ) ?? []
      ).length;
      // An EXACT count, not a floor: one more site in an owning file is a
      // re-fork inside the module, which is how the original four started.
      expect(sites, `${relative} must build the token pattern exactly ${expected}x`).toBe(expected);
    }

    // Every OTHER consumer must import, never rebuild. Scanning the tree rather
    // than a hand-listed pair closes the last gap the review named: a brand-new
    // consumer file re-spelling the pattern was unfenced.
    const others = readdirSync(`${REPO_ROOT}src`, { recursive: true, encoding: 'utf8' })
      .filter((entry: string) => entry.endsWith('.ts'))
      .map((entry: string) => `src/${entry.split(sep).join('/')}`)
      .filter((relative: string) => !(relative in OWNERS));
    expect(others.length, 'the source glob matched nothing — the fence would pass vacuously')
      .toBeGreaterThan(50);
    for (const relative of others) {
      const code = stripComments(readFileSync(`${REPO_ROOT}${relative}`, 'utf8'));
      expect(
        code.match(CONSTRUCTS_TOKEN_PATTERN) ?? [],
        `${relative} rebuilds the token pattern — import dynamicReferenceTokens / ` +
          'isSingleDynamicReferenceToken from secret-redaction.ts instead'
      ).toHaveLength(0);
    }
  });

  it('keeps the shared scan GLOBAL, so a multi-token leaf yields every token', () => {
    // The `g` flag became shared mutable state when the constant was hoisted,
    // and the JSDoc one screen up reasons about "a later flag change" while
    // fencing nothing. Its sibling WHOLE_DYNAMIC_REFERENCE_PATTERN pins
    // `.global === false`; this is the missing other half.
    expect(DYNAMIC_REFERENCE_TOKEN_SCAN.global).toBe(true);

    // The BEHAVIOURAL half, at the unit that owns the property. Drop `g` and
    // `.match` silently returns first-match-only, so drift.ts's survivor
    // report would name only the FIRST token of a leaf and the
    // `unresolvedToken` cause would go unrecorded for a second one. Fenced
    // HERE rather than through drift, where the report's join of the tokens
    // is one string and the case could not tell one token from two.
    const publicFirst = '{{resolve:ssm:/app/stage}}-{{resolve:notaservice:/db/pw}}';
    expect(dynamicReferenceTokens(publicFirst)).toEqual([
      '{{resolve:ssm:/app/stage}}',
      '{{resolve:notaservice:/db/pw}}',
    ]);
  });
});

describe('a braced reference is not persisted as plaintext (issue #1936)', () => {
  it('takes the source expression on cdkd scrub’s empty-map walk', () => {
    // `cdkd scrub`'s reason for existing: a record written by a pre-GHSA binary
    // holds PLAINTEXT in both bags, and scrub has no secrets map at all (it
    // never resolved this leaf), so the value scan has no needles and POSITION
    // is the only mechanism left. Faithful to the real call — `sourceProperties`
    // is today's template and the observed walk takes the cross-generation
    // rules, because scrub repositions `properties` first.
    const record = {
      physicalId: 'db-1',
      resourceType: 'AWS::RDS::DBInstance',
      properties: { MasterUserPassword: BRACED_PLAINTEXT },
      observedProperties: { MasterUserPassword: BRACED_PLAINTEXT },
    };
    const template = { MasterUserPassword: BRACED_EXPRESSION };

    const scrubbed = scrubResourceRecord(
      record,
      new Map() as RecordedSecretValues,
      template,
      STATE_SOURCED_CROSS_GENERATION_RULES
    );

    // The DISCRIMINATOR is which STRING each bag ends up holding — "redaction
    // happened" is not enough, because the broken path leaves the plaintext in
    // place while every other key is untouched either way.
    expect(scrubbed.properties['MasterUserPassword']).toBe(BRACED_EXPRESSION);
    expect(scrubbed.observedProperties?.['MasterUserPassword']).toBe(BRACED_EXPRESSION);
    expect(JSON.stringify(scrubbed)).not.toContain(BRACED_PLAINTEXT);
  });

  it('takes the source expression on the cross-generation observed walk directly', () => {
    // The same refusal one layer down, reached without `scrubResourceRecord`, so
    // a mutation inside `redactByPath`'s token arm is pinned on its own.
    // `STATE_SOURCED_CROSS_GENERATION_RULES` is deliberately the rules constant
    // here: `isReadbackProjectedFromState` excludes it, so
    // `refuseUncertifiedReadbackPositions` does NOT run and cannot supply the
    // right answer for the wrong reason.
    const redacted = redactSecretsForState(
      { Password: BRACED_PLAINTEXT },
      new Map() as RecordedSecretValues,
      { Password: BRACED_EXPRESSION },
      STATE_SOURCED_CROSS_GENERATION_RULES
    );

    expect(redacted).toEqual({ Password: BRACED_EXPRESSION });
  });
});

describe('drift.ts reads the same predicate (issue #1936)', () => {
  it('preserves the live value at a braced look-alike token', () => {
    // `preserveLiveValuesAtUnresolvedTokens` gates on the whole-token predicate,
    // and its failure mode is the mirror image of the persist one: the strict
    // spelling made a braced token "not whole", so `--revert` pushed the LITERAL
    // `{{resolve:...}}` string over whatever AWS holds at that position (a
    // CFn-migrated record, or an out-of-band edit). The token is a spelling
    // cdkd resolves for nobody: since issue #2482 `ssm-secure` resolves and
    // never reaches this pass.
    const token = '{{resolve:notaservice:/db/pw{v}}';
    // ANCHOR the fixture's SHAPE, same as its twin below. This token only
    // discriminates the two spellings while its `{` stays UNBALANCED: a
    // "typo fix" to `pw{v}` (balanced) or `pwv` (brace-free) would leave this
    // case green under the strict-class mutation and silently void the fence.
    expect(/^\{\{resolve:[^}]+\}\}$/.test(token), 'braced: the resolver matches').toBe(true);
    expect(/^\{\{resolve:[^{}]*\}\}$/.test(token), 'braced: the old class does NOT').toBe(false);
    const live = 'the-live-value-at-that-position';

    const send = preserveLiveValuesAtUnresolvedTokens(
      { MasterUserPassword: token },
      { MasterUserPassword: live }
    );

    expect(send['MasterUserPassword']).toBe(live);
  });
});

describe('a braced PUBLIC reference keeps its resolved value (issue #2088)', () => {
  it('KEEPS a resolved public ssm value in a braced MIXED leaf when a map exists', () => {
    // The third user-visible delta of issue #1936, and the one the review of
    // its PR found had no behavioural fence at all (issue #2088).
    //
    // Widening `dynamicReferenceTokens` makes a BRACED `{{resolve:ssm:` token
    // inside a MIXED leaf visible to `mixedLeafMayCarryPublicReference`, so on
    // a POPULATED map that leaf is now classified by the ordinary #1901 rule
    // instead of being invisible and unconditionally refused back to the source
    // expression. That is a plaintext-RETENTION direction change, so it needs a
    // case of its own rather than riding the source-grep fence: nothing else
    // stops a future edit silently reverting it.
    //
    // It is CORRECT to keep the value, and the populated map is why: a pass
    // resolved this bag, and `isRecordedSecretExpression` only ever says "yes"
    // about a token some pass proved secret — so absence from the verdict store
    // is real evidence the parameter is a PUBLIC `String`, which #1901 stores
    // RESOLVED. On an EMPTY map that inference is unavailable and the leaf fails
    // closed; the `secrets.size === 0` guard is what separates the two, and the
    // `secrets-dynamic-ref` integ is what forced that split.
    const PUBLIC_TOKEN = '{{resolve:ssm:/app/env/{stage}}';
    // The fixture is only a fence while it is the shape the two spellings
    // DISAGREE about (issue #2088 review). A later "typo fix" to a balanced
    // `.../{stage}}}` or a brace-free name would leave this case green under
    // the mutation and silently void it, so pin the property rather than
    // trusting the literal.
    expect(/^\{\{resolve:[^}]+\}\}$/.test(PUBLIC_TOKEN), 'braced: the resolver matches').toBe(
      true
    );
    expect(/^\{\{resolve:[^{}]*\}\}$/.test(PUBLIC_TOKEN), 'braced: the old class does NOT').toBe(
      false
    );
    const PUBLIC_VALUE = 'production';
    const secrets = new Map([[BRACED_PLAINTEXT, BRACED_EXPRESSION]]) as RecordedSecretValues;

    // A MIXED leaf: surrounding text plus the braced PUBLIC token. Nothing here
    // is a recorded secret, so the value scan has no needle for it either.
    const bag = { ConnectionString: `postgres://app@host/${PUBLIC_VALUE}` };
    const source = { ConnectionString: `postgres://app@host/${PUBLIC_TOKEN}` };

    const out = redactSecretsForState(bag, secrets, source, STATE_SOURCED_READBACK_RULES);

    // The DISCRIMINATOR is which string survives. Under the pre-#1936 strict
    // class the braced token was invisible, the leaf could not be classified
    // public, and the refusal rewrote it to the SOURCE expression — so asserting
    // "no plaintext leaked" would pass either way and fence nothing.
    expect(out['ConnectionString']).toBe(`postgres://app@host/${PUBLIC_VALUE}`);
    expect(out['ConnectionString']).not.toBe(source['ConnectionString']);
  });
});
