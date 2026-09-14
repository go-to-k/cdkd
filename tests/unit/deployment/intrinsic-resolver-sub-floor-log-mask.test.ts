/**
 * Issue [#3100](https://github.com/go-to-k/cdkd/issues/3100): the resolver's
 * `Resolved Fn::Join:` / `Resolved Fn::Sub:` debug lines printed a 1-3
 * character secret embedded in a longer string.
 *
 * `maskSecretsForLog` is a NEEDLE mask, and a needle shorter than
 * `MIN_NEEDLE_LENGTH` (4) is matched only as the WHOLE text, so `port:` + a
 * two-character secret reached `--verbose` output as `port:q7`. The floor is
 * deliberate and stays; the fix builds a LOG TWIN of the value at the writes
 * that put a secret into it (`LogTwin` in the resolver), and logs the twin.
 *
 * WHAT EACH CASE PINS, per the issue's verification plan: the three spellings
 * (an `Fn::Join` whose token is complete only after assembly, an `Fn::Sub` of
 * the same, an `Fn::Sub` whose variable is itself a reference), the LITERAL
 * negative (a part equal to the recorded value that no resolution wrote stays
 * printed), and one case per arm that writes the twin, so dropping any single
 * write reddens something: the cache-hit arm, a Join part and a Sub variable
 * that are intrinsics, a Join part that is itself an `Fn::Sub` (the pass
 * registry), and the `Ref` arm of a Sub placeholder over an inherited secret.
 * The region-pinned sibling arm is pinned in
 * `intrinsic-resolver-assembled-secret-region.test.ts`, which carries the
 * region-observable client fakes it needs.
 *
 * Every line is asserted WHOLE (`Resolved Fn::Join: port:***`), so a
 * regression that masks everything cannot pass, and the resolved VALUE is
 * asserted too, so a twin that leaked into the value cannot either.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const SECRET_ID = 'cdkd-sub-floor-log-probe';

/** The sub-floor secret under test: two characters, below `MIN_NEEDLE_LENGTH`. */
const PIN = 'q7';

/** A value no case records: the control for pass-through. */
const UNRECORDED = 'k9';

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: logSpies.debug,
    info: logSpies.info,
    warn: logSpies.warn,
    error: logSpies.error,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/** A recorded secret of 4+ characters that CONTAINS the pin: a needle the twin's spans can split. */
const DSN = `hostA:${PIN}`;

/** A PUBLIC ssm `String` value: resolved, never recorded, must print. */
const PUBLIC_HOST = 'pb';

const secretSends = vi.hoisted(() => ({ count: 0 }));
/** A delay before the Secrets Manager answer, for the one case that needs the lookup to settle LAST. */
const lookupDelay = vi.hoisted(() => ({ ms: 0 }));
const ssmSends = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async () => {
        ssmSends.count++;
        return { Parameter: { Value: PUBLIC_HOST, Type: 'String' } };
      }),
    },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        secretSends.count++;
        if (lookupDelay.ms > 0) await new Promise((r) => setTimeout(r, lookupDelay.ms));
        if (command.input?.SecretId === SECRET_ID) {
          return { SecretString: JSON.stringify({ pin: PIN, dsn: DSN }) };
        }
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const PIN_REF = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin}}`;

interface Context {
  template: CloudFormationTemplate;
  resources: Record<string, never>;
  stackName: string;
  recordedSecretValues: Map<string, string>;
  parameters?: Record<string, unknown>;
  inheritedSecrets?: Map<string, string>;
}

function freshContext(overrides: Partial<Context> = {}): Context {
  return {
    template: { Resources: {} },
    resources: {},
    stackName: 'SubFloorLogMask',
    recordedSecretValues: new Map<string, string>(),
    ...overrides,
  };
}

/** Every `Resolved Fn::<name>:` debug line, in emission order. */
function resolvedLines(name: 'Join' | 'Sub'): string[] {
  const prefix = `Resolved Fn::${name}: `;
  return logSpies.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(prefix));
}

beforeEach(() => {
  logSpies.debug.mockClear();
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  secretSends.count = 0;
  ssmSends.count = 0;
  lookupDelay.ms = 0;
  resetAccountInfoCache();
});

describe('issue #3100: Resolved Fn::Join / Fn::Sub lines mask a sub-floor secret by position', () => {
  it('an Fn::Join whose token is complete only after assembly (the CDK secretValueFromJson shape)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext({
      template: { Parameters: { SecretArn: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
      parameters: { SecretArn: SECRET_ID },
    });
    // No single part is a reference, and the secret id arrives through a
    // `Ref` the way CDK renders it: the token exists only once the parts are
    // joined, so only the final substitution can see the write.
    const value = await resolver.resolve(
      {
        'Fn::Join': [
          '',
          ['port:{{resolve:secretsmanager:', { Ref: 'SecretArn' }, ':SecretString:pin::}}'],
        ],
      },
      ctx as never
    );

    expect(value).toBe(`port:${PIN}`);
    expect(ctx.recordedSecretValues.has(PIN)).toBe(true);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***']);
  });

  it('an Fn::Sub whose body is the same assembled reference', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    const value = await resolver.resolve({ 'Fn::Sub': `port:${PIN_REF}` }, ctx as never);

    expect(value).toBe(`port:${PIN}`);
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: port:***']);
  });

  it('an Fn::Sub whose ${} variable is itself a dynamic reference', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    // The variable resolves on its own, so the substituted body carries no
    // token for the final substitution to find: the variable's write is the
    // only one that saw the secret.
    const value = await resolver.resolve(
      { 'Fn::Sub': ['port:${Pin}', { Pin: PIN_REF }] },
      ctx as never
    );

    expect(value).toBe(`port:${PIN}`);
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: port:***']);
  });

  it('a Join part that is WHOLE a reference is masked where it was written', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    const value = await resolver.resolve({ 'Fn::Join': [':', ['port', PIN_REF]] }, ctx as never);

    expect(value).toBe(`port:${PIN}`);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***']);
  });

  it('a LITERAL part equal to the recorded value stays printed (Join part, Sub variable, Sub body)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    // Record the value first, in the same pass, so the negative is not
    // vacuous: a mask keyed on the bag alone WOULD fire on these literals.
    await resolver.resolve({ 'Fn::Sub': `seed:${PIN_REF}` }, ctx as never);
    expect(ctx.recordedSecretValues.has(PIN)).toBe(true);
    logSpies.debug.mockClear();

    await resolver.resolve({ 'Fn::Join': [':', ['port', PIN]] }, ctx as never);
    await resolver.resolve({ 'Fn::Sub': ['port:${Pin}', { Pin: PIN }] }, ctx as never);
    await resolver.resolve({ 'Fn::Sub': `port:${PIN}` }, ctx as never);

    expect(resolvedLines('Join')).toEqual([`Resolved Fn::Join: port:${PIN}`]);
    expect(resolvedLines('Sub')).toEqual([`Resolved Fn::Sub: port:${PIN}`, `Resolved Fn::Sub: port:${PIN}`]);
  });

  it('an INTRINSIC part or variable is a resolution product: masked whole when recorded, verbatim when not', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    await resolver.resolve({ 'Fn::Sub': `seed:${PIN_REF}` }, ctx as never);
    logSpies.debug.mockClear();

    await resolver.resolve(
      { 'Fn::Join': [':', ['port', { 'Fn::Select': [0, [PIN]] }]] },
      ctx as never
    );
    await resolver.resolve(
      { 'Fn::Join': [':', ['port', { 'Fn::Select': [0, [UNRECORDED]] }]] },
      ctx as never
    );
    await resolver.resolve(
      { 'Fn::Sub': ['port:${Pin}', { Pin: { 'Fn::Select': [0, [PIN]] } }] },
      ctx as never
    );
    await resolver.resolve(
      { 'Fn::Sub': ['port:${Pin}', { Pin: { 'Fn::Select': [0, [UNRECORDED]] } }] },
      ctx as never
    );

    expect(resolvedLines('Join')).toEqual([
      'Resolved Fn::Join: port:***',
      `Resolved Fn::Join: port:${UNRECORDED}`,
    ]);
    expect(resolvedLines('Sub')).toEqual([
      'Resolved Fn::Sub: port:***',
      `Resolved Fn::Sub: port:${UNRECORDED}`,
    ]);
  });

  it('an element of a list an intrinsic RETURNED is a resolution product too', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    await resolver.resolve({ 'Fn::Sub': `seed:${PIN_REF}` }, ctx as never);
    logSpies.debug.mockClear();

    const value = await resolver.resolve(
      { 'Fn::Join': [':', { 'Fn::Split': [',', `port,${PIN}`] }] },
      ctx as never
    );

    expect(value).toBe(`port:${PIN}`);
    // `port` is not recorded and stays; the element equal to the secret was
    // produced by `Fn::Split`, not spelled as a part.
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***']);
  });

  it('a Join part that is itself an Fn::Sub keeps the inner write’s mask on the OUTER line', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    // The outer part's value `port:q7` is neither whole a secret nor a token:
    // only the inner Sub's registered twin knows where the secret sits.
    const value = await resolver.resolve(
      { 'Fn::Join': ['', ['conn-', { 'Fn::Sub': `port:${PIN_REF}` }]] },
      ctx as never
    );

    expect(value).toBe(`conn-port:${PIN}`);
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: port:***']);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: conn-port:***']);
  });

  it('an Fn::Sub variable that is itself an Fn::Join keeps the inner write’s mask', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    const value = await resolver.resolve(
      {
        'Fn::Sub': [
          'conn-${Port}',
          {
            Port: {
              'Fn::Join': ['', ['port:{{resolve:secretsmanager:', SECRET_ID, ':SecretString:pin}}']],
            },
          },
        ],
      },
      ctx as never
    );

    expect(value).toBe(`conn-port:${PIN}`);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***']);
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: conn-port:***']);
  });

  it('a Join whose result carries no token still registers its mask for an enclosing Sub', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    // The Join's mask comes from its inner Sub part, so the Join's own result
    // never reaches a dynamic-reference substitution: only the Join itself can
    // register `conn-port:q7` -> `conn-port:***` for the outer placeholder.
    const value = await resolver.resolve(
      {
        'Fn::Sub': [
          'x-${Conn}',
          { Conn: { 'Fn::Join': ['', ['conn-', { 'Fn::Sub': `port:${PIN_REF}` }]] } },
        ],
      },
      ctx as never
    );

    expect(value).toBe(`x-conn-port:${PIN}`);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: conn-port:***']);
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: port:***', 'Resolved Fn::Sub: x-conn-port:***']);
  });

  it('the pass registry is scoped to its bag: another pass does not inherit a twin', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const first = freshContext();
    await resolver.resolve({ 'Fn::Sub': `port:${PIN_REF}` }, first as never);
    logSpies.debug.mockClear();

    // A second pass with its own bag, producing the same string through a
    // literal-only intrinsic: nothing in THIS pass wrote a secret into it.
    const second = freshContext();
    await resolver.resolve(
      { 'Fn::Join': ['', ['conn-', { 'Fn::Select': [0, [`port:${PIN}`]] }]] },
      second as never
    );

    expect(resolvedLines('Join')).toEqual([`Resolved Fn::Join: conn-port:${PIN}`]);
  });

  it('a PUBLIC ssm value stays printed on the fresh-lookup AND the cache-hit arm', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    const join = (): unknown => ({
      'Fn::Join': ['', ['host:{{resolve:ssm:', 'app-host', '}}']],
    });

    await resolver.resolve(join(), ctx as never);
    await resolver.resolve(join(), ctx as never);

    // One lookup: the second resolution took the cache-hit arm.
    expect(ssmSends.count).toBe(1);
    expect(ctx.recordedSecretValues.has(PUBLIC_HOST)).toBe(false);
    expect(resolvedLines('Join')).toEqual([
      `Resolved Fn::Join: host:${PUBLIC_HOST}`,
      `Resolved Fn::Join: host:${PUBLIC_HOST}`,
    ]);
  });

  it('a later unmasked string equal to an earlier masked one does not replace its mask', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    // `A` registers `port:q7` masked; `B`, resolved AFTER it, is a literal
    // Sub producing the same string with nothing masked.
    await resolver.resolve(
      {
        'Fn::Sub': [
          'outer:${A}',
          { A: { 'Fn::Sub': `port:${PIN_REF}` }, B: { 'Fn::Sub': `port:${PIN}` } },
        ],
      },
      ctx as never
    );

    expect(resolvedLines('Sub')).toEqual([
      'Resolved Fn::Sub: port:***',
      `Resolved Fn::Sub: port:${PIN}`,
      'Resolved Fn::Sub: outer:port:***',
    ]);
  });

  it('a Join product is checked after the drain, not before a sibling part records the secret', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    // The lookup is held back so it settles AFTER `Fn::Select`: checked on
    // settle, the Select part would find an empty bag.
    lookupDelay.ms = 25;
    const value = await resolver.resolve(
      { 'Fn::Join': [':', ['port', { 'Fn::Select': [0, [PIN]] }, PIN_REF]] },
      ctx as never
    );

    expect(value).toBe(`port:${PIN}:${PIN}`);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***:***']);
  });

  it('a reference-bearing string reached through another intrinsic keeps its mask on the outer line', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    const value = await resolver.resolve(
      { 'Fn::Join': ['', ['conn-', { 'Fn::Select': [0, [`port:${PIN_REF}`]] }]] },
      ctx as never
    );

    expect(value).toBe(`conn-port:${PIN}`);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: conn-port:***']);
  });

  it('a string resolved by a DIRECT resolveDynamicReferences call registers its mask (any route, e.g. a cross-stack re-resolution)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    // The public method is what `reresolveCrossStackValue`, `cdkd scrub` and
    // `drift` call; none of them goes through `resolveValue`.
    const imported = await resolver.resolveDynamicReferences(`port:${PIN_REF}`, ctx as never);
    expect(imported).toBe(`port:${PIN}`);

    // A product equal to that string, reached with no reference of its own.
    await resolver.resolve(
      { 'Fn::Join': ['', ['outer:', { 'Fn::Select': [0, [imported]] }]] },
      ctx as never
    );

    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: outer:port:***']);
  });

  it('a nested mask survives with only an INHERITED bag (the registry keys on it)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { recordedSecretValues: _none, ...ctx } = freshContext({
      template: { Parameters: { Pin: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
      parameters: { Pin: PIN },
      inheritedSecrets: new Map<string, string>([[PIN, PIN_REF]]),
    });

    const value = await resolver.resolve(
      { 'Fn::Join': ['', ['outer:', { 'Fn::Sub': 'port:${Pin}' }]] },
      ctx as never
    );

    expect(value).toBe(`outer:port:${PIN}`);
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: port:***']);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: outer:port:***']);
  });

  it('a 4+ character recorded secret the twin would split masks the whole line', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    await resolver.resolve(`{{resolve:secretsmanager:${SECRET_ID}:SecretString:dsn}}`, ctx as never);
    expect(ctx.recordedSecretValues.has(DSN)).toBe(true);
    logSpies.debug.mockClear();

    // The value IS the recorded `hostA:q7`; the twin `hostA:***` no longer
    // contains that needle, so masking the twin alone would print `hostA:`.
    const value = await resolver.resolve({ 'Fn::Join': ['', ['hostA:', PIN_REF]] }, ctx as never);

    expect(value).toBe(DSN);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: ***']);
  });

  it('two DIFFERENT masked twins for one string mask it whole (their spans cannot be merged)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext({
      template: { Parameters: { Pin: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
      parameters: { Pin: PIN },
      inheritedSecrets: new Map<string, string>([[PIN, PIN_REF]]),
    });
    // `A` masks the FIRST q7 of `q7:q7`, `B` the SECOND; each keeps the other
    // as template text. Last-write-wins would give the outer line `B`'s twin,
    // printing the q7 `A` wrote.
    await resolver.resolve(
      {
        'Fn::Sub': [
          'outer:${A}',
          { A: { 'Fn::Sub': `\${Pin}:${PIN}` }, B: { 'Fn::Sub': `${PIN}:\${Pin}` } },
        ],
      },
      ctx as never
    );

    expect(resolvedLines('Sub')).toEqual([
      `Resolved Fn::Sub: ***:${PIN}`,
      `Resolved Fn::Sub: ${PIN}:***`,
      'Resolved Fn::Sub: outer:***',
    ]);
  });

  describe('a list element that still spells a reference carries its OWN mask', () => {
    const listContext = (items: string): Context =>
      freshContext({
        template: {
          Parameters: { Items: { Type: 'CommaDelimitedList' }, Pin: { Type: 'String' } },
          Resources: {},
        } as CloudFormationTemplate,
        // A resolved list parameter is an ARRAY in the context, as
        // `resolveParameters` coerces a `CommaDelimitedList`.
        parameters: { Items: [items], Pin: PIN },
        inheritedSecrets: new Map<string, string>([[PIN, PIN_REF]]),
      });

    it('keeps it when the registered twin for the same string agrees', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = listContext(`port:${PIN_REF}`);
      // Registers `port:q7` -> `port:***`, the same spans the element masks.
      await resolver.resolve({ 'Fn::Sub': 'port:${Pin}' }, ctx as never);
      logSpies.debug.mockClear();

      const value = await resolver.resolve({ 'Fn::Join': [',', { Ref: 'Items' }] }, ctx as never);

      expect(value).toBe(`port:${PIN}`);
      expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***']);
    });

    it('masks the whole element when the registered twin masks different spans', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = listContext(`${PIN}:${PIN_REF}`);
      // Registers `q7:q7` -> `***:q7`; the element's own write is `q7:***`.
      await resolver.resolve({ 'Fn::Sub': `\${Pin}:${PIN}` }, ctx as never);
      logSpies.debug.mockClear();

      const value = await resolver.resolve({ 'Fn::Join': [',', { Ref: 'Items' }] }, ctx as never);

      expect(value).toBe(`${PIN}:${PIN}`);
      expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: ***']);
    });
  });

  it('Fn::Split pieces keep the source string’s mask, on the Split line and an outer Join', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    const value = await resolver.resolve(
      { 'Fn::Join': ['|', { 'Fn::Split': [',', `port:${PIN_REF},tail`] }] },
      ctx as never
    );

    expect(value).toBe(`port:${PIN}|tail`);
    const splitLines = logSpies.debug.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('Resolved Fn::Split: '));
    expect(splitLines).toEqual(['Resolved Fn::Split: split by "," -> ["port:***","tail"]']);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***|tail']);
  });

  it('Fn::Split masks every piece when the source and its twin split into different counts', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    // The secret `hostA:q7` carries the delimiter: the value splits into three
    // pieces, its twin `x:***` into two, so no piece can be paired.
    const value = await resolver.resolve(
      {
        'Fn::Join': [
          '|',
          { 'Fn::Split': [':', `x:{{resolve:secretsmanager:${SECRET_ID}:SecretString:dsn}}`] },
        ],
      },
      ctx as never
    );

    expect(value).toBe(`x|hostA|${PIN}`);
    const splitLines = logSpies.debug.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('Resolved Fn::Split: '));
    expect(splitLines).toEqual(['Resolved Fn::Split: split by ":" -> ["***","***","***"]']);
    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: ***|***|***']);
  });

  it('a Split piece whose twin splits a 4+ character inherited secret is masked whole', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext({ inheritedSecrets: new Map<string, string>([[DSN, 'expr']]) });
    // The SOURCE `hostA:q7,x` is not itself a secret, so the whole-source arm
    // stays out of it; its registered twin `hostA:***,x` pairs the piece
    // `hostA:q7` with `hostA:***`, which would print the part of the inherited
    // secret outside the pin's span without the per-piece guard.
    await resolver.resolve(
      { 'Fn::Split': [',', { 'Fn::Sub': `hostA:${PIN_REF},x` }] },
      ctx as never
    );

    const splitLines = logSpies.debug.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('Resolved Fn::Split: '));
    expect(splitLines).toEqual(['Resolved Fn::Split: split by "," -> ["***","x"]']);
  });

  describe('a LIST stringified into a Join part or a Sub placeholder keeps its elements’ masks', () => {
    it('a Sub variable that is an Fn::Split list', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext();
      const value = await resolver.resolve(
        { 'Fn::Sub': ['port:${P}', { P: { 'Fn::Split': ['|', `${PIN_REF}|tail`] } }] },
        ctx as never
      );

      expect(value).toBe(`port:${PIN},tail`);
      expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: port:***,tail']);
    });

    it('a Join part that is an Fn::Split list', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext();
      const value = await resolver.resolve(
        { 'Fn::Join': [':', ['port', { 'Fn::Split': ['|', `${PIN_REF}|tail`] }]] },
        ctx as never
      );

      expect(value).toBe(`port:${PIN},tail`);
      expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***,tail']);
    });

    it('a list-valued GetAtt placeholder', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext({
        template: { Resources: { Db: { Type: 'Custom::PinHolder' } } } as CloudFormationTemplate,
        resources: {
          Db: {
            physicalId: 'db-physical-1',
            resourceType: 'Custom::PinHolder',
            properties: {},
            // A `null` element renders as the empty string, as `String()` of
            // the list does, so the twin stays aligned with the value.
            attributes: { Pins: [PIN, UNRECORDED, null] },
          },
        } as never,
      });
      await resolver.resolve({ 'Fn::Sub': `seed:${PIN_REF}` }, ctx as never);
      logSpies.debug.mockClear();

      const value = await resolver.resolve({ 'Fn::Sub': 'port:${Db.Pins}' }, ctx as never);

      expect(value).toBe(`port:${PIN},${UNRECORDED},`);
      expect(resolvedLines('Sub')).toEqual([`Resolved Fn::Sub: port:***,${UNRECORDED},`]);
    });
  });

  describe('leaf-masked lines take the registered mask too (maintainer review M1-M3)', () => {
    const debugLines = (prefix: string): string[] =>
      logSpies.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(prefix));

    it('M1: a Resolved Fn::Select line over the Fn.select(n, Fn.split(...)) idiom', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext();
      const value = await resolver.resolve(
        {
          'Fn::Select': [
            0,
            { 'Fn::Split': [',', { 'Fn::Join': ['', ['port:', PIN_REF, ',x']] }] },
          ],
        },
        ctx as never
      );

      expect(value).toBe(`port:${PIN}`);
      expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: port:***,x']);
      expect(debugLines('Resolved Fn::Split: ')).toEqual([
        'Resolved Fn::Split: split by "," -> ["port:***","x"]',
      ]);
      expect(debugLines('Resolved Fn::Select: ')).toEqual([
        'Resolved Fn::Select: index 0 -> "port:***"',
      ]);
    });

    it('M1: a Resolved Fn::Select line picking one piece of a split secret', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext();
      const value = await resolver.resolve(
        {
          'Fn::Select': [
            1,
            { 'Fn::Split': [':', `{{resolve:secretsmanager:${SECRET_ID}:SecretString:dsn}}`] },
          ],
        },
        ctx as never
      );

      expect(value).toBe(PIN);
      expect(debugLines('Resolved Fn::Select: ')).toEqual(['Resolved Fn::Select: index 1 -> "***"']);
    });

    it('M1: a leaf whose registered twin splits a 4+ character secret it still holds is masked whole', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext();
      await resolver.resolve(`{{resolve:secretsmanager:${SECRET_ID}:SecretString:dsn}}`, ctx as never);
      logSpies.debug.mockClear();

      // The Join registers `x-hostA:q7` -> `x-hostA:***`, which no longer holds
      // the recorded `hostA:q7` as a needle; the Select line must not print
      // the part of it outside the pin's span.
      const value = await resolver.resolve(
        { 'Fn::Select': [0, [{ 'Fn::Join': ['', ['x-hostA:', PIN_REF]] }]] },
        ctx as never
      );

      expect(value).toBe(`x-${DSN}`);
      expect(debugLines('Resolved Fn::Select: ')).toEqual(['Resolved Fn::Select: index 0 -> "***"']);
    });

    it('a THROWN message that interpolates a value through the leaf mask takes the position mask too', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext();
      // `Fn::Cidr` refuses a non-string ip block and names the resolved value.
      const thrown = await resolver
        .resolve({ 'Fn::Cidr': [[{ 'Fn::Join': ['', ['port:', PIN_REF]] }], 1, 8] }, ctx as never)
        .then(
          () => undefined,
          (error: unknown) => error
        );

      expect(thrown, 'the Fn::Cidr argument refusal must actually throw').toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain('port:***');
      expect(message).not.toContain(`port:${PIN}`);
    });

    it('M2: Fn::Split over a source that IS an inherited secret masks every piece', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext({
        template: { Parameters: { Pair: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
        parameters: { Pair: 'ab:cd' },
        inheritedSecrets: new Map<string, string>([['ab:cd', 'expr']]),
      });

      const value = await resolver.resolve(
        { 'Fn::Join': ['/', { 'Fn::Split': [':', { Ref: 'Pair' }] }] },
        ctx as never
      );

      expect(value).toBe('ab/cd');
      expect(debugLines('Resolved Fn::Split: ')).toEqual([
        'Resolved Fn::Split: split by ":" -> ["***","***"]',
      ]);
      expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: ***/***']);
    });

    it('M2: the whole-source arm answers from the INHERITED bag alone (no recorded bag, nothing registered)', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const { recordedSecretValues: _none, ...ctx } = freshContext({
        template: { Parameters: { Pair: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
        parameters: { Pair: 'ab:cd' },
        inheritedSecrets: new Map<string, string>([['ab:cd', 'expr']]),
      });

      await resolver.resolve({ 'Fn::Split': [':', { Ref: 'Pair' }] }, ctx as never);

      expect(debugLines('Resolved Fn::Split: ')).toEqual([
        'Resolved Fn::Split: split by ":" -> ["***","***"]',
      ]);
    });

    it('M2: the whole-source arm answers from the RECORDED bag alone (no inherited bag, nothing registered)', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext({
        template: { Resources: { Db: { Type: 'Custom::PairHolder' } } } as CloudFormationTemplate,
        resources: {
          Db: {
            physicalId: 'db-physical-1',
            resourceType: 'Custom::PairHolder',
            properties: {},
            attributes: { Pair: 'ab:cd' },
          },
        } as never,
      });
      // Recorded directly, not by resolving a reference, so no twin is
      // registered for `ab:cd` and only the recorded bag can answer.
      ctx.recordedSecretValues.set('ab:cd', 'expr');

      await resolver.resolve({ 'Fn::Split': [':', { 'Fn::GetAtt': ['Db', 'Pair'] }] }, ctx as never);

      expect(debugLines('Resolved Fn::Split: ')).toEqual([
        'Resolved Fn::Split: split by ":" -> ["***","***"]',
      ]);
    });

    it('M3: a Resolved Fn::Base64 line masks its input by position and its encoding whole', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext();
      const value = await resolver.resolve(
        { 'Fn::Base64': { 'Fn::Join': ['', ['port:', PIN_REF]] } },
        ctx as never
      );

      expect(value).toBe(Buffer.from(`port:${PIN}`).toString('base64'));
      expect(debugLines('Resolved Fn::Base64: ')).toEqual(['Resolved Fn::Base64: port:*** -> ***']);
    });

    it('M3 control: a Base64 input no write masked prints with its encoding', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const ctx = freshContext();
      await resolver.resolve({ 'Fn::Base64': 'plain-text' }, ctx as never);

      expect(debugLines('Resolved Fn::Base64: ')).toEqual([
        `Resolved Fn::Base64: plain-text -> ${Buffer.from('plain-text').toString('base64')}`,
      ]);
    });
  });

  it('M4: the Sub arms no secret can reach (pseudo parameter, escape, empty placeholder) keep their text', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    const value = await resolver.resolve({ 'Fn::Sub': 'r:${AWS::Region}:${!Lit}:${}' }, ctx as never);

    expect(value).toBe('r:us-east-1:${Lit}:${}');
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: r:us-east-1:${Lit}:${}']);
    // The empty `${}` takes its OWN arm: skipping it falls through to a failed
    // `Ref` that keeps the same text but warns, so no warning pins the arm.
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it('with no twin write, a 4+ character needle still masks only its own span', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    await resolver.resolve(`{{resolve:secretsmanager:${SECRET_ID}:SecretString:dsn}}`, ctx as never);
    logSpies.debug.mockClear();

    await resolver.resolve({ 'Fn::Join': ['', ['x-', DSN, '-y']] }, ctx as never);

    expect(resolvedLines('Join')).toEqual(['Resolved Fn::Join: x-***-y']);
  });

  it('the cache-hit arm writes the twin too (a second resolution of the same token in the pass)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext();
    const join = (): unknown => ({
      'Fn::Join': ['', ['port:{{resolve:secretsmanager:', SECRET_ID, ':SecretString:pin}}']],
    });

    await resolver.resolve(join(), ctx as never);
    await resolver.resolve(join(), ctx as never);

    // One lookup: the second resolution took the cache-hit arm.
    expect(secretSends.count).toBe(1);
    expect(resolvedLines('Join')).toEqual([
      'Resolved Fn::Join: port:***',
      'Resolved Fn::Join: port:***',
    ]);
  });

  it("an Fn::Sub placeholder's GetAtt to a stored attribute holding a recorded secret is masked", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = freshContext({
      template: { Resources: { Db: { Type: 'Custom::PinHolder' } } } as CloudFormationTemplate,
      resources: {
        Db: {
          physicalId: 'db-physical-1',
          resourceType: 'Custom::PinHolder',
          properties: {},
          attributes: { Pin: PIN, Label: UNRECORDED },
        },
      } as never,
    });
    await resolver.resolve({ 'Fn::Sub': `seed:${PIN_REF}` }, ctx as never);
    logSpies.debug.mockClear();

    const value = await resolver.resolve({ 'Fn::Sub': 'port:${Db.Pin}' }, ctx as never);
    await resolver.resolve({ 'Fn::Sub': 'port:${Db.Label}' }, ctx as never);

    expect(value).toBe(`port:${PIN}`);
    expect(resolvedLines('Sub')).toEqual([
      'Resolved Fn::Sub: port:***',
      `Resolved Fn::Sub: port:${UNRECORDED}`,
    ]);
  });

  it('an inherited secret is masked with NO recorded bag at all (the inherited arm alone)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    // No `recordedSecretValues`: the Ref cannot copy the pair across, so only
    // the inherited bag can answer.
    const { recordedSecretValues: _none, ...ctx } = freshContext({
      template: { Parameters: { Pin: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
      parameters: { Pin: PIN },
      inheritedSecrets: new Map<string, string>([[PIN, PIN_REF]]),
    });

    const value = await resolver.resolve({ 'Fn::Sub': 'port:${Pin}' }, ctx as never);

    expect(value).toBe(`port:${PIN}`);
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: port:***']);
  });

  it("an Fn::Sub placeholder's Ref to a parameter holding an inherited secret is masked", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const inherited = new Map<string, string>([[PIN, PIN_REF]]);
    const ctx = freshContext({
      template: { Parameters: { Pin: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
      parameters: { Pin: PIN },
      inheritedSecrets: inherited,
    });

    const value = await resolver.resolve({ 'Fn::Sub': 'port:${Pin}' }, ctx as never);

    expect(value).toBe(`port:${PIN}`);
    expect(resolvedLines('Sub')).toEqual(['Resolved Fn::Sub: port:***']);
  });
});
