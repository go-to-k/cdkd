import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  clearRecordedSecretExpressions,
  STATE_SOURCED_BASELINE_RULES,
  SECRET_MASK,
} from '../../../src/deployment/secret-redaction.js';

const EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';
const PLAINTEXT = 'the-real-resolved-secret-value';
const LITERAL = 'an-unrelated-literal';

/**
 * ANCHOR PAIRING — issue [#2012](https://github.com/go-to-k/cdkd/issues/2012).
 *
 * The readback paths run with an EMPTY secrets map by construction (nothing was
 * resolved), so the value scan has no needle and POSITION is the only mechanism
 * left. Where `identityKeyFor` finds no identity field there was no position
 * either, and the plaintext was persisted. The pass under test pairs two
 * containers anyway — but only when the positions THEMSELVES corroborate the
 * alignment: matching key sets / index counts, and every position the source
 * does not spell as a reference deep-equal on both sides, at least one of them
 * distinguishing.
 *
 * The bar it has to clear is the one that killed the first attempt (taking the
 * SOURCE subtree whenever the bag could not be vouched for): **redaction may
 * not buy itself a fabricated baseline.** `cdkd drift --revert` pushes the
 * baseline to AWS, so a false redaction or an invented field is applied to the
 * live resource.
 *
 * Every case below is one row of the formulation's table, in BOTH polarities —
 * the two rows that CLOSE and the two that must still REFUSE. The refusals are
 * the load-bearing half: a refusal is a negative behaviour that is trivially
 * green for the wrong reason, so each is written so that removing the anchor
 * gate makes it fail, and that was measured rather than assumed.
 *
 * WHAT A REFUSAL PERSISTS CHANGED WITH ISSUE
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852), and every refusal case
 * below asserts the new answer. A refused position used to keep the BAG — the
 * decrypted readback — so "the anchors do not corroborate this pairing" and
 * "this plaintext is safe to write to `state.json`" were the same output. The
 * pairing verdict is untouched; the refused subtree now has every string leaf
 * the SOURCE does not itself spell replaced by {@link SECRET_MASK}. So each
 * case here still pins its own gate (delete the gate and the leaf takes EXPR
 * instead of the mask), and the two properties are asserted separately: the
 * mask is the refusal, and `not.toBe(EXPR)` is the no-fabricated-baseline bar
 * the first attempt failed.
 */
describe('secret-redaction - anchor pairing (issue #2012)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  /** The readback configuration the four rows are reached under. */
  const readback = (bag: unknown, source: unknown): Record<string, unknown> =>
    redactSecretsForState(
      bag,
      new Map<string, string>(),
      source,
      STATE_SOURCED_BASELINE_RULES
    ) as Record<string, unknown>;

  // ---------------------------------------------------------------- CLOSES --

  it('ROW 1 CLOSES: a keyless string array pairs when its literal elements anchor it', () => {
    // `['--pw', <expr>, '--verbose']`. No element is an object, so there is no
    // identity field to key on and this array was refused outright. The two
    // literal elements are positions AWS did not rewrite, so their equality is
    // evidence the two lists describe the same argv.
    const out = readback(
      { Command: ['--pw', PLAINTEXT, '--verbose'] },
      { Command: ['--pw', EXPR, '--verbose'] }
    );

    expect(out['Command']).toEqual(['--pw', EXPR, '--verbose']);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('ROW 2 CLOSES: an element with no Name/Key identity pairs on its own literal field', () => {
    // `[{Field:'pw', Val:<expr>}]`. `Field` is not in ARRAY_IDENTITY_KEYS and is
    // not being added to it — it anchors the POSITIONAL pairing instead, which
    // is a different mechanism with a different failure mode (a wrong anchor
    // refuses; a wrong identity key would mis-assign).
    const out = readback(
      { Fields: [{ Field: 'pw', Val: PLAINTEXT }] },
      { Fields: [{ Field: 'pw', Val: EXPR }] }
    );

    expect(out['Fields']).toEqual([{ Field: 'pw', Val: EXPR }]);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('closes ROW 2 through scrubResourceRecord, the call the commands actually make', () => {
    // The rules are DERIVED here rather than passed — `cdkd state
    // refresh-observed` and the deploy persist choke point both arrive this
    // way — so the direct call above does not prove this one.
    const scrubbed = scrubResourceRecord(
      {
        properties: { Fields: [{ Field: 'pw', Val: EXPR }] },
        observedProperties: { Fields: [{ Field: 'pw', Val: PLAINTEXT }] },
      },
      new Map<string, string>()
    );

    expect(scrubbed.observedProperties!['Fields']).toEqual([{ Field: 'pw', Val: EXPR }]);
    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
  });

  it('anchors on VALUE, not on serialized key order', () => {
    // `deepEqualJsonValue` rather than a `JSON.stringify` comparison. An AWS
    // readback reorders object keys freely and that says nothing about the
    // values, so a stringify-based anchor would refuse this pairing and the row
    // would close only for readbacks that happened to preserve key order.
    //
    // The anchor is a CONTAINER here, which also pins the other half of
    // `isDistinguishingAnchor`: an object counts when something INSIDE it does,
    // so a nested literal can anchor a pairing its own level cannot.
    const out = readback(
      { Fields: [{ Meta: { tier: 'std', region: 'us-east-1' }, Val: PLAINTEXT }] },
      { Fields: [{ Meta: { region: 'us-east-1', tier: 'std' }, Val: EXPR }] }
    );

    expect((out['Fields'] as Array<Record<string, unknown>>)[0]!['Val']).toBe(EXPR);
  });

  // --------------------------------------------------------------- REFUSES --

  it('ROW 3 REFUSES: a DIFFERING anchor rejects the pairing', () => {
    // The counterexample that killed the first attempt, measured then as
    // `{Name:'', Value:'an-unrelated-literal'}` rewritten to `Value: <expr>`.
    // The names differ, so the two elements are demonstrably NOT the same entry
    // and the literal must survive untouched.
    //
    // The assertion names the specific WRONG answer as well as the right one:
    // "not EXPR" is what a pairing without the anchor check produces.
    const out = readback(
      { Entries: [{ Name: '', Value: LITERAL }] },
      { Entries: [{ Name: 'db', Value: EXPR }] }
    );

    const entries = out['Entries'] as Array<Record<string, unknown>>;
    // MASKED, not LITERAL (issue #2852): the names differ, so nothing here can
    // say whether `an-unrelated-literal` is an unrelated literal or the
    // resolved secret, and the old answer persisted it either way. `Name: ''`
    // survives because the bag's own value is spelled in the source subtree.
    expect(entries[0]!['Value']).toBe(SECRET_MASK);
    expect(entries[0]!['Value']).not.toBe(EXPR);
    // `Name: ''` survives even though the source spells `'db'` here: `''` is
    // not a value any resolved secret can take — the resolver records none, and
    // the value scan excludes it as a needle for the same reason — so masking it
    // would cost drift a comparison and buy nothing (issue #2852 round 2).
    expect(entries[0]!['Name']).toBe('');
  });

  it('ROW 4 REFUSES: differing KEY SETS reject the pairing', () => {
    // The second counterexample: an AWS-reported `[{Value:'x'}]` became
    // `[{Name:'db', Value:<expr>}]` — a field AWS never reported, which
    // `--revert` then writes to the live resource.
    //
    const out = readback(
      { Entries: [{ Value: 'x' }] },
      { Entries: [{ Name: 'db', Value: EXPR }] }
    );

    // Only the leaf's VERDICT is asserted — the mask since issue #2852, where
    // this line read `.toBe('x')` before. `Object.hasOwn(entries[0], 'Name')`
    // was here too and was UNFALSIFIABLE: the walk maps over the BAG's keys, so
    // a source-only key cannot appear whatever the pairing decides. The
    // no-fabrication property is structural rather than per-case (see the
    // `anchorsCorroboratePairing` doc), and an assertion that cannot fail is
    // worse than no assertion, because it reads as coverage.
    expect((out['Entries'] as Array<Record<string, unknown>>)[0]!['Value']).toBe(SECRET_MASK);
  });

  it('ROW 4 REFUSES on the KEY SETS even when a sibling anchor corroborates', () => {
    // The row above as the issue writes it, and it is over-fenced: with `Name`
    // absent from the bag NOTHING is left to anchor the element, so it refuses
    // on the "at least one distinguishing anchor" rule and would refuse with
    // condition (a) deleted. Measured — a probe removing the key-set match left
    // it green, which is a case passing for the wrong reason.
    //
    // `Kind` supplies the anchor the shape was missing, so the per-element
    // evidence rule is satisfied and the differing key sets are what refuses.
    //
    // The mutation that reds this is precise, and an earlier version of this
    // comment named the wrong one. Deleting the key-COUNT check alone leaves it
    // green: `sourceKeys.every` still visits `Name`, `Object.hasOwn(bag,'Name')`
    // is false, and the walk refuses there instead. It goes red once a missing
    // bag key is SKIPPED rather than refused -- the shape a "be lenient about
    // keys AWS omits" edit produces -- at which point only `Kind` and `Value`
    // are consulted, the pairing is licensed, and this element takes
    // `Value: <expr>`: the false redaction that killed the first attempt.
    const out = readback(
      { Entries: [{ Kind: 'entry', Value: 'x' }] },
      { Entries: [{ Kind: 'entry', Name: 'db', Value: EXPR }] }
    );

    const entries = out['Entries'] as Array<Record<string, unknown>>;
    expect(entries[0]!['Value']).toBe(SECRET_MASK);
    expect(entries[0]!['Value']).not.toBe(EXPR);
    expect(Object.hasOwn(entries[0]!, 'Name')).toBe(false);
    // `Kind` is spelled by the source, so the refusal keeps it — the mask is
    // scoped to what the source cannot account for, not to the element.
    expect(entries[0]!['Kind']).toBe('entry');
  });

  it('REFUSES a pairing whose only matching anchor is NON-DISTINGUISHING', () => {
    // The refinement the formulation on the issue does not state, and the tree
    // needs. Its own counterexample has DIFFERING names, so inequality refuses
    // it; the fence actually in `secret-redaction-array-identity.test.ts`
    // carries `Name: ''` on BOTH sides, where equality holds. An empty string
    // is not evidence — it is the same reason `isUniquelyKeyedBy` excludes it
    // as an identity and the value scan excludes it as a needle — so it must
    // not buy a pairing on its own.
    const out = readback(
      { Entries: [{ Name: '', Value: LITERAL }] },
      { Entries: [{ Name: '', Value: EXPR }] }
    );

    const entry = (out['Entries'] as Array<Record<string, unknown>>)[0]!;
    expect(entry['Value']).toBe(SECRET_MASK);
    expect(entry['Value']).not.toBe(EXPR);
  });

  it('REFUSES a pairing anchored only by a NON-STRING equal field', () => {
    // The same refinement on its other shape. A boolean or a small integer has
    // so few inhabitants that equality is nearly free, so `{Ordinal: 1, ...}`
    // agrees on both sides whether or not the two are the same entry. This is
    // the bar `isUniquelyKeyedBy` already applies to an identity field
    // (`typeof id !== 'string'` refuses), restated for anchors.
    const out = readback(
      { Entries: [{ Ordinal: 1, Enabled: true, Value: LITERAL }] },
      { Entries: [{ Ordinal: 1, Enabled: true, Value: EXPR }] }
    );

    const entry = (out['Entries'] as Array<Record<string, unknown>>)[0]!;
    expect(entry['Value']).toBe(SECRET_MASK);
    expect(entry['Value']).not.toBe(EXPR);
    // The non-string anchors are NOT masked: a number and a boolean cannot be a
    // resolved secret, so the refusal leaves them alone (issue #2852).
    expect(entry['Ordinal']).toBe(1);
    expect(entry['Enabled']).toBe(true);
  });

  it('REFUSES once the list is REORDERED, which is what makes anchors evidence', () => {
    // `descendArrays: false` exists because AWS does not preserve list order,
    // and anchor pairing answers that objection rather than waiving it: a
    // reorder puts a different element under each index, so the anchors stop
    // matching and the whole array is refused. Without this the pass would be
    // blind positional descent with extra steps.
    //
    // Same fixture as ROW 1, only reordered — so the two cases differ in
    // exactly the property under test.
    const out = readback(
      { Command: ['--verbose', PLAINTEXT, '--pw'] },
      { Command: ['--pw', EXPR, '--verbose'] }
    );

    // The flags survive (spelled by the source); only the leaf the source
    // cannot account for is masked (issue #2852).
    expect(out['Command']).toEqual(['--verbose', SECRET_MASK, '--pw']);
  });

  it('REFUSES once AWS NORMALISES a sibling field, which is the stated yield cost', () => {
    // The honest bound: one normalised sibling in the same container drops the
    // yield to zero. Pinned so the cost is a measured property rather than a
    // claim in a comment, and so a future widening has to face it.
    const out = readback(
      { Fields: [{ Field: 'pw', Mode: 'ENABLED', Val: PLAINTEXT }] },
      { Fields: [{ Field: 'pw', Mode: 'enabled', Val: EXPR }] }
    );

    const field = (out['Fields'] as Array<Record<string, unknown>>)[0]!;
    expect(field['Val']).toBe(SECRET_MASK);
    expect(field['Val']).not.toBe(EXPR);
    // AWS's normalised `Mode` is masked WITH it — the stated over-masking cost
    // of issue #2852: once the pairing is refused nothing tells a normalised
    // literal from a resolved secret. `Field` matches the source and survives.
    expect(field['Field']).toBe('pw');
    expect(field['Mode']).toBe(SECRET_MASK);
  });

  it('refuses the WHOLE pairing when a reference position meets a CONTAINER', () => {
    // A source leaf spelled as a reference against an OBJECT in the bag is a
    // type divergence, and the caller already declines to write a scalar over a
    // container there — so a single-element fixture proves nothing about this
    // rule: it passes with the corroboration guard deleted, because the
    // caller's own guard catches it one level down. Measured, then rewritten.
    //
    // TWO elements make it observable. AWS reported a fundamentally different
    // TYPE at `a`, which is evidence these two lists are not aligned, so the
    // whole array is refused and `b` keeps its plaintext as well. Without the
    // guard the array pairs and `b` is substituted — more redaction, on an
    // alignment the module has just been shown a counterexample to.
    const mixed = `postgres://u:${EXPR}@h`;
    const out = readback(
      {
        Fields: [
          { Field: 'a', Val: { nested: 'structure' } },
          { Field: 'b', Val: `postgres://u:${PLAINTEXT}@h` },
        ],
      },
      {
        Fields: [
          { Field: 'a', Val: EXPR },
          { Field: 'b', Val: mixed },
        ],
      }
    );

    const fields = out['Fields'] as Array<Record<string, unknown>>;
    // Still a CONTAINER — no scalar written over it — with its string leaf
    // masked, and `b`'s mixed leaf masked rather than persisted in plaintext
    // (issue #2852). `Field` survives on both, the source spelling it.
    expect(fields[0]!['Val']).toEqual({ nested: SECRET_MASK });
    expect(fields[1]!['Val']).toBe(SECRET_MASK);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('adds no element when the bag is SHORTER than the source', () => {
    // Index counts are half of condition (a). A source element with no bag
    // counterpart is not appended: `--revert` would then write an argument AWS
    // never reported onto the live resource.
    const out = readback({ Command: ['--pw', PLAINTEXT] }, { Command: ['--pw', EXPR, '--verbose'] });

    // Two elements still, never three: the refusal adds nothing (issue #2852
    // masks, it does not rebuild from the source).
    expect(out['Command']).toEqual(['--pw', SECRET_MASK]);
  });
});

/**
 * The REVIEW round on the anchor pass (issue #2012), which found the first cut
 * unsound in two INDEPENDENT ways and one predicate short.
 *
 * The counter was scoped per ARRAY, so one element's distinguishing anchor
 * licensed a sibling that had none; and the projection carried no UNIQUENESS
 * requirement, so two elements the anchors describe identically could be
 * swapped by AWS without the swap being visible. `isUniquelyKeyedBy` -- the bar
 * the pass claims to match -- demands the identity be non-empty AND unique
 * across elements, and the first cut kept only the first half.
 *
 * Every case here is a MEASURED failure of that cut, not a hypothetical, and
 * each is written so exactly one half of the fix reds it.
 */
describe('secret-redaction - anchor pairing, per-element evidence (issue #2012 review)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
  const EXPR_B = '{{resolve:secretsmanager:app/b:SecretString:pw}}';
  const PLAIN_A = 'resolved-value-of-a';
  const PLAIN_B = 'resolved-value-of-b';

  const readback = (bag: unknown, source: unknown): Record<string, unknown> =>
    redactSecretsForState(
      bag,
      new Map<string, string>(),
      source,
      STATE_SOURCED_BASELINE_RULES
    ) as Record<string, unknown>;

  // ------------------------------------------- (a) DUPLICATE ANCHORS + REORDER

  it('REFUSES a repeated-flag argv whose two secret slots AWS returned swapped', () => {
    // Repeated literal flags are the SAME shape ROW 1 closes, so this is not an
    // exotic variant of it. Both anchors are `--pw`, so they match at every
    // index whichever way the two values sit -- and the first cut therefore
    // pinned index 1 to A and index 3 to B while AWS was holding them the other
    // way round, writing each secret's reference at the OTHER secret's
    // position. `cdkd drift --revert` pushes that.
    //
    // The assertion names both wrong answers, because a half-fix produces one
    // of them: nothing may be substituted at all here.
    const out = readback(
      { Command: ['--pw', PLAIN_B, '--pw', PLAIN_A] },
      { Command: ['--pw', EXPR_A, '--pw', EXPR_B] }
    );

    // Neither reference is substituted — the property this case exists for —
    // and since issue #2852 neither plaintext is PERSISTED either. This shape is
    // the worst of the old fail-open rows: both refused slots held a real
    // secret.
    expect(out['Command']).toEqual(['--pw', SECRET_MASK, '--pw', SECRET_MASK]);
    expect(out['Command']).not.toEqual(['--pw', EXPR_A, '--pw', EXPR_B]);
    expect(JSON.stringify(out)).not.toContain(PLAIN_A);
    expect(JSON.stringify(out)).not.toContain(PLAIN_B);
  });

  it('REFUSES the same repeated-flag argv when AWS returned the values IN ORDER', () => {
    // The `secrets-array-nested` integ's negative control, pinned at unit
    // cost (its real-AWS arm is a 63 s run): same-order agreement is not
    // evidence when the two slots are indistinguishable — a swap would have
    // produced the same anchors — so rule 3 refuses whichever order the
    // readback arrived in, and since issue #2852 the refused positions
    // persist the MASK. All three wrong outcomes stay distinguishable: the
    // raw plaintext is the retired pre-#2852 residual, and the EXPRESSIONS
    // are a pair-everything mutation (the swap / fabrication class).
    const out = readback(
      { Command: ['--pw', PLAIN_A, '--pw', PLAIN_B] },
      { Command: ['--pw', EXPR_A, '--pw', EXPR_B] }
    );

    expect(out['Command']).toEqual(['--pw', SECRET_MASK, '--pw', SECRET_MASK]);
    expect(out['Command']).not.toEqual(['--pw', EXPR_A, '--pw', EXPR_B]);
    expect(JSON.stringify(out)).not.toContain(PLAIN_A);
    expect(JSON.stringify(out)).not.toContain(PLAIN_B);
  });

  it('REFUSES two OBJECT elements the anchors describe identically', () => {
    // The same defect one level in. `Field: 'pw'` is a perfectly good anchor for
    // ONE element and says nothing at all about which of two identical-looking
    // elements is which, so the array admits a swap that preserves every anchor.
    const out = readback(
      { Fields: [{ Field: 'pw', Val: PLAIN_B }, { Field: 'pw', Val: PLAIN_A }] },
      { Fields: [{ Field: 'pw', Val: EXPR_A }, { Field: 'pw', Val: EXPR_B }] }
    );

    expect(out['Fields']).toEqual([
      { Field: 'pw', Val: SECRET_MASK },
      { Field: 'pw', Val: SECRET_MASK },
    ]);
    expect(JSON.stringify(out)).not.toContain(PLAIN_A);
    expect(JSON.stringify(out)).not.toContain(PLAIN_B);
  });

  it('REFUSES the AmazonMQ Users shape, where every element carries Groups:[admin]', () => {
    // The review's own realistic case, and the reason `isDistinguishingAnchor`
    // is not sufficient by itself. `AWS::AmazonMQ::Broker.Users` has no
    // `Name`/`Key`; CDK renders both `Username` and `Password` through
    // `secretValueFromJson`; and `Groups: ['admin']` is EQUAL on both elements
    // while being distinguishing by that predicate, since it recurses into
    // containers and finds a non-empty string.
    //
    // So a `DescribeBroker` that returns the two users in the other order would
    // have recorded the ADMIN credential's reference at the app user's
    // position. Nothing may be substituted.
    const ADMIN_USER = '{{resolve:secretsmanager:mq/admin:SecretString:username}}';
    const ADMIN_PW = '{{resolve:secretsmanager:mq/admin:SecretString:password}}';
    const APP_USER = '{{resolve:secretsmanager:mq/app:SecretString:username}}';
    const APP_PW = '{{resolve:secretsmanager:mq/app:SecretString:password}}';

    const out = readback(
      {
        Users: [
          { Username: 'app-svc', Password: 'app-plaintext-pw', Groups: ['admin'] },
          { Username: 'mq-admin', Password: 'admin-plaintext-pw', Groups: ['admin'] },
        ],
      },
      {
        Users: [
          { Username: ADMIN_USER, Password: ADMIN_PW, Groups: ['admin'] },
          { Username: APP_USER, Password: APP_PW, Groups: ['admin'] },
        ],
      }
    );

    const users = out['Users'] as Array<Record<string, unknown>>;
    // No reference is substituted, and since issue #2852 the two BROKER
    // passwords are not persisted either — the refusal that used to leave both
    // in `state.json` now masks them. `Groups: ['admin']` matches the source and
    // survives.
    expect(users[0]!['Password']).toBe(SECRET_MASK);
    expect(users[0]!['Password']).not.toBe(ADMIN_PW);
    expect(users[1]!['Password']).toBe(SECRET_MASK);
    expect(users[0]!['Groups']).toEqual(['admin']);
  });

  it('CLOSES the same AmazonMQ shape once the two users are distinguishable', () => {
    // The polarity that keeps the refusal above from being "arrays of objects
    // never pair". One `Groups` entry differs, so the anchors DO tell the two
    // users apart, each element carries its own distinguishing anchor, and the
    // pairing is evidence. This is also the FIXTURE-REALISM case: it carries
    // AWS-shaped siblings (`ConsoleAccess`, `ReplicationUser`) that the
    // hand-minimal fixtures elsewhere in this file do not.
    const ADMIN_PW = '{{resolve:secretsmanager:mq/admin:SecretString:password}}';
    const APP_PW = '{{resolve:secretsmanager:mq/app:SecretString:password}}';

    const out = readback(
      {
        Users: [
          {
            Username: 'mq-admin',
            Password: 'admin-plaintext-pw',
            Groups: ['admin'],
            ConsoleAccess: true,
            ReplicationUser: false,
          },
          {
            Username: 'app-svc',
            Password: 'app-plaintext-pw',
            Groups: ['app'],
            ConsoleAccess: false,
            ReplicationUser: false,
          },
        ],
      },
      {
        Users: [
          {
            Username: 'mq-admin',
            Password: ADMIN_PW,
            Groups: ['admin'],
            ConsoleAccess: true,
            ReplicationUser: false,
          },
          {
            Username: 'app-svc',
            Password: APP_PW,
            Groups: ['app'],
            ConsoleAccess: false,
            ReplicationUser: false,
          },
        ],
      }
    );

    const users = out['Users'] as Array<Record<string, unknown>>;
    expect(users[0]!['Password']).toBe(ADMIN_PW);
    expect(users[1]!['Password']).toBe(APP_PW);
    expect(JSON.stringify(out)).not.toContain('plaintext-pw');
  });

  it('REFUSES once AWS NORMALISES a sibling in the realistic shape', () => {
    // The yield cost, on the same realistic fixture rather than on a minimal
    // one: AWS echoes `Groups` upper-cased, the anchor stops matching, and the
    // whole array refuses. Stated as a measured property so a future widening
    // has to face it rather than discover it.
    const ADMIN_PW = '{{resolve:secretsmanager:mq/admin:SecretString:password}}';
    const APP_PW = '{{resolve:secretsmanager:mq/app:SecretString:password}}';

    const out = readback(
      {
        Users: [
          { Username: 'mq-admin', Password: 'admin-plaintext-pw', Groups: ['ADMIN'] },
          { Username: 'app-svc', Password: 'app-plaintext-pw', Groups: ['APP'] },
        ],
      },
      {
        Users: [
          { Username: 'mq-admin', Password: ADMIN_PW, Groups: ['admin'] },
          { Username: 'app-svc', Password: APP_PW, Groups: ['app'] },
        ],
      }
    );

    const users = out['Users'] as Array<Record<string, unknown>>;
    // Masked since issue #2852; the normalised `Groups` are masked with them,
    // which is the over-masking this file's header states. `Username` matches
    // the source on both elements and survives.
    expect(users[0]!['Password']).toBe(SECRET_MASK);
    expect(users[1]!['Password']).toBe(SECRET_MASK);
    expect(users[0]!['Username']).toBe('mq-admin');
    expect(users[1]!['Username']).toBe('app-svc');
  });

  // ------------------------------------- (b) A SIBLING'S EVIDENCE IS NOT YOURS

  it('REFUSES an element with no evidence beside one that has some', () => {
    // The array-wide counter saw `Name: 'db'` at index 0, concluded the array
    // had a distinguishing anchor, and licensed index 1 -- whose only anchor is
    // `Name: ''`, the exact value `isUniquelyKeyedBy` and the needle scan both
    // refuse as non-distinguishing. So an unrelated literal took `<exprB>`:
    // precisely the false redaction that killed the first attempt at these rows,
    // arriving through the counter's SCOPE rather than its definition.
    //
    // Both elements are asserted: the refusal is all-or-nothing for the array,
    // because an alignment that cannot be trusted for one element cannot be
    // trusted for its sibling either.
    const out = readback(
      {
        L: [
          { Name: 'db', Value: PLAIN_A },
          { Name: '', Value: LITERAL },
        ],
      },
      {
        L: [
          { Name: 'db', Value: EXPR_A },
          { Name: '', Value: EXPR_B },
        ],
      }
    );

    const list = out['L'] as Array<Record<string, unknown>>;
    expect(list[1]!['Value']).toBe(SECRET_MASK);
    expect(list[1]!['Value']).not.toBe(EXPR_B);
    // All-or-nothing still: index 0 is refused too, and refused now means
    // masked (issue #2852) rather than the plaintext it actually held.
    expect(list[0]!['Value']).toBe(SECRET_MASK);
    expect(list[0]!['Name']).toBe('db');
  });

  it('REFUSES a no-evidence sibling anchored only by a NUMBER', () => {
    // The same shape with `Id: 7` standing in for `Name: ''`. Both are equal on
    // both sides and neither is evidence, so the per-element rule has to reject
    // them for the same reason rather than for two special cases.
    const out = readback(
      {
        L: [
          { Name: 'db', Value: PLAIN_A },
          { Id: 7, Value: LITERAL },
        ],
      },
      {
        L: [
          { Name: 'db', Value: EXPR_A },
          { Id: 7, Value: EXPR_B },
        ],
      }
    );

    const l = out['L'] as Array<Record<string, unknown>>;
    expect(l[1]!['Value']).toBe(SECRET_MASK);
    expect(l[1]!['Value']).not.toBe(EXPR_B);
    // `Id: 7` is untouched — a number cannot be a resolved secret.
    expect(l[1]!['Id']).toBe(7);
  });

  it('REFUSES overwriting an out-of-band edit that a PURE-ANCHOR sibling would license', () => {
    // The simplest form both reviewers reached, and the one that separates a
    // CONTAINER from a bare reference leaf. Index 0 is a pure anchor
    // (`us-east-1`, distinguishing), so the array's FRAME is non-empty -- and
    // index 1 is still refused, because it is a container with somewhere to
    // carry an identity and carries none.
    //
    // What it protects: `someone-set-this-by-hand` is a genuine out-of-band
    // change. Overwriting it in the drift BASELINE makes `cdkd drift` report
    // clean and `--revert` never see it, which is a silent loss of the exact
    // signal drift exists to produce.
    const out = readback(
      { E: [{ V: 'us-east-1' }, { V: 'someone-set-this-by-hand' }] },
      { E: [{ V: 'us-east-1' }, { V: EXPR_A }] }
    );

    const e = out['E'] as Array<Record<string, unknown>>;
    // The out-of-band edit is not overwritten with EXPR_A — the property this
    // case protects. It is MASKED (issue #2852), which keeps drift reporting
    // the position rather than silently agreeing with AWS; the value cdkd
    // cannot account for is not what it writes back.
    expect(e[1]!['V']).toBe(SECRET_MASK);
    expect(e[1]!['V']).not.toBe(EXPR_A);
    expect(e[0]!['V']).toBe('us-east-1');
  });

  it('CLOSES a BARE reference leaf on the frame, which the case above must not', () => {
    // The polarity that makes the container/scalar distinction a rule rather
    // than a way to reject the previous fixture. ROW 1's argv leans on exactly
    // this: a bare reference has NO interior, so the absence of an internal
    // anchor says nothing about it and the literal frame is the only evidence
    // available -- whereas the container above had somewhere to carry one.
    const out = readback(
      { E: ['us-east-1', PLAIN_A] },
      { E: ['us-east-1', EXPR_A] }
    );

    expect(out['E']).toEqual(['us-east-1', EXPR_A]);
  });

  it('REFUSES a bare reference leaf when the frame carries no distinguishing anchor', () => {
    // ...and the frame has to be worth something. With the only pure-anchor
    // sibling a bare `0`, there is nothing that could tell this slot from
    // another, so the fallback the case above relies on is not available.
    const out = readback({ E: [0, PLAIN_A] }, { E: [0, EXPR_A] });

    expect(out['E']).toEqual([0, SECRET_MASK]);
    expect(JSON.stringify(out)).not.toContain(PLAIN_A);
  });

  // ------------------------------------------------- THE deepEqual DATE HOLE --

  it('REFUSES a pairing anchored by a Date, which compared equal to {} before', () => {
    // `isPlainObject` admits class instances and `Object.keys(new Date())` is
    // `[]`, so the key-count arm of `deepEqualJsonValue` reported a `Date` equal
    // to `{}` and to any other `Date`. This is REACHABLE rather than theoretical:
    // an AWS SDK v3 readback reaching `drainObservedCaptures` is pre-JSON and
    // carries real `Date` values (`LastModified`, `CreationDate`), while the
    // SOURCE comes from `state.json` and holds only JSON shapes.
    //
    // `Extra` supplies the distinguishing anchor, so the per-element rule is
    // satisfied and the `Date`-vs-`{}` comparison is the only thing deciding it.
    const out = readback(
      { Fields: [{ Meta: new Date('2020-01-01T00:00:00Z'), Extra: 'id', Val: PLAIN_A }] },
      { Fields: [{ Meta: {}, Extra: 'id', Val: EXPR_A }] }
    );

    const field = (out['Fields'] as Array<Record<string, unknown>>)[0]!;
    expect(field['Val']).toBe(SECRET_MASK);
    expect(field['Val']).not.toBe(EXPR_A);
    // The `Date` itself is returned BY IDENTITY, never rebuilt as `{}` — issue
    // #2869, whose flattening this walk's own object arm used to perform.
    expect(field['Meta']).toBeInstanceOf(Date);
    expect((field['Meta'] as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  // ----------------------------------------------- INDEX COUNTS, BOTH SIDES --

  it('REFUSES a bag LONGER than the source even when the prefix matches', () => {
    // The untested complement of the shorter-bag case. Deleting the index-count
    // check produced ZERO failures across the whole suite, because the walk maps
    // over the BAG and the shorter-bag fixture is fenced by a deep-equality
    // against `undefined` instead. Here the source is a strict PREFIX of the
    // bag, so every position the check would have visited corroborates and only
    // the count refuses -- an element AWS added being silently pair-walked.
    const out = readback(
      { Command: ['--pw', PLAIN_A, 'aws-added'] },
      { Command: ['--pw', EXPR_A] }
    );

    // Three elements still — the refusal adds and drops nothing. `--pw` is
    // spelled by the source and survives; the two the source cannot account for
    // are masked (issue #2852).
    expect(out['Command']).toEqual(['--pw', SECRET_MASK, SECRET_MASK]);
  });

  it('PAIRS a bag carrying an EXTRA key the source does not have (issue #2012)', () => {
    // Condition (a) relaxed from key-COUNT equality to CONTAINMENT, and this
    // assertion is flipped deliberately. It used to pin the row-6 residual
    // reached through the anchor arm: `Kind` supplies the per-element evidence,
    // so the count was the only thing refusing — and refusing cost the whole
    // element, leaving `Val`'s decrypted secret in the drift baseline.
    //
    // An extra BAG key buys an attacker nothing here, which is why the
    // relaxation is safe rather than merely convenient: the walk maps over the
    // BAG's keys and takes a source leaf only where `Object.hasOwn(source, k)`,
    // so `AwsAdded` can be neither overwritten nor invented. It is also not an
    // anchor (the anchors are the SOURCE's non-reference positions) and not
    // part of `anchorSignature` (computed on SOURCE elements), so neither
    // corroboration nor distinguishability moves.
    //
    // `AwsAdded` keeping its own value is asserted alongside, because that is
    // the half a fabricating fix would break.
    const out = readback(
      { Fields: [{ Kind: 'entry', Val: PLAIN_A, AwsAdded: 'x' }] },
      { Fields: [{ Kind: 'entry', Val: EXPR_A }] }
    );

    const fields = out['Fields'] as Array<Record<string, unknown>>;
    expect(fields[0]!['Val']).toBe(EXPR_A);
    expect(fields[0]!['AwsAdded']).toBe('x');
  });

  it('still REFUSES when a SOURCE key is missing from the bag, extra bag keys or not', () => {
    // The direction the relaxation above does NOT touch, stated as its own case
    // so a future edit cannot widen containment into "skip a missing key" and
    // still find the suite green. `Name` is in the source and absent from the
    // bag, so substituting would fabricate a field AWS never reported — the
    // false redaction that killed the first attempt at these rows — and the
    // extra `AwsAdded` must not buy the pairing back.
    const out = readback(
      { Fields: [{ Kind: 'entry', Val: PLAIN_A, AwsAdded: 'x' }] },
      { Fields: [{ Kind: 'entry', Name: 'db', Val: EXPR_A }] }
    );

    const fields = out['Fields'] as Array<Record<string, unknown>>;
    // Not EXPR_A — the fabrication this case forbids — and not the plaintext
    // either since issue #2852. `Name` is still never invented.
    expect(fields[0]!['Val']).toBe(SECRET_MASK);
    expect(fields[0]!['Val']).not.toBe(EXPR_A);
    expect(Object.hasOwn(fields[0]!, 'Name')).toBe(false);
    expect(fields[0]!['Kind']).toBe('entry');
  });

  it('PAIRS past a bag key explicitly set to undefined that the source lacks', () => {
    // The same relaxation reached through the shape that used to make the
    // key-COUNT check look indispensable: `JSON.stringify` DROPS an `undefined`
    // value, so `{Opt: undefined}` and `{}` serialize identically while their
    // key counts differ. That argument was about `deepEqualJsonValue`, which is
    // unchanged — an ANCHOR is still compared by it. `Opt` is not an anchor: it
    // has no source counterpart, so it is not a position the source speaks
    // about at all, and it is kept verbatim rather than compared.
    //
    // Flipped deliberately with its sibling above.
    const out = readback(
      { Fields: [{ Kind: 'entry', Val: PLAIN_A, Opt: undefined }] },
      { Fields: [{ Kind: 'entry', Val: EXPR_A }] }
    );

    const fields = out['Fields'] as Array<Record<string, unknown>>;
    expect(fields[0]!['Val']).toBe(EXPR_A);
    expect(Object.hasOwn(fields[0]!, 'Opt')).toBe(true);
  });

  // ------------------------------------------------------ UNTESTED SHAPES --

  it('REFUSES a pairing anchored only by null', () => {
    const out = readback(
      { L: [{ N: null, V: LITERAL }] },
      { L: [{ N: null, V: EXPR_A }] }
    );
    const entry = (out['L'] as Array<Record<string, unknown>>)[0]!;
    expect(entry['V']).toBe(SECRET_MASK);
    expect(entry['V']).not.toBe(EXPR_A);
    expect(entry['N']).toBeNull();
  });

  it('REFUSES a pairing anchored only by an EMPTY container', () => {
    // `isDistinguishingAnchor` recurses into containers, so an empty one has to
    // reach the same verdict as an empty string: nothing inside it distinguishes
    // anything.
    const out = readback(
      { L: [{ Meta: {}, Tags: [], V: LITERAL }] },
      { L: [{ Meta: {}, Tags: [], V: EXPR_A }] }
    );
    const entry = (out['L'] as Array<Record<string, unknown>>)[0]!;
    expect(entry['V']).toBe(SECRET_MASK);
    expect(entry['V']).not.toBe(EXPR_A);
    expect(entry['Meta']).toEqual({});
    expect(entry['Tags']).toEqual([]);
  });

  // ------------------------------------------- LIST ORDER INSIDE AN ANCHOR --

  it('REFUSES two elements whose anchors differ only by INNER LIST ORDER', () => {
    // Rule 3 asks whether AWS could hand back these two elements swapped
    // without the swap being visible, so it must quotient by everything AWS may
    // itself reorder -- and that includes the order WITHIN an anchor's list, for
    // exactly the reason `descendArrays: false` exists at the top level.
    //
    // Signing list order made the two `Groups` permutations look like different
    // content, so rule 3 passed; the anchors deep-equal position-wise, so rule 1
    // passed; both elements carry a distinguishing anchor, so rule 2 passed.
    // The outer list was nonetheless swapped, and user 1's ADMIN `Username` and
    // `Password` expressions landed at the app user's index -- the misattribution
    // the uniqueness rule exists to prevent, restored through a different door.
    const ADMIN_USER = '{{resolve:secretsmanager:mq/admin:SecretString:username}}';
    const ADMIN_PW = '{{resolve:secretsmanager:mq/admin:SecretString:password}}';
    const APP_USER = '{{resolve:secretsmanager:mq/app:SecretString:username}}';
    const APP_PW = '{{resolve:secretsmanager:mq/app:SecretString:password}}';

    const out = readback(
      {
        Users: [
          { Username: 'u2-appuser', Password: 'plain-B', Groups: ['admin', 'ops'] },
          { Username: 'u1-admin', Password: 'plain-A', Groups: ['ops', 'admin'] },
        ],
      },
      {
        Users: [
          { Username: ADMIN_USER, Password: ADMIN_PW, Groups: ['admin', 'ops'] },
          { Username: APP_USER, Password: APP_PW, Groups: ['ops', 'admin'] },
        ],
      }
    );

    const users = out['Users'] as Array<Record<string, unknown>>;
    // No misattribution — the property rule 3 exists for — and no plaintext
    // persisted (issue #2852). `Groups` matches the source and survives.
    expect(users[0]!['Password']).toBe(SECRET_MASK);
    expect(users[0]!['Password']).not.toBe(ADMIN_PW);
    expect(users[0]!['Username']).not.toBe(ADMIN_USER);
    expect(users[1]!['Password']).toBe(SECRET_MASK);
    expect(users[0]!['Groups']).toEqual(['admin', 'ops']);
  });

  it('REFUSES a THREE-element list permutation inside an anchor', () => {
    // The two-element case can be read as a swap of a pair; a 3-cycle shows the
    // rule is about the list being a MULTISET to this pass, not about pairs.
    const out = readback(
      {
        L: [
          { Tags: ['a', 'b', 'c'], V: 'plain-B' },
          { Tags: ['b', 'c', 'a'], V: 'plain-A' },
        ],
      },
      {
        L: [
          { Tags: ['a', 'b', 'c'], V: EXPR_A },
          { Tags: ['b', 'c', 'a'], V: EXPR_B },
        ],
      }
    );

    // Each bag anchor matches its OWN index exactly, so rule 1 passes and rule 3
    // is the only thing that can refuse -- which is what makes this discriminate
    // the sort. An earlier fixture put the permutation on the BAG side, where
    // rule 1's positional deep-equality refused it and the case proved nothing.
    const list = out['L'] as Array<Record<string, unknown>>;
    expect(list[0]!['V']).toBe(SECRET_MASK);
    expect(list[1]!['V']).toBe(SECRET_MASK);
    expect(list[0]!['V']).not.toBe(EXPR_A);
    expect(list[0]!['Tags']).toEqual(['a', 'b', 'c']);
  });

  it('REFUSES an anchor list REORDERED in place, because rule 1 stays order-SENSITIVE', () => {
    // The ASYMMETRY, pinned. Rule 3 becomes order-insensitive; rule 1 must NOT.
    // Rule 1 asks "did AWS return this exact position unchanged", and a list it
    // reordered is a changed position -- so index 0's permuted `Tags` refuses
    // the whole array here. Making rule 1 order-blind as well would be a real
    // weakening dressed up as consistency, and this case is what fails if a
    // later edit tries it.
    const out = readback(
      {
        L: [
          { Tags: ['ops', 'admin'], V: PLAIN_A },
          { Tags: ['app'], V: PLAIN_B },
        ],
      },
      {
        L: [
          { Tags: ['admin', 'ops'], V: EXPR_A },
          { Tags: ['app'], V: EXPR_B },
        ],
      }
    );

    // Index 0's anchor is a PERMUTATION of the source's, so rule 1's positional
    // deep-equality refuses this array outright. Order-insensitivity lives in
    // rule 3 alone; making rule 1 order-blind too would be a real weakening,
    // and this pins the asymmetry.
    const list = out['L'] as Array<Record<string, unknown>>;
    expect(list[0]!['V']).toBe(SECRET_MASK);
    expect(list[1]!['V']).toBe(SECRET_MASK);
    expect(list[0]!['V']).not.toBe(EXPR_A);
    expect(list[0]!['Tags']).toEqual(['ops', 'admin']);
  });

  it('CLOSES two elements distinguished by list CONTENT, anchors matching in place', () => {
    // ...and the same shape with index 0's anchor left in the source's own
    // order, so rule 1 passes and rule 3 is what decides. Different multisets,
    // so the signatures still differ after sorting and both elements redact.
    const out = readback(
      {
        L: [
          { Tags: ['admin', 'ops'], V: PLAIN_A },
          { Tags: ['app'], V: PLAIN_B },
        ],
      },
      {
        L: [
          { Tags: ['admin', 'ops'], V: EXPR_A },
          { Tags: ['app'], V: EXPR_B },
        ],
      }
    );

    expect(out['L']).toEqual([
      { Tags: ['admin', 'ops'], V: EXPR_A },
      { Tags: ['app'], V: EXPR_B },
    ]);
  });

  it('CLOSES two reference positions sitting under ONE anchor', () => {
    // Evidence is per ELEMENT, not per reference-bearing leaf: one identity
    // pins the element, and every reference inside it is then at a position the
    // bag already has. A rule that demanded an anchor per leaf would refuse the
    // commonest real shape (a user record holding both a name and a password).
    const out = readback(
      { L: [{ Field: 'creds', User: PLAIN_A, Pass: PLAIN_B }] },
      { L: [{ Field: 'creds', User: EXPR_A, Pass: EXPR_B }] }
    );

    expect(out['L']).toEqual([{ Field: 'creds', User: EXPR_A, Pass: EXPR_B }]);
    expect(JSON.stringify(out)).not.toContain('resolved-value-of');
  });
});
