import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  SECRET_MASK,
  createSecretMasker,
  hasMaskableValues,
  maskSecretsInText,
  recordLogOnlyValue,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// go-to-k/cdkd#1998, the RESOLVER half: a `Ref` (or `Fn::Sub` variable) serving
// a `NoEcho: true` parameter records the value as a LOG-ONLY needle of the
// pass's bag, and the resolver's own lines mask it, while nothing the pass
// PERSISTS or DECIDES moves.
const debugSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: debugSpy, info: vi.fn(), warn: warnSpy, error: vi.fn() }),
  }),
}));
const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: ssmSend },
  }),
}));

const NOECHO = 'hunter2-noecho-password';
const PUBLIC = 'visible-public-value';
const OTHER_SECRET = 'an-unrelated-recorded-secret';
const OTHER_EXPR = '{{resolve:secretsmanager:other:SecretString:k::}}';

function logLines(): string {
  return [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join('\n');
}

function template(noEcho: boolean, extra: Record<string, unknown> = {}): CloudFormationTemplate {
  return {
    Parameters: {
      Secret: { Type: 'String', NoEcho: noEcho },
      Plain: { Type: 'String' },
      ...extra,
    },
    Resources: {},
  };
}

function context(
  noEcho: boolean,
  bag: RecordedSecretValues,
  extra: Partial<ResolverContext> = {}
): ResolverContext {
  return {
    template: template(noEcho),
    resources: {},
    parameters: { Secret: NOECHO, Plain: PUBLIC },
    recordedSecretValues: bag,
    ...extra,
  };
}

describe('Ref to a NoEcho parameter records a log-only needle (go-to-k/cdkd#1998)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new IntrinsicFunctionResolver();
  });

  it('feeds the masker built from the pass bag, with no map entry', async () => {
    const bag: RecordedSecretValues = new Map();
    const mask = createSecretMasker(bag);
    expect(await resolver.resolve({ Ref: 'Secret' }, context(true, bag))).toBe(NOECHO);
    expect(bag.size).toBe(0);
    expect(mask(`AWS rejected '${NOECHO}'`)).toBe(`AWS rejected '${SECRET_MASK}'`);
  });

  it('records through an Fn::Sub variable too', async () => {
    const bag: RecordedSecretValues = new Map();
    const value = await resolver.resolve({ 'Fn::Sub': 'user:${Secret}@host' }, context(true, bag));
    expect(value).toBe(`user:${NOECHO}@host`);
    expect(maskSecretsInText(String(value), bag)).toBe(`user:${SECRET_MASK}@host`);
  });

  it('does not record a parameter that is not NoEcho', async () => {
    const bag: RecordedSecretValues = new Map();
    await resolver.resolve({ Ref: 'Secret' }, context(false, bag));
    await resolver.resolve({ Ref: 'Plain' }, context(true, bag));
    expect(hasMaskableValues(bag)).toBe(false);
  });

  it('records every spelling of a list and a number value', async () => {
    const bag: RecordedSecretValues = new Map();
    const ctx: ResolverContext = {
      template: {
        Parameters: {
          Pins: { Type: 'CommaDelimitedList', NoEcho: true },
          Port: { Type: 'Number', NoEcho: true },
        },
        Resources: {},
      },
      resources: {},
      parameters: { Pins: ['alpha-pin', 'bravo-pin'], Port: 48213 },
      recordedSecretValues: bag,
    };
    await resolver.resolve({ Ref: 'Pins' }, ctx);
    await resolver.resolve({ Ref: 'Port' }, ctx);
    for (const spelling of ['alpha-pin', 'bravo-pin', 'alpha-pin,bravo-pin', '48213']) {
      expect(maskSecretsInText(`x ${spelling} y`, bag)).toBe(`x ${SECRET_MASK} y`);
    }
  });

  it("masks the resolver's own debug lines for an assembled value", async () => {
    const bag: RecordedSecretValues = new Map();
    await resolver.resolve({ 'Fn::Join': ['', ['pw-', { Ref: 'Secret' }, '.end']] }, context(true, bag));
    await resolver.resolve({ 'Fn::Sub': 'u:${Secret}' }, context(true, bag));
    const logs = logLines();
    expect(logs).toContain('Resolved Fn::Join');
    expect(logs).toContain('Resolved Fn::Sub');
    expect(logs).not.toContain(NOECHO);
    // No over-masking of the public text around it. The frame is shell-inert
    // (`pw-` / `.end`), so the line prints the masked value rather than the
    // description a `=` or `;` frame takes (go-to-k/cdkd#4161).
    expect(logs).toContain(`pw-${SECRET_MASK}.end`);
  });

  it("masks the Fn::Base64 encoding in the log, and records it LOG-ONLY", async () => {
    // A recorded secret beside it, so the persist DETECTOR (which skips an
    // empty map) really runs: it must not read the log-only needle.
    const bag: RecordedSecretValues = new Map([[OTHER_SECRET, OTHER_EXPR]]);
    // `pw-`, not `pw=`: an assignment-shaped input is DESCRIBED on the line
    // whether or not the mask worked (go-to-k/cdkd#4161).
    const encoded = Buffer.from(`pw-${NOECHO}`).toString('base64');
    const value = await resolver.resolve(
      { 'Fn::Base64': { 'Fn::Sub': 'pw-${Secret}' } },
      context(true, bag)
    );
    expect(value).toBe(encoded);
    // POSITIVE: the line printed the masked input and the masked encoding,
    // so the negative cannot pass on a description.
    expect(logLines()).toContain('Resolved Fn::Base64: pw-*** resolved to ***');
    expect(logLines()).not.toContain(encoded);
    expect(maskSecretsInText(encoded, bag)).toBe(SECRET_MASK);
    // PERSISTENCE UNCHANGED: the encoding is no map entry, so state keeps it.
    expect(bag.size).toBe(1);
    expect(bag.has(encoded)).toBe(false);
    expect(redactSecretsForState({ UserData: encoded }, bag)).toEqual({ UserData: encoded });
  });

  it('masks a lookup error quoting the value with a bag holding ONLY log-only needles', async () => {
    // The request's name is masked by POSITION regardless; the value quoted
    // on its own is masked only by the bag, which holds no map entry.
    ssmSend.mockRejectedValueOnce(
      Object.assign(new Error(`invalid segment '${NOECHO}' in /app/${NOECHO}`), {
        name: 'ValidationException',
      })
    );
    const bag: RecordedSecretValues = new Map();
    const caught = await resolver
      .resolve({ 'Fn::Sub': '{{resolve:ssm:/app/${Secret}}}' }, context(true, bag))
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(caught).toBeInstanceOf(Error);
    const text = JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
    expect(text).toContain('invalid segment');
    expect(text).not.toContain(NOECHO);
  });

  it('keeps warning, not refusing, an unsupported-service token built from the value', async () => {
    // The refusal's detector reads the RECORDED needles only: a log-only one
    // would turn a deploy that succeeds today into a refusal. A recorded
    // secret beside it, so the detector's empty-map guard is passed.
    const bag: RecordedSecretValues = new Map([[OTHER_SECRET, OTHER_EXPR]]);
    const value = await resolver.resolve(
      { 'Fn::Sub': '{{resolve:unknownsvc:${Secret}}}' },
      context(true, bag)
    );
    expect(value).toBe(`{{resolve:unknownsvc:${NOECHO}}}`);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('Unsupported dynamic reference service');
    expect(warned).not.toContain(NOECHO);
  });
});

describe('a nested child carries the parent log-only needles (go-to-k/cdkd#1998)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new IntrinsicFunctionResolver();
  });

  it('carries a needle into the bag of the child resource consuming the parameter', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const own: RecordedSecretValues = new Map();
    const ctx: ResolverContext = {
      // A CDK-synthesized child parameter never says NoEcho.
      template: { Parameters: { ChildParam: { Type: 'String' } }, Resources: {} },
      resources: {},
      parameters: { ChildParam: `db://${NOECHO}` },
      recordedSecretValues: own,
      inheritedSecrets: inherited,
    };
    await resolver.resolve({ Ref: 'ChildParam' }, ctx);
    expect(maskSecretsInText(`failed: db://${NOECHO}`, own)).toBe(`failed: db://${SECRET_MASK}`);
    expect(own.size).toBe(0);
    expect(logLines()).not.toContain(NOECHO);
  });

  it("keeps the child's persist detector off the parent's log-only needles", async () => {
    // The inherited bag holds a recorded secret too, so the detector's
    // empty-map guard is passed and only the needle class decides.
    const inherited: RecordedSecretValues = new Map([[OTHER_SECRET, OTHER_EXPR]]);
    recordLogOnlyValue(inherited, NOECHO);
    const own: RecordedSecretValues = new Map();
    const encoded = Buffer.from(NOECHO).toString('base64');
    const value = await resolver.resolve(
      { 'Fn::Base64': { Ref: 'ChildParam' } },
      {
        template: { Parameters: { ChildParam: { Type: 'String' } }, Resources: {} },
        resources: {},
        parameters: { ChildParam: NOECHO },
        recordedSecretValues: own,
        inheritedSecrets: inherited,
      }
    );
    expect(value).toBe(encoded);
    expect(own.has(encoded)).toBe(false);
    expect(own.size).toBe(0);
    // POSITIVE: the line printed the masked input and encoding, so the
    // negative cannot pass on a description (the padded encoding of this
    // value is assignment-shaped, go-to-k/cdkd#4161).
    expect(logLines()).toContain('Resolved Fn::Base64: *** resolved to ***');
    expect(logLines()).not.toContain(encoded);
  });

  it('carries a needle a child Number / List<Number> parameter coerced out of a string', async () => {
    // The parent consumed the NoEcho STRING "7391"; the child declares the
    // parameter `Number`, so it arrives here as the number 7391 (and a list
    // one as numbers), which a string-only walk carries nothing for.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, '7391');
    recordLogOnlyValue(inherited, '8642');
    const own: RecordedSecretValues = new Map();
    const ctx: ResolverContext = {
      template: {
        Parameters: { Pin: { Type: 'Number' }, Pins: { Type: 'List<Number>' } },
        Resources: {},
      },
      resources: {},
      parameters: { Pin: 7391, Pins: [1, 8642] },
      recordedSecretValues: own,
      inheritedSecrets: inherited,
    };
    await resolver.resolve({ Ref: 'Pin' }, ctx);
    expect(maskSecretsInText('pin 7391 rejected', own)).toBe(`pin ${SECRET_MASK} rejected`);
    expect(maskSecretsInText('pin 8642 rejected', own)).toBe('pin 8642 rejected');
    await resolver.resolve({ Ref: 'Pins' }, ctx);
    expect(maskSecretsInText('pin 8642 rejected', own)).toBe(`pin ${SECRET_MASK} rejected`);
    expect(own.size).toBe(0);
  });

  it('does not carry a needle the consumed value does not hold', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const own: RecordedSecretValues = new Map();
    await resolver.resolve(
      { Ref: 'ChildParam' },
      {
        template: { Parameters: { ChildParam: { Type: 'String' } }, Resources: {} },
        resources: {},
        parameters: { ChildParam: PUBLIC },
        recordedSecretValues: own,
        inheritedSecrets: inherited,
      }
    );
    expect(hasMaskableValues(own)).toBe(false);
  });

  it("masks the child's --verbose parameter line with a bag holding only log-only needles", async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    await resolver.resolveParameters(
      { Parameters: { ChildParam: { Type: 'String' } }, Resources: {} },
      { ChildParam: NOECHO },
      { inheritedSecrets: inherited }
    );
    const logs = logLines();
    expect(logs).toContain('Parameter ChildParam: using user-provided value');
    expect(logs).not.toContain(NOECHO);
  });

  it("masks the child's Default line, which only the method's own inherited mask reaches", async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    await resolver.resolveParameters(
      { Parameters: { ChildParam: { Type: 'String', Default: NOECHO } }, Resources: {} },
      {},
      { inheritedSecrets: inherited }
    );
    const logs = logLines();
    expect(logs).toContain('Parameter ChildParam: using default value');
    expect(logs).not.toContain(NOECHO);
  });
});

describe('the resolver masks its two bags in ONE pass (go-to-k/cdkd#4049)', () => {
  // The inherited bag holds a SHORTER needle, the pass bag a longer one that
  // embeds it: masked bag by bag (inherited first), the short needle cut the
  // long one and the rest of it printed.
  const SHORT = 'abcd1234';
  const LONG = `XXsecretYY-${SHORT}-ZZtail`;
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new IntrinsicFunctionResolver();
  });

  function ctx(logOnly: boolean): ResolverContext {
    const inherited: RecordedSecretValues = new Map();
    const bag: RecordedSecretValues = new Map();
    if (logOnly) {
      recordLogOnlyValue(inherited, SHORT);
      recordLogOnlyValue(bag, LONG);
    } else {
      inherited.set(SHORT, '{{resolve:ssm-secure:/short}}');
      bag.set(LONG, '{{resolve:ssm-secure:/long}}');
    }
    return {
      template: template(false),
      resources: {},
      parameters: { Secret: NOECHO, Plain: LONG },
      recordedSecretValues: bag,
      inheritedSecrets: inherited,
    };
  }

  it.each([
    ['recorded needles (maskNeedlesForLog)', false],
    ['log-only needles (maskPrintedNeedlesForLog)', true],
  ])('masks a longer value whole in a debug line: %s', async (_label, logOnly) => {
    expect(await resolver.resolve({ Ref: 'Plain' }, ctx(logOnly))).toBe(LONG);
    const lines = logLines();
    expect(lines).toContain('Resolved Ref to parameter: Plain resolved to ');
    expect(lines).not.toContain('XXsecretYY');
    expect(lines).not.toContain('ZZtail');
  });

  it.each([
    ['recorded needles', false],
    ['log-only needles', true],
  ])('masks a longer value whole in a thrown error: %s', (_label, logOnly) => {
    const masked = (
      resolver as unknown as {
        maskNamedError: (e: unknown, x: undefined, c: ResolverContext) => unknown;
      }
    ).maskNamedError(new Error(`could not read ${LONG} here`), undefined, ctx(logOnly));
    expect((masked as Error).message).toBe(`could not read ${SECRET_MASK} here`);
  });
});
