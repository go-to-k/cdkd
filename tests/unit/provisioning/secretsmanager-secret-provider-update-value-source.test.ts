import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateSecretCommand, UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Hoisted so a test can assert on it: the provider's warn is the ONLY thing
// that distinguishes a SKIPPED secret value from an UNCHANGED one (issue
// #3048) — both send no `SecretString`.
const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/utils/logger.js', () => {
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';
import { withCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:0:secret:my-secret-AbCdEf';
const TYPE = 'AWS::SecretsManager::Secret';

/** The single UpdateSecret input the provider sent. */
function updateInput(): { SecretString?: string; Description?: string } {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as { SecretString?: string; Description?: string };
}

// The warn-skip arms below are reached only on a state-borne update since
// issue #3740 (a rollback revert arm sets `replayingState`); a template-path
// update refuses a changed malformed block instead.
const STATE_REPLAY = { replayingState: true } as const;

/**
 * Issue #2472: the secret VALUE rides an in-place update only when its SOURCE
 * changed. Pre-fix, `update()` re-ran `generateSecretString()` on every call
 * (a Tags-only or Description-only deploy minted a fresh password and staged
 * it AWSCURRENT) and re-sent an unchanged literal (stacking a new version per
 * update). CloudFormation regenerates only when the `GenerateSecretString`
 * block itself changes, and re-sends a literal only when it changes.
 */
describe('SecretsManagerSecretProvider update() value source (issue #2472)', () => {
  let provider: SecretsManagerSecretProvider;

  const generated = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    Name: 'my-secret',
    Description: 'app secret',
    GenerateSecretString: {
      SecretStringTemplate: '{"username":"admin"}',
      GenerateStringKey: 'password',
      PasswordLength: 32,
      ExcludePunctuation: true,
    },
    ...extra,
  });

  const literal = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    Name: 'my-secret',
    Description: 'app secret',
    SecretString: 'literal-value',
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SecretsManagerSecretProvider();
  });

  it('a Tags-only update of a GenerateSecretString secret sends NO SecretString', async () => {
    const prev = generated({ Tags: [{ Key: 'env', Value: 'dev' }] });
    const next = generated({ Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('SKIPS the value for a malformed GenerateSecretString instead of throwing', async () => {
    // Issue #3048. `update()` is reached by the rollback executor's revert
    // arms with a cdkd STATE record as the desired bag, which the user cannot
    // edit from the template — so throwing here left the secret
    // un-rollbackable (the #1544 hazard). (`cdkd drift --revert` never hands
    // this key over: `getDriftUnknownPaths` keeps it out of the comparison.)
    //
    // The remedy is a SKIP, not an `onUnusable` downgrade, because proceeding
    // is the harm: `generateSecretString` reads every member off the
    // container, so a malformed one mints a bare default-charset password and
    // — with `GenerateStringKey` / `SecretStringTemplate` also gone —
    // returns it RAW instead of the JSON document the template declared.
    const prev = generated();
    const next = { ...generated(), GenerateSecretString: { Ref: 'GenConfig' } };

    await provider.update('L', SECRET_ARN, TYPE, next, prev, STATE_REPLAY);

    // The UpdateSecret still goes out (other members may have changed), but
    // carries NO SecretString — `UpdateSecret`'s merge semantics then leave
    // the value AWS already holds untouched.
    expect(updateInput().SecretString).toBeUndefined();
  });

  it('distinguishes a SKIPPED value from an UNCHANGED one by its warning', async () => {
    // Both return `undefined` from `changedSecretValue` and both send no
    // `SecretString`, so a regression that ALWAYS skips looks correct on the
    // wire. The warning is the only thing that tells them apart, which is why
    // it is asserted rather than the payload alone.
    await provider.update('L', SECRET_ARN, TYPE, generated(), generated());
    expect(childLogger.warn).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await provider.update('L', SECRET_ARN, TYPE, { ...generated(), GenerateSecretString: 'nope' }, generated(), STATE_REPLAY);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('GenerateSecretString must be an object')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('keeps the value AWS currently holds')
    );
  });

  it('a SKIPPED generate block RETAINS the previous one in the recorded bag', async () => {
    // The blocker both reviewers found. Without this, the engine records the
    // DESIRED (malformed) bag, so the next deploy of the same broken template
    // compares desired == previous, takes the `unchanged` early return, and
    // the secret sits un-regenerated with NO warning — a loud repeating
    // failure converted into a silent one. The poisoned record then reaches
    // the reverse-replacement replay-create, which refuses it.
    const prev = generated();
    const next = { ...generated(), GenerateSecretString: { Ref: 'GenConfig' } };

    const result = await provider.update('L', SECRET_ARN, TYPE, next, prev, STATE_REPLAY);

    expect(result.effectiveProperties?.['GenerateSecretString']).toEqual(
      prev['GenerateSecretString']
    );
    // COPIED, not aliased (the #1653 review rule): both engine consumers
    // spread the answer one level deep, so an aliased block would let a later
    // mutation of the previous bag rewrite the record.
    expect(result.effectiveProperties?.['GenerateSecretString']).not.toBe(
      prev['GenerateSecretString']
    );
    // Every other key rides through untouched — `effectiveProperties` REPLACES
    // the desired bag wholesale, so it has to be complete.
    expect(result.effectiveProperties?.['Name']).toBe('my-secret');
    // A retained block is not a drop, so the drop warning stays silent.
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('dropped from the recorded properties')
    );
  });

  it('a SKIP with an unusable PREVIOUS block drops the key rather than recording junk', async () => {
    // #1653's rule: with neither side vouchable there is no value to record,
    // and an explicitly-`undefined` key survives `structuredClone` where a
    // dropped one does not — so the key is removed, not set to undefined.
    const prev = { ...generated(), GenerateSecretString: 'also-broken' };
    const next = { ...generated(), GenerateSecretString: { Ref: 'GenConfig' } };

    const result = await provider.update('L', SECRET_ARN, TYPE, next, prev, STATE_REPLAY);

    expect(result.effectiveProperties).toBeDefined();
    expect('GenerateSecretString' in result.effectiveProperties!).toBe(false);
    // The drop is ANNOUNCED (the #1654 rule): a record with no value source
    // later reaches the reverse-replacement replay-create, which would create
    // the secret with no version — an absent key is not malformed, so nothing
    // downstream would otherwise say so.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped from the recorded properties')
    );
    // Names the resource: a stack with two secrets must be able to tell them
    // apart from the warning alone.
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Secret L:'));
  });

  it('a SKIP with an ABSENT previous block (secret created from a literal) drops the key too', async () => {
    // The ABSENT previous: the record carries a literal and no block, the
    // template switched to a malformed block. The guard answers `undefined`
    // for an absent value exactly as for an unusable one, so the key is
    // dropped and the drop announced; the literal is NOT restored (the
    // template removed it), see the helper's JSDoc.
    const prev = literal();
    const next = { ...generated(), GenerateSecretString: { Ref: 'GenConfig' } };

    const result = await provider.update('L', SECRET_ARN, TYPE, next, prev, STATE_REPLAY);

    expect(updateInput().SecretString).toBeUndefined();
    expect('GenerateSecretString' in result.effectiveProperties!).toBe(false);
    expect('SecretString' in result.effectiveProperties!).toBe(false);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped from the recorded properties')
    );
  });

  it.each([
    ['an empty string', ''],
    ['zero', 0],
  ])('a FALSY malformed GenerateSecretString (%s) still reaches the guard', async (_l, bad) => {
    // The #1493 gate-bug shape. Under the old truthiness gate these fell
    // straight through to the `SecretString` branch, so a declared generate
    // block was ignored in silence — and with no `SecretString` either, the
    // update sent no value at all and nothing said why. `!= null` routes them
    // to the guard, which skips and warns like any other malformed container.
    const prev = generated();
    const next = { ...generated(), GenerateSecretString: bad };

    const result = await provider.update('L', SECRET_ARN, TYPE, next, prev, STATE_REPLAY);

    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('GenerateSecretString must be an object')
    );
    expect(updateInput().SecretString).toBeUndefined();
    // ...and it takes the same retention as any other skip.
    expect(result.effectiveProperties?.['GenerateSecretString']).toEqual(
      prev['GenerateSecretString']
    );
  });

  it.each([
    ['update', 'sends nothing and records the desired bag'],
    ['create', 'creates a valueless secret and says so'],
  ])('an explicit GenerateSecretString: null on %s is ABSENT, not malformed (%s)', async (path) => {
    // `config-shape.ts` rule 1: `undefined` / `null` mean "the template
    // omitted the block", so the `!= null` gate must let a declared `null`
    // fall through to the literal read WITHOUT the malformed-container
    // warning -- the one falsy value that gate and `requireConfigObject`
    // would otherwise disagree about (test-review round of go-to-k/cdkd#3058).
    const props = { Name: 'my-secret', Description: 'app secret', GenerateSecretString: null };
    if (path === 'update') {
      const result = await provider.update('L', SECRET_ARN, TYPE, props, generated());
      expect(updateInput().SecretString).toBeUndefined();
      expect(result.effectiveProperties).toBeUndefined();
      expect(childLogger.warn).not.toHaveBeenCalled();
    } else {
      mockSend.mockResolvedValue({ ARN: SECRET_ARN });
      await provider.create('L', TYPE, props);
      const created = mockSend.mock.calls.find((c) => c[0] instanceof CreateSecretCommand);
      expect(created![0].input.SecretString).toBeUndefined();
      expect(childLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('must be an object')
      );
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('created with NO version')
      );
    }
  });

  it('an ORDINARY update records nothing — effectiveProperties is absent', async () => {
    // Every engine reader gates on truthiness or `=== undefined`, so ABSENT is the contract for "record the
    // desired bag". An implementation that always returned a bag would be
    // indistinguishable by value here but would rewrite the record on every
    // deploy.
    const result = await provider.update('L', SECRET_ARN, TYPE, generated({ Description: 'x' }), generated());
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('create() still REFUSES a malformed GenerateSecretString — no live value to keep', async () => {
    // The skip is scoped to `changedSecretValue`; `generateSecretString` is
    // shared with `create()`, where there is no existing secret to fall back
    // to, so a skip there would create a secret with no version at all.
    await expect(
      provider.create('L', TYPE, { ...generated(), GenerateSecretString: { Ref: 'GenConfig' } })
    ).rejects.toThrow(/GenerateSecretString must be an object \(got an unresolved Ref intrinsic/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty string', ''],
    ['zero', 0],
  ])('create() REFUSES a FALSY malformed GenerateSecretString (%s) too', async (_l, bad) => {
    // The same #1493 gate shape on the create path (round-2 review): under
    // the truthiness gate a falsy block fell through to the literal read and,
    // with no `SecretString`, created a secret with NO version in silence.
    const props = { ...generated(), GenerateSecretString: bad };
    await expect(provider.create('L', TYPE, props)).rejects.toThrow(
      /GenerateSecretString must be an object/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('create() WARNS when the bag carries no secret value at all', async () => {
    // Legal by the schema, but on the reverse-replacement replay-create this
    // is exactly the shape a DROPPED block arrives in, and `create()` cannot
    // tell that record from a template that meant it.
    mockSend.mockResolvedValue({ ARN: SECRET_ARN });
    const props = { Name: 'my-secret', Description: 'app secret' };

    await provider.create('L', TYPE, props);

    const created = mockSend.mock.calls.find((c) => c[0] instanceof CreateSecretCommand);
    expect(created![0].input.SecretString).toBeUndefined();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('created with NO version')
    );
  });

  it('create() does NOT warn when a value source is present', async () => {
    // The control for the case above: a warning that fires on every create
    // is noise nobody reads.
    mockSend.mockResolvedValue({ ARN: SECRET_ARN });
    await provider.create('L', TYPE, generated());
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  // Issue #3056: the container's MEMBERS take the same road as the container.
  // A malformed member used to take a DEFAULT that was not inert -- an empty
  // password, punctuation excluded by a truthy 'false', a bare password where
  // a JSON document was declared -- or, for `ExcludeCharacters`, to THROW on
  // the update path (the #1544 hazard one level down).
  const MALFORMED_MEMBERS: Array<[string, Record<string, unknown>, RegExp]> = [
    ['PasswordLength: null', { PasswordLength: null }, /PasswordLength must be an integer between 1 and 4096/],
    ['PasswordLength: "abc" (minted an EMPTY password)', { PasswordLength: 'abc' }, /PasswordLength must be an integer/],
    ['PasswordLength: 0', { PasswordLength: 0 }, /PasswordLength must be an integer between 1 and 4096/],
    ['PasswordLength: 4097 (the service cap)', { PasswordLength: 4097 }, /PasswordLength must be an integer between 1 and 4096/],
    ['PasswordLength: "1e2" (Number() coerces, CFn does not)', { PasswordLength: '1e2' }, /PasswordLength must be an integer/],
    ['PasswordLength: "0x10"', { PasswordLength: '0x10' }, /PasswordLength must be an integer/],
    ['PasswordLength: 3.5', { PasswordLength: 3.5 }, /PasswordLength must be an integer/],
    ['PasswordLength: {Ref}', { PasswordLength: { Ref: 'Len' } }, /PasswordLength must be an integer/],
    ['ExcludePunctuation: "yes"', { ExcludePunctuation: 'yes' }, /ExcludePunctuation must be a boolean/],
    ['ExcludeUppercase: null', { ExcludeUppercase: null }, /ExcludeUppercase must be a boolean/],
    ['ExcludeLowercase: 1', { ExcludeLowercase: 1 }, /ExcludeLowercase must be a boolean/],
    ['ExcludeNumbers: []', { ExcludeNumbers: [] }, /ExcludeNumbers must be a boolean/],
    ['ExcludeCharacters: null', { ExcludeCharacters: null }, /ExcludeCharacters must be a non-empty string/],
    ['ExcludeCharacters: 123', { ExcludeCharacters: 123 }, /ExcludeCharacters must be a non-empty string/],
    ['GenerateStringKey: ""', { GenerateStringKey: '', SecretStringTemplate: '{}' }, /GenerateStringKey must be a non-empty string/],
    ['SecretStringTemplate: {object}', { GenerateStringKey: 'p', SecretStringTemplate: { a: 1 } }, /SecretStringTemplate must be a non-empty string/],
    ['GenerateStringKey without SecretStringTemplate', { GenerateStringKey: 'password' }, /must be declared together \(got only GenerateStringKey\)/],
    ['SecretStringTemplate without GenerateStringKey', { SecretStringTemplate: '{"u":"a"}' }, /must be declared together \(got only SecretStringTemplate\)/],
    ['SecretStringTemplate not JSON (returned the bare password RAW)', { GenerateStringKey: 'p', SecretStringTemplate: '{oops' }, /SecretStringTemplate must be a JSON object \(got a string that does not parse/],
    ['SecretStringTemplate a JSON array', { GenerateStringKey: 'p', SecretStringTemplate: '[1]' }, /SecretStringTemplate must be a JSON object \(got JSON that is not an object/],
    ['SecretStringTemplate JSON null (template[key] would throw on the update path)', { GenerateStringKey: 'p', SecretStringTemplate: 'null' }, /SecretStringTemplate must be a JSON object \(got JSON that is not an object/],
    ['SecretStringTemplate a JSON scalar', { GenerateStringKey: 'p', SecretStringTemplate: '42' }, /SecretStringTemplate must be a JSON object \(got JSON that is not an object/],
    // Issue #3068: the two members the recipe used to ignore, and the three
    // charset rules measured on CloudFormation.
    ['IncludeSpace: "yes"', { IncludeSpace: 'yes' }, /IncludeSpace must be a boolean/],
    ['RequireEachIncludedType: null', { RequireEachIncludedType: null }, /RequireEachIncludedType must be a boolean/],
    ['PasswordLength 3 under four required types (CFn: too short based on the required types)', { PasswordLength: 3 }, /PasswordLength 3 is too short for the 4 character types RequireEachIncludedType requires/],
    ['a REQUIRED class emptied by ExcludeCharacters (CFn: all characters of the desired type have been excluded)', { ExcludeCharacters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }, /all characters of the uppercase type have been excluded while RequireEachIncludedType requires one \(exclude the type with ExcludeUppercase instead\)/],
    ['every character excluded (CFn: all characters have been excluded from selection)', { ExcludeUppercase: true, ExcludeLowercase: true, ExcludeNumbers: true, ExcludePunctuation: true }, /all characters have been excluded from selection/],
    ['GenerateStringKey: "__proto__" (the password went to the prototype, not the document)', { GenerateStringKey: '__proto__', SecretStringTemplate: '{"u":"a"}' }, /GenerateStringKey must not be __proto__/],
  ];
  const withBlock = (members: Record<string, unknown>): Record<string, unknown> => ({
    Name: 'my-secret',
    Description: 'app secret',
    GenerateSecretString: { PasswordLength: 16, ...members },
  });

  it.each(MALFORMED_MEMBERS)(
    'update() SKIPS the value and retains the previous block for a malformed member (%s)',
    async (_l, members, message) => {
      const prev = generated();
      const next = withBlock(members);

      const result = await provider.update('L', SECRET_ARN, TYPE, next, prev, STATE_REPLAY);

      expect(updateInput().SecretString).toBeUndefined();
      expect(childLogger.warn).toHaveBeenCalledWith(expect.stringMatching(message));
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('keeps the value AWS currently holds')
      );
      expect(result.effectiveProperties?.['GenerateSecretString']).toEqual(
        prev['GenerateSecretString']
      );
    }
  );

  it.each(MALFORMED_MEMBERS)(
    'create() REFUSES a malformed member (%s) before any call',
    async (_l, members, message) => {
      await expect(provider.create('L', TYPE, withBlock(members))).rejects.toThrow(message);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['PasswordLength: "20"', { PasswordLength: '20' }, (v: string) => expect(v).toHaveLength(20)],
    ['PasswordLength: 20', { PasswordLength: 20 }, (v: string) => expect(v).toHaveLength(20)],
    [
      'ExcludePunctuation: "true"',
      { ExcludePunctuation: 'true', PasswordLength: 200 },
      (v: string) => expect(v).toMatch(/^[A-Za-z0-9]+$/),
    ],
    [
      'ExcludePunctuation: "false" (a truthy string used to EXCLUDE)',
      { ExcludePunctuation: 'false', ExcludeUppercase: true, ExcludeLowercase: true, ExcludeNumbers: true, PasswordLength: 200 },
      (v: string) => expect(v).toMatch(/^[^A-Za-z0-9]+$/),
    ],
    [
      'ExcludeCharacters',
      {
        ExcludeCharacters: 'aeiou',
        ExcludeUppercase: true,
        ExcludeNumbers: true,
        ExcludePunctuation: true,
        PasswordLength: 200,
      },
      // Lowercase minus the vowels: a check the generator's own all-excluded
      // fallback (plain lowercase) cannot satisfy by accident.
      (v: string) => expect(v).toMatch(/^[b-df-hj-np-tv-z]+$/),
    ],
  ])('a CFn-spelled member is COERCED, not refused (%s)', async (_l, members, check) => {
    await provider.update('L', SECRET_ARN, TYPE, withBlock(members), generated());
    const sent = updateInput().SecretString;
    expect(sent).toBeDefined();
    check(sent!);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  // Issue #3068: the recipe itself. Every row below reads the WHOLE sent value
  // against a charset the config yields, so none depends on a random draw
  // landing anywhere in particular; the RequireEachIncludedType rows draw
  // repeatedly because the guarantee is per draw.
  const AWS_PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_' + String.fromCharCode(0x60) + '{|}~';
  const classesIn = (v: string): number =>
    [
      (t: string) => /[A-Z]/.test(t),
      (t: string) => /[a-z]/.test(t),
      (t: string) => /[0-9]/.test(t),
      (t: string) => [...t].some((c) => AWS_PUNCTUATION.includes(c)),
    ].filter((has) => has(v)).length;

  it('the punctuation class is the SERVICE\'s 32-character set, not the old 26', async () => {
    // Uppercase / lowercase / numbers excluded, so the pool IS the
    // punctuation class; over 2000 draws every member appears (the chance a
    // given one is absent is (31/32)^2000, ~1e-28), including the six the
    // old set lacked.
    const block = { ExcludeUppercase: true, ExcludeLowercase: true, ExcludeNumbers: true, PasswordLength: 2000 };
    await provider.update('L', SECRET_ARN, TYPE, withBlock(block), generated());
    const sent = updateInput().SecretString!;
    expect([...sent].every((c) => AWS_PUNCTUATION.includes(c))).toBe(true);
    for (const c of ['"', "'", '/', '\\', String.fromCharCode(0x60), '~']) expect(sent).toContain(c);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    // The issue's headline: an ExcludeCharacters naming one of the six the
    // old set lacked was INERT. Every class is stripped by the same helper,
    // and each row keeps the class non-empty so the default
    // RequireEachIncludedType still holds.
    ['the six punctuation characters the old set lacked', { ExcludeUppercase: true, ExcludeLowercase: true, ExcludeNumbers: true, ExcludeCharacters: '"\'/\\' + String.fromCharCode(0x60) + '~' }, /^[!#$%&()*+,\-.:;<=>?@[\]^_{|}]+$/],
    ['half the digits', { ExcludeUppercase: true, ExcludeLowercase: true, ExcludePunctuation: true, ExcludeCharacters: '01234' }, /^[5-9]+$/],
    ['all but one letter of a REQUIRED class (the guarantee then places that one)', { ExcludeLowercase: true, ExcludeNumbers: true, ExcludePunctuation: true, ExcludeCharacters: 'ABCDEFGHIJKLMNOPQRSTUVWXY' }, /^Z+$/],
  ])('ExcludeCharacters strips %s', async (_l, members, shape) => {
    const block = { ...members, PasswordLength: 2000 };
    await provider.update('L', SECRET_ARN, TYPE, withBlock(block), generated());
    expect(updateInput().SecretString).toMatch(shape);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('a draw at or above the rejection limit is thrown away, not folded by modulo', async () => {
    // Deterministic fence for the rejection sampling (test-review round):
    // pool = lowercase (26), limit = floor(2^32 / 26) * 26 = 4294967274, so a
    // draw of 0xFFFFFFFF sits above it and must be re-drawn; the re-draw of 0
    // lands on 'a'. A `% n` shortcut would mint 'v' (0xFFFFFFFF % 26 = 21).
    const draws = [0xff_ff_ff_ff, 0];
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((arr: Uint32Array) => {
      arr[0] = draws.shift() ?? 0;
      return arr;
    }) as typeof crypto.getRandomValues);
    try {
      const block = { ExcludeUppercase: true, ExcludeNumbers: true, ExcludePunctuation: true, RequireEachIncludedType: false, PasswordLength: 1 };
      await provider.update('L', SECRET_ARN, TYPE, withBlock(block), generated());
      expect(updateInput().SecretString).toBe('a');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('the PLACED character of a required class comes from the STRIPPED class', async () => {
    // Deterministic fence for the placement step (round-2 review: the
    // probabilistic rows let a "placement draws from the unstripped class"
    // mutant survive ~1.6% of runs). All-zero draws: the pool draw lands on
    // the pool's first char and the placement draw on the required class's
    // first char -- 'Z' after A..Y are excluded, 'A' on the mutant.
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((
      arr: Uint32Array
    ) => {
      arr[0] = 0;
      return arr;
    }) as typeof crypto.getRandomValues);
    try {
      const block = { ExcludeLowercase: true, ExcludeNumbers: true, ExcludePunctuation: true, ExcludeCharacters: 'ABCDEFGHIJKLMNOPQRSTUVWXY', PasswordLength: 1 };
      await provider.update('L', SECRET_ARN, TYPE, withBlock(block), generated());
      expect(updateInput().SecretString).toBe('Z');
    } finally {
      spy.mockRestore();
    }
  });

  it('IncludeSpace admits the space character (and ExcludeCharacters can take it back)', async () => {
    // Every class switched off, RequireEachIncludedType off, IncludeSpace on:
    // the pool is the space alone.
    const only = { ExcludeUppercase: true, ExcludeLowercase: true, ExcludeNumbers: true, ExcludePunctuation: true, RequireEachIncludedType: false, IncludeSpace: true, PasswordLength: 16 };
    await provider.update('L', SECRET_ARN, TYPE, withBlock(only), generated());
    expect(updateInput().SecretString).toBe(' '.repeat(16));
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    // Space admitted but excluded by name: the pool is lowercase only.
    const taken = { ExcludeUppercase: true, ExcludeNumbers: true, ExcludePunctuation: true, IncludeSpace: true, ExcludeCharacters: ' ', PasswordLength: 200 };
    await provider.update('L', SECRET_ARN, TYPE, withBlock(taken), generated());
    expect(updateInput().SecretString).toMatch(/^[a-z]+$/);
  });

  it('RequireEachIncludedType (the DEFAULT) puts one of every included class in every draw, even at the minimum length', async () => {
    for (let i = 0; i < 200; i++) {
      vi.clearAllMocks();
      mockSend.mockResolvedValue({});
      await provider.update('L', SECRET_ARN, TYPE, withBlock({ PasswordLength: 4 }), generated());
      const v = updateInput().SecretString!;
      expect(classesIn(v), JSON.stringify(v)).toBe(4);
    }
  });

  it('RequireEachIncludedType: false draws uniformly, so a short password can miss a class', async () => {
    // 200 four-character draws from 94 characters: the chance EVERY one carries
    // all four classes is astronomically small, so at least one misses.
    let missing = 0;
    for (let i = 0; i < 200; i++) {
      vi.clearAllMocks();
      mockSend.mockResolvedValue({});
      await provider.update('L', SECRET_ARN, TYPE, withBlock({ PasswordLength: 4, RequireEachIncludedType: false }), generated());
      if (classesIn(updateInput().SecretString!) < 4) missing++;
    }
    expect(missing).toBeGreaterThan(0);
  });

  it('a class emptied by ExcludeCharacters is fine when it is not REQUIRED (measured: CREATE_COMPLETE)', async () => {
    const block = { RequireEachIncludedType: false, ExcludeCharacters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', PasswordLength: 200 };
    await provider.update('L', SECRET_ARN, TYPE, withBlock(block), generated());
    expect(updateInput().SecretString).not.toMatch(/[A-Z]/);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('writes the password into the declared template under the declared key', async () => {
    // `tok`, not `password`: a hardcoded key would coincide with the obvious
    // name and pass (test-review round of go-to-k/cdkd#3056).
    const members = { GenerateStringKey: 'tok', SecretStringTemplate: '{"username":"admin"}', PasswordLength: 24 };
    await provider.update('L', SECRET_ARN, TYPE, withBlock(members), generated());
    const doc = JSON.parse(updateInput().SecretString!) as Record<string, string>;
    expect(Object.keys(doc).sort()).toEqual(['tok', 'username']);
    expect(doc['username']).toBe('admin');
    expect(doc['tok']).toHaveLength(24);
  });

  it.each([
    ['ExcludeCharacters: "" (exclude nothing)', { ExcludeCharacters: '' }],
    ['ExcludeCharacters absent', {}],
  ])('%s leaves the charset whole', async (_l, members) => {
    // The absent default is `''`; a mutant defaulting to `'a'` would strip one
    // letter, so the case asserts the letter OCCURS. Over 2000 draws from 26
    // letters the chance of a legitimately missing 'a' is (25/26)^2000, ~1e-34.
    const block = { ...members, ExcludeUppercase: true, ExcludeNumbers: true, ExcludePunctuation: true, PasswordLength: 2000 };
    await provider.update('L', SECRET_ARN, TYPE, withBlock(block), generated());
    const sent = updateInput().SecretString!;
    expect(sent).toMatch(/^[a-z]+$/);
    expect(sent).toContain('a');
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('a SKIP whose PREVIOUS block has a malformed MEMBER drops the key (same predicate as the wire)', async () => {
    // The #1653 rule, one level down (code-review round of go-to-k/cdkd#3056):
    // a pre-#3056 record can hold `PasswordLength: 'abc'` inside a well-formed
    // block. The container check alone would RETAIN it; the member predicate
    // the wire runs says it is not a value cdkd can vouch for.
    const prev = withBlock({ PasswordLength: 'abc' });
    const next = withBlock({ PasswordLength: null });

    const result = await provider.update('L', SECRET_ARN, TYPE, next, prev, STATE_REPLAY);

    expect(updateInput().SecretString).toBeUndefined();
    expect('GenerateSecretString' in result.effectiveProperties!).toBe(false);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped from the recorded properties')
    );
  });

  it('a Description-only update of a GenerateSecretString secret sends NO SecretString', async () => {
    const prev = generated();
    const next = generated({ Description: 'renamed' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const input = updateInput();
    expect(input.SecretString).toBeUndefined();
    expect(input.Description).toBe('renamed');
  });

  it('a GenerateSecretString block with a DIFFERENT key order is not a change', async () => {
    // The previous bag is read back from state.json and the new one comes
    // from the resolver; a serialization-order difference must not re-roll
    // the password (which a JSON.stringify comparison would do).
    const prev = generated();
    const reordered = {
      ExcludePunctuation: true,
      PasswordLength: 32,
      GenerateStringKey: 'password',
      SecretStringTemplate: '{"username":"admin"}',
    };
    const next = generated({ GenerateSecretString: reordered, Description: 'renamed' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a CHANGED GenerateSecretString block mints a new value of the new shape', async () => {
    const prev = generated();
    const next = generated({
      GenerateSecretString: {
        ...(prev['GenerateSecretString'] as Record<string, unknown>),
        PasswordLength: 40,
      },
    });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const sent = updateInput().SecretString;
    expect(sent).toBeDefined();
    const parsed = JSON.parse(sent!) as { username: string; password: string };
    expect(parsed.username).toBe('admin');
    expect(parsed.password).toHaveLength(40);
  });

  it('an unchanged literal SecretString is NOT re-sent on a Tags-only update', async () => {
    const prev = literal({ Tags: [{ Key: 'env', Value: 'dev' }] });
    const next = literal({ Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a CHANGED literal SecretString is sent', async () => {
    const prev = literal();
    const next = literal({ SecretString: 'literal-value-v2' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBe('literal-value-v2');
  });

  it('a literal changed to the EMPTY string is sent, not treated as absent', async () => {
    // A user-written `SecretString: ''` is a change; AWS decides whether to
    // accept it. Silently keeping the old value would hide the edit.
    const prev = literal();
    const next = literal({ SecretString: '' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBe('');
  });

  it('switching from GenerateSecretString to an EMPTY literal is sent', async () => {
    const prev = generated();
    const next = literal({ SecretString: '' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBe('');
  });

  it('switching from a literal to GenerateSecretString mints a value', async () => {
    const prev = literal();
    const next = generated();

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const sent = updateInput().SecretString;
    expect(sent).toBeDefined();
    expect(sent).not.toBe('literal-value');
  });

  it('switching from GenerateSecretString to a literal sends the literal', async () => {
    const prev = generated();
    const next = literal();

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBe('literal-value');
  });

  it('GenerateSecretString wins over a literal on the same bag, and only its change counts', async () => {
    // CloudFormation gives GenerateSecretString precedence when both are set.
    // An unchanged block beside a changed literal is therefore NOT a change.
    const prev = generated({ SecretString: 'ignored-a' });
    const next = generated({ SecretString: 'ignored-b' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a rollback replay (previous bag == desired bag) sends NO SecretString', async () => {
    // rollback-executor replays previousState.properties through update();
    // the bag still carries GenerateSecretString, so pre-fix the recovery
    // path re-rolled the password too.
    const desired = generated();

    await provider.update('L', SECRET_ARN, TYPE, desired, { ...desired });

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a rollback revert of a Tags-only deploy (old bag as desired, new bag as previous) sends NO SecretString', async () => {
    // The revert arm passes (previousState.properties, currentProps): the
    // OLD bag is `properties` and the failed deploy's bag is
    // `previousProperties`. Same block on both sides either way.
    const old = generated({ Tags: [{ Key: 'env', Value: 'dev' }] });
    const failed = generated({ Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, old, failed);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a Description-only update of a literal secret sends NO SecretString', async () => {
    const prev = literal();
    const next = literal({ Description: 'renamed' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const input = updateInput();
    expect(input.SecretString).toBeUndefined();
    expect(input.Description).toBe('renamed');
  });

  it('the CDK-default empty GenerateSecretString block is unchanged across a Tags-only update', async () => {
    // `new secretsmanager.Secret(...)` synthesizes `GenerateSecretString: {}`;
    // this is the shape the issue names as the common trigger.
    const prev = generated({ GenerateSecretString: {}, Tags: [{ Key: 'env', Value: 'dev' }] });
    const next = generated({ GenerateSecretString: {}, Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('an explicit undefined member in the desired block is not a change', async () => {
    // state.json cannot hold `undefined`, so a resolver-side `{ ..., X: undefined }`
    // must compare equal to the persisted block without X — the failure
    // direction would be a silent re-roll.
    const prev = generated();
    const next = generated({
      GenerateSecretString: {
        ...(prev['GenerateSecretString'] as Record<string, unknown>),
        ExcludeCharacters: undefined,
      },
    });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a bag with NEITHER source keeps the live value (no SecretString sent)', async () => {
    const prev = generated();
    const next = { Name: 'my-secret', Description: 'renamed' };

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a non-string SecretString is refused by shape, without echoing the value', async () => {
    const prev = literal();
    const next = literal({ SecretString: { nested: 'super-secret-value' } });

    let message = '';
    try {
      await provider.update('L', SECRET_ARN, TYPE, next, prev);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/SecretString must be a string, got object/);
    expect(message).not.toMatch(/super-secret-value/);
    const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
    expect(calls).toHaveLength(0);
  });

  it('a CHANGED GenerateSecretString block beside a literal mints a value (precedence, changed polarity)', async () => {
    // The unchanged-block direction is pinned above; this is the other
    // polarity: the block wins, so its change is what gets sent — not the
    // (ignored) literal. A PRECEDENCE PIN, not a regression fence: the
    // provider already behaved this way before this test was added (PR
    // #2476 review, nit 6) — it kills a literal-first mutant, nothing else.
    const prev = generated({ SecretString: 'ignored' });
    const next = generated({
      SecretString: 'ignored',
      GenerateSecretString: {
        ...(prev['GenerateSecretString'] as Record<string, unknown>),
        PasswordLength: 40,
      },
    });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const sent = updateInput().SecretString;
    expect(sent).toBeDefined();
    expect(sent).not.toBe('ignored');
    expect((JSON.parse(sent!) as { password: string }).password).toHaveLength(40);
  });

  it('a legacy record holding a NON-STRING SecretString still takes a Tags-only update', async () => {
    // A pre-#2472 create() forwarded a non-string through a cast and state
    // persisted it. UNCHANGED is decided before the shape is judged, so an
    // unrelated update keeps succeeding; nothing is sent.
    const legacy = { nested: 'legacy-value' };
    const prev = literal({ SecretString: legacy, Tags: [{ Key: 'env', Value: 'dev' }] });
    const next = literal({ SecretString: { ...legacy }, Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('create() refuses a non-string SecretString by shape, without echoing the value', async () => {
    let message = '';
    try {
      await provider.create('L', TYPE, literal({ SecretString: { nested: 'super-secret-value' } }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/SecretString must be a string, got object/);
    expect(message).not.toMatch(/super-secret-value/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('create() refuses a null SecretString too, while still skipping the empty string', async () => {
    await expect(provider.create('L', TYPE, literal({ SecretString: null }))).rejects.toThrow(
      /SecretString must be a string, got null/
    );
    expect(mockSend).not.toHaveBeenCalled();

    mockSend.mockResolvedValue({ ARN: SECRET_ARN });
    await provider.create('L', TYPE, literal({ SecretString: '' }));
    const created = mockSend.mock.calls.find((c) => c[0] instanceof CreateSecretCommand);
    expect(created).toBeDefined();
    expect((created![0].input as { SecretString?: string }).SecretString).toBeUndefined();
    // ...and since issue #3048 the valueless create is ANNOUNCED.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('created with NO version')
    );
  });

  it('a null SecretString is refused as "null"', async () => {
    const prev = literal();
    const next = literal({ SecretString: null });

    await expect(provider.update('L', SECRET_ARN, TYPE, next, prev)).rejects.toThrow(
      /SecretString must be a string, got null/
    );
  });

  it('an array-valued SecretString is refused as "array"', async () => {
    const prev = literal();
    const next = literal({ SecretString: ['super-secret-value'] });

    let message = '';
    try {
      await provider.update('L', SECRET_ARN, TYPE, next, prev);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/SecretString must be a string, got array/);
    expect(message).not.toMatch(/super-secret-value/);
  });

  describe('a {{resolve:...}} inside the source (state holds the redacted expression)', () => {
    // On the deploy path the resolver hands update() PLAINTEXT while state.json
    // holds the `{{resolve:...}}` expression the value came from. The
    // per-resource secrets scope carries the plaintext -> expression pairs.
    const EXPR = '{{resolve:secretsmanager:upstream/creds:SecretString:password}}';
    const PLAIN = 'upstream-plaintext-pw';
    const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
      withCurrentResourceSecrets(new Map([[PLAIN, EXPR]]), fn);

    it('a SecretStringTemplate embedding the reference is unchanged on a Tags-only update', async () => {
      const block = (username: string) => ({
        SecretStringTemplate: JSON.stringify({ username, password: PLAIN }),
        GenerateStringKey: 'token',
      });
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
        Tags: [{ Key: 'env', Value: 'dev' }],
      });
      const next = generated({
        GenerateSecretString: block('admin'),
        Tags: [{ Key: 'env', Value: 'prod' }],
      });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      expect(updateInput().SecretString).toBeUndefined();
    });

    it('a SecretStringTemplate embedding the reference is re-generated when the template itself changed', async () => {
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
      });
      const next = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'root', password: PLAIN }),
          GenerateStringKey: 'token',
        },
      });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      const sent = updateInput().SecretString;
      expect(sent).toBeDefined();
      const parsed = JSON.parse(sent!) as { username: string; password: string; token: string };
      expect(parsed.username).toBe('root');
      expect(parsed.password).toBe(PLAIN);
      expect(parsed.token).toHaveLength(32);
    });

    it('without the scope bound (drift --revert / import), the raw comparison still applies', async () => {
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
      });
      const next = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: PLAIN }),
          GenerateStringKey: 'token',
        },
      });

      await provider.update('L', SECRET_ARN, TYPE, next, prev);

      // No pairs to rewrite with: the two spellings differ, so a value is sent.
      // This is the pre-#2472 behaviour for this shape on the unscoped paths.
      expect(updateInput().SecretString).toBeDefined();
    });

    it('an upstream ROTATION behind an unchanged reference does not regenerate (intended trade)', async () => {
      // The reference in the template is unchanged; only the value it resolves
      // to moved. Both sides spell the expression, so nothing is sent. CFn
      // would re-resolve and regenerate; cdkd takes the no-re-roll side.
      const ROTATED = 'upstream-plaintext-pw-rotated';
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
        Tags: [{ Key: 'env', Value: 'dev' }],
      });
      const next = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: ROTATED }),
          GenerateStringKey: 'token',
        },
        Tags: [{ Key: 'env', Value: 'prod' }],
      });

      await withCurrentResourceSecrets(new Map([[ROTATED, EXPR]]), () =>
        provider.update('L', SECRET_ARN, TYPE, next, prev)
      );

      expect(updateInput().SecretString).toBeUndefined();
    });

    it('a pre-GHSA record still holding PLAINTEXT matches the raw comparison (no re-roll)', async () => {
      // A state record written before GHSA-p5qg-v9gv-hc7w redaction holds the
      // plaintext, not the expression. With the scope bound the redacted arm
      // would spell the desired block as EXPR and differ; the RAW arm is what
      // keeps such a record from re-rolling on every Tags-only update.
      const block = {
        SecretStringTemplate: JSON.stringify({ username: 'admin', password: PLAIN }),
        GenerateStringKey: 'token',
      };
      const prev = generated({ GenerateSecretString: block, Tags: [{ Key: 'env', Value: 'dev' }] });
      const next = generated({
        GenerateSecretString: { ...block },
        Tags: [{ Key: 'env', Value: 'prod' }],
      });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      expect(updateInput().SecretString).toBeUndefined();
    });

    it('KNOWN EDGE: replacing the reference with its current plaintext literal does not regenerate', async () => {
      // The redaction is a VALUE scan: a literal equal to a plaintext this
      // resource resolved elsewhere is rewritten to the expression, so the
      // block compares equal to the persisted one. Pinned as the accepted
      // behaviour (safe direction: no unrequested re-roll) — see the
      // changedSecretValue JSDoc. If this test starts failing, the comparison
      // became position-aware and the JSDoc needs updating.
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
      });
      const next = generated({
        // Same plaintext, now written as a literal; the scope still carries
        // the pair because a sibling property of this resource resolved it.
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: PLAIN }),
          GenerateStringKey: 'token',
        },
      });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      expect(updateInput().SecretString).toBeUndefined();
    });

    it('a literal that IS the reference is re-sent on a Tags-only update (deliberate)', async () => {
      // cdkd cannot tell whether the REFERENCED value changed since the last
      // deploy, and CloudFormation re-applies it when it did; a redundant
      // version is the milder failure than a stale copy.
      const prev = literal({ SecretString: EXPR, Tags: [{ Key: 'env', Value: 'dev' }] });
      const next = literal({ SecretString: PLAIN, Tags: [{ Key: 'env', Value: 'prod' }] });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      expect(updateInput().SecretString).toBe(PLAIN);
    });
  });
});

/**
 * The RUNTIME half of the #2212 fence (round-6 security review of
 * go-to-k/cdkd#3058). `tests/unit/scripts/integ-secret-fixture-sweep.test.ts`
 * reads the provider's SOURCE and refuses every spelling by which the minted
 * value could reach the recorded bag; six review rounds each found one more
 * spelling. This block asks the question by VALUE instead, which no spelling
 * can dodge: mint a value through the real code, then look for it in every
 * object the engine records -- the desired bag it was handed (the SDK route
 * records that very object) and the `effectiveProperties` a later SKIP
 * returns, with a usable and with an absent previous block, after a mint
 * from `update()` AND from `create()` (a cross-resource stash on the
 * singleton would surface on the second resource).
 */
describe('the minted secret value reaches nothing the engine records (#2212, runtime half)', () => {
  const ARN = 'arn:aws:secretsmanager:us-east-1:0:secret:my-secret-AbCdEf';
  const TYPE = 'AWS::SecretsManager::Secret';
  const gen = (len: number): Record<string, unknown> => ({
    Name: 'my-secret',
    GenerateSecretString: { PasswordLength: len, ExcludePunctuation: true },
  });
  /** The value the LAST mutating call actually sent. */
  /** The value the LAST mutating call actually sent -- exactly `len` long. */
  const minted = (
    command: typeof UpdateSecretCommand | typeof CreateSecretCommand,
    len: number
  ): string => {
    const calls = mockSend.mock.calls.filter((c) => c[0] instanceof command);
    const v = (calls.at(-1)![0].input as { SecretString?: string }).SecretString;
    expect(v, 'the priming call must have minted a value').toBeDefined();
    expect(v).toHaveLength(len);
    return v!;
  };
  /**
   * The whole result, BY VALUE, from the inputs alone (round-7 review). A
   * containment check on the JSON closes only the RAW value: a stash that
   * base64s, reverses, hashes, splits or truncates it walks past
   * `not.toContain`, and a raw value carrying `"` or `\\` is escaped by
   * `JSON.stringify` and no longer a substring either (only the fixture's
   * `ExcludePunctuation` hides that). Deep-equality against a literal
   * built from the inputs leaves no slot for any transform to land in.
   */
  /**
   * What `toEqual` cannot see (round-8 review, both measured): a
   * NON-ENUMERABLE own property and a PROTOTYPE-CHAIN property on a bag.
   * Neither reaches any JSON-shaped reader in `src/` today, so they are
   * bounds rather than leaks -- and this closes them anyway: every bag is
   * plain, with no hidden own names, no symbol keys and `Object.prototype`
   * behind it.
   */
  const expectPlainBag = (bag: unknown): void => {
    const x = bag as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(x)).toEqual(Object.keys(x));
    expect(Object.getOwnPropertySymbols(x)).toEqual([]);
    expect(Object.getPrototypeOf(x)).toBe(Object.prototype);
  };
  const skipResult = (effective: Record<string, unknown>): Record<string, unknown> => ({
    physicalId: ARN,
    wasReplaced: false,
    attributes: { Id: ARN },
    effectiveProperties: effective,
  });
  let provider: SecretsManagerSecretProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ ARN });
    provider = new SecretsManagerSecretProvider();
  });

  it('neither bag handed to update() is mutated', async () => {
    const next = gen(32);
    const previous = gen(16);
    await provider.update('L', ARN, TYPE, next, previous);
    minted(UpdateSecretCommand, 32);
    expect(next).toEqual(gen(32));
    expect(previous).toEqual(gen(16));
  });

  it.each([
    ['USABLE', (): Record<string, unknown> => gen(32), (): Record<string, unknown> => gen(32)],
    [
      'ABSENT',
      (): Record<string, unknown> => ({ Name: 'my-secret', SecretString: 'lit' }),
      (): Record<string, unknown> => ({ Name: 'my-secret' }),
    ],
  ])(
    'a later SKIP with a %s previous block is built from its inputs alone (value minted by an earlier update())',
    async (_l, previous, expectedEffective) => {
      await provider.update('L', ARN, TYPE, gen(32), gen(16)); // prime: mints
      const v = minted(UpdateSecretCommand, 32);
      const desired = { ...gen(32), GenerateSecretString: 'bad' };
      const prev = previous();
      const result = await provider.update('L', ARN, TYPE, desired, prev, STATE_REPLAY);
      expect(result).toEqual(skipResult(expectedEffective()));
      expect(desired).toEqual({ Name: 'my-secret', GenerateSecretString: 'bad' });
      expect(prev).toEqual(previous());
      for (const bag of [desired, prev, result.effectiveProperties]) expectPlainBag(bag);
      // Documentation of the older, weaker form -- the deep-equal above is
      // what closes the class.
      expect(JSON.stringify(result)).not.toContain(v);
    }
  );

  it.each([
    ['the SAME logical id', 'A'],
    ['a DIFFERENT logical id', 'B'],
  ])(
    'a SKIP on %s is built from its inputs alone (value minted by create() first)',
    async (_l, id) => {
      // `create` then `update` on one id is the ordinary deploy sequence, and
      // a stash keyed by logical id leaks only there (round-7 review).
      await provider.create('A', TYPE, gen(32)); // prime: mints
      const v = minted(CreateSecretCommand, 32);
      const desired = { ...gen(32), GenerateSecretString: 'bad' };
      const prev = gen(32);
      const result = await provider.update(id, ARN, TYPE, desired, prev, STATE_REPLAY);
      expect(result).toEqual(skipResult(gen(32)));
      expect(desired).toEqual({ Name: 'my-secret', GenerateSecretString: 'bad' });
      expect(prev).toEqual(gen(32));
      for (const bag of [desired, prev, result.effectiveProperties]) expectPlainBag(bag);
      expect(JSON.stringify(result)).not.toContain(v);
    }
  );
});

/**
 * Issue #3740 (the #3728 shape): a CHANGED, malformed `GenerateSecretString`
 * is template-borne on a template-path update and one template edit repairs
 * it, so `update()` REFUSES it before `UpdateSecret`. The state-borne callers
 * keep the warn-skip above, which leaves the live value untouched.
 */
describe('SecretsManagerSecretProvider malformed GenerateSecretString: template refuses, replay warns', () => {
  let provider: SecretsManagerSecretProvider;
  const block = {
    SecretStringTemplate: '{"username":"admin"}',
    GenerateStringKey: 'password',
    PasswordLength: 32,
  };
  const bag = (generate: unknown): Record<string, unknown> => ({
    Name: 'my-secret',
    Description: 'app secret',
    GenerateSecretString: generate,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SecretsManagerSecretProvider();
  });

  it.each([
    ['no context', undefined],
    ['both flags false', { replayingState: false, desiredFromAwsReadback: false }],
  ])('REFUSES on a template-path update (%s), before any AWS call', async (_label, context) => {
    for (const malformed of [{ Ref: 'GenConfig' }, { ...block, PasswordLength: 'abc' }]) {
      mockSend.mockClear();
      childLogger.warn.mockClear();
      const error = await provider
        .update('L', SECRET_ARN, TYPE, bag(malformed), bag(block), context)
        .catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/^AWS::SecretsManager::Secret GenerateSecretString/);
      expect((error as Error).message).toMatch(
        /Nothing was applied to secret L; fix the template value$/
      );
      expect((error as Error).message).not.toMatch(/Failed to update secret/);
      expect(mockSend).not.toHaveBeenCalled();
      expect(childLogger.warn).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['a rollback revert arm (replayingState)', { replayingState: true }],
    ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
  ])('keeps the warn-skip on %s', async (_label, context) => {
    await provider.update('L', SECRET_ARN, TYPE, bag({ Ref: 'GenConfig' }), bag(block), context);

    expect(updateInput().SecretString).toBeUndefined();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No new secret value is generated')
    );
  });

  it('a state-borne literal refusal is not told to fix the template', async () => {
    const error = await provider
      .update(
        'L',
        SECRET_ARN,
        TYPE,
        { Name: 'my-secret', SecretString: 42 },
        { Name: 'my-secret', SecretString: 'lit' },
        { replayingState: true }
      )
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^Failed to update secret L: /);
    expect((error as Error).message).not.toMatch(/fix the template value/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does NOT refuse an UNCHANGED malformed block on the template path (no value is sent for it)', async () => {
    const same = bag({ Ref: 'GenConfig' });
    await provider.update('L', SECRET_ARN, TYPE, { ...same, Description: 'x' }, same);

    expect(updateInput().SecretString).toBeUndefined();
    expect(childLogger.warn).not.toHaveBeenCalled();
  });
});
