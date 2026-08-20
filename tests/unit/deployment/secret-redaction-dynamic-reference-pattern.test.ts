import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { preserveLiveValuesAtUnresolvedTokens } from '../../../src/cli/commands/drift.js';
import {
  DYNAMIC_REFERENCE_INNER,
  isSingleDynamicReferenceToken,
  redactSecretsForState,
  scrubResourceRecord,
  STATE_SOURCED_CROSS_GENERATION_RULES,
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

  it('carries no second inline spelling of the class in either consumer', () => {
    // "So a fourth spelling cannot be added without noticing." Both files build
    // every pattern from the shared constant now, so a bare character class
    // straight after `resolve:` is by construction a new spelling.
    for (const relative of ['src/deployment/secret-redaction.ts', 'src/cli/commands/drift.ts']) {
      const code = stripComments(readFileSync(`${REPO_ROOT}${relative}`, 'utf8'));
      expect(code, `${relative} spells the token class inline`).not.toMatch(/resolve:\[\^/);
    }
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
  it('preserves the live value at a braced ssm-secure token and registers it', () => {
    // `preserveLiveValuesAtUnresolvedTokens` gates on the whole-token predicate,
    // and its failure mode is the mirror image of the persist one: the strict
    // spelling made a braced token "not whole", so `--revert` pushed the LITERAL
    // `{{resolve:...}}` string over the working secret AWS holds (a CFn-migrated
    // record holds the token in state while AWS holds the plaintext), and the
    // moved value was registered with nothing that masks.
    const token = '{{resolve:ssm-secure:/db/pw{v}}';
    const live = 'the-live-secure-parameter-value';
    const secrets: RecordedSecretValues = new Map();

    const send = preserveLiveValuesAtUnresolvedTokens(
      { MasterUserPassword: token },
      { MasterUserPassword: live },
      secrets
    );

    expect(send['MasterUserPassword']).toBe(live);
    // Registration is the half that is easy to lose: moving plaintext into a bag
    // without telling the maskers is its own defect class.
    expect(secrets.get(live)).toBe(token);
  });
});
