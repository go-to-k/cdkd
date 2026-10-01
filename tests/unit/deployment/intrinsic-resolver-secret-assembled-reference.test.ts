/**
 * Issue [#4166](https://github.com/go-to-k/cdkd/issues/4166): a secret
 * substituted into the NAME of a resolvable `{{resolve:...}}` token
 * (`{{resolve:ssm:/app/${Name}}}` with `Name` a secret) made the resolver
 * record the assembled token as the expression of the token's own plaintext,
 * and every state writer then persisted that expression, with `Name`'s
 * plaintext inside it. The resolver now refuses such a token once it has
 * resolved to a secret, before anything is recorded or cached.
 *
 * Every case drives the REAL resolver. A case that resolves persists through
 * `redactSecretsForState`, as the deploy engine does: resolve the properties
 * into the resource's bag, then redact a marked copy against that bag. A
 * refused case stops before that: the issue's rows are named by the state
 * writer that persisted each shape on `origin/main`, where each resolved.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  clearRecordedSecretExpressions,
  maskRecordedSecretsInText,
  inheritNestedStackParameterAssociations,
  isRecordedSecretExpression,
  markSameGenerationBag,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/** The secret `Name`: inherited, above the needle floor. */
const NAME = 'pinname-long';
/** A second secret name, whose parameter holds an above-floor value. */
const BIG_NAME = 'bigname-long';
const BIG_VALUE = 'abovefloor-value';
/**
 * A SUB-FLOOR secret name a Secrets Manager token resolves to: the needle
 * mask cannot see it, so only the log twin shows the token was assembled.
 */
const SHORT_NAME = 'zq';
const SECRET_ID = 'cdkd-secret-assembled-reference-probe';

const REFUSAL_TAIL =
  'the reference was assembled from a secret value and resolves to a secret, so recording it ' +
  'would write that value into state inside the reference. Build the reference name from ' +
  'non-secret values.';

/** How many SSM lookups reached the SDK. */
const ssmCalls = vi.hoisted(() => ({ count: 0 }));

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

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        ssmCalls.count += 1;
        const name = command.input?.Name;
        // An EMPTY secret: its result records nothing, so it is not refused.
        if (name === `/empty/${NAME}`) return { Parameter: { Value: '', Type: 'SecureString' } };
        // The ARN form a region-pinned token sends (resolved by a sibling).
        // `crnoechovalue`: a custom resource's NoEcho `Data` value.
        if (name === '/app/crnoechovalue' || name === `/app/${NAME}` || name === `/app/${SHORT_NAME}` || name?.endsWith(`:parameter/app/${NAME}`)) return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        if (name === `/app/${BIG_NAME}`) return { Parameter: { Value: BIG_VALUE, Type: 'SecureString' } };
        // A PUBLIC parameter named by the secret: its result records nothing.
        if (name === `/pub/${NAME}`) return { Parameter: { Value: 'public-value', Type: 'String' } };
        const notFound = new Error(`ParameterNotFound: ${String(name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        if (command.input?.SecretId === SECRET_ID) return { SecretString: JSON.stringify({ name: SHORT_NAME }) };
        // Review M0: a secret whose `username` is a substring of its own id.
        if (command.input?.SecretId === 'myapp-db') {
          return { SecretString: JSON.stringify({ username: 'myapp', password: 'db-password-value' }) };
        }
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

const { isMarkedNonRetryable } = await import('../../../src/deployment/retryable-errors.js');
const { IntrinsicResolutionRefusalError } = await import('../../../src/utils/error-handler.js');
const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

beforeEach(() => {
  logSpies.debug.mockClear();
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  ssmCalls.count = 0;
});

/** `Name` and `Big` as String parameters, bound; `secret` makes them inherited secrets. */
function contextFor(bag: RecordedSecretValues, secret: boolean) {
  const inheritedSecrets: RecordedSecretValues | undefined = secret
    ? new Map([
        [NAME, '{{resolve:secretsmanager:parent-probe:SecretString:name}}'],
        [BIG_NAME, '{{resolve:secretsmanager:parent-probe:SecretString:big}}'],
      ])
    : undefined;
  if (inheritedSecrets) inheritNestedStackParameterAssociations(bag, inheritedSecrets);
  return {
    template: {
      Parameters: { Name: { Type: 'String' }, Big: { Type: 'String' } },
      Resources: {},
    } as CloudFormationTemplate,
    resources: {},
    parameters: { Name: NAME, Big: BIG_NAME },
    conditions: {},
    recordedSecretValues: bag,
    ...(inheritedSecrets ? { inheritedSecrets } : {}),
  };
}

/** Resolve `properties` and persist them, as the engine does for one resource. */
async function persist(
  properties: Record<string, unknown>,
  secret: boolean,
  resolver = new IntrinsicFunctionResolver('us-east-1')
): Promise<{ resolved: Record<string, unknown>; record: Record<string, unknown> }> {
  const bag: RecordedSecretValues = new Map();
  const resolved = (await resolver.resolve(properties, contextFor(bag, secret) as never)) as Record<
    string,
    unknown
  >;
  const record = redactSecretsForState(markSameGenerationBag(structuredClone(resolved)), bag, properties) as Record<
    string,
    unknown
  >;
  return { resolved, record };
}

function everyLine(): string[] {
  return [logSpies.debug, logSpies.info, logSpies.warn, logSpies.error].flatMap((spy) =>
    spy.mock.calls.map((c) => String(c[0]))
  );
}

async function refusalOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof Error ? e.message : String(e))
  );
}

// The two ways a secret reaches the token's text: a `Ref` to a parameter a
// parent decrypted, and an `Fn::Sub` variable holding a token that resolves
// to a SUB-FLOOR secret, which only the log twin sees (the needle mask has a
// four-character floor).
const NAME_SOURCES = [
  ['an inherited secret parameter', NAME, '${Name}', {}, true],
  [
    'an Fn::Sub variable resolving to a sub-floor secret',
    SHORT_NAME,
    '${N}',
    { N: `{{resolve:secretsmanager:${SECRET_ID}:SecretString:name}}` },
    false,
  ],
] as const;
const subOf = (placeholder: string, variables: object) => (text: string) => ({
  'Fn::Sub': [text.replace('${Name}', placeholder), variables],
});

describe('issue #4166: a resolvable token assembled from a secret is refused', () => {
  for (const [source, name, placeholder, variables, secret] of NAME_SOURCES) {
    const sub = subOf(placeholder, variables);
    // The issue's measured rows, named by the state writer that persisted
    // each shape on `origin/main`. Refused here, they never reach it.
    for (const [row, properties] of [
      ['frame-arm', { A: sub('port:{{resolve:ssm:/app/${Name}}}') }],
      ['skeleton-arm', { A: sub('{{resolve:ssm:/app/${Name}}}') }],
      ['whole-value-scan', { A: sub('x-{{resolve:ssm:/app/${Name}}}'), B: 'q7' }],
    ] as const) {
      it(`refuses the issue's ${row} row, with the name from ${source}`, async () => {
        const message = await refusalOf(persist(properties, secret));
        expect(message).toBe(`Refusing to resolve {{resolve:ssm:/app/***}}: ${REFUSAL_TAIL}`);
        for (const line of everyLine()) expect(line).not.toContain(`/app/${name}`);
      });
    }
  }

  it('throws a non-retryable IntrinsicResolutionRefusalError', async () => {
    const error = await persist({ A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Name}}}' } }, true).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it("records no entry into the pass's bag for a refused token", async () => {
    // The bag the engine would redact against: a refused secret result must
    // leave no plaintext entry there. (Its resolved PAIR is written on the
    // next line of the same block and has no public reader, so its order is
    // not pinned on its own.)
    const bag: RecordedSecretValues = new Map();
    const message = await refusalOf(
      new IntrinsicFunctionResolver('us-east-1').resolve(
        { A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Name}}}' } },
        contextFor(bag, true) as never
      )
    );
    expect(message).toBe(`Refusing to resolve {{resolve:ssm:/app/***}}: ${REFUSAL_TAIL}`);
    expect(bag.has('q7')).toBe(false);
    expect([...bag.values()].some((v) => String(v).includes(`/app/${NAME}`))).toBe(false);
  });

  it('leaves the refused token out of the process-wide secret verdict store', async () => {
    // A SecureString verdict is pinned process-wide, and the redaction path
    // can name a pinned expression as a leaf's; a refused token must not be
    // there. CONTROL: the same token from a plain name is pinned.
    const token = `{{resolve:ssm:/app/${NAME}}}`;
    await refusalOf(persist({ A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Name}}}' } }, true));
    expect(isRecordedSecretExpression(token)).toBe(false);
    // Nor in the resolver's own cache: the same token spelled literally with
    // a plain name is looked up again, not served the refused value.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await refusalOf(persist({ A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Name}}}' } }, true, resolver));
    const lookups = ssmCalls.count;
    await persist({ A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Name}}}' } }, false, resolver);
    expect(ssmCalls.count, 'a lookup, not a cache hit').toBe(lookups + 1);
    expect(isRecordedSecretExpression(token)).toBe(true);
  });

  it('is refused when a sibling resolver answers a region-pinned token', async () => {
    const message = await refusalOf(
      persist(
        { A: { 'Fn::Sub': 'port:{{resolve:ssm:arn:aws:ssm:us-west-2:123456789012:parameter/app/${Name}}}' } },
        true
      )
    );
    expect(message).toBe(
      `Refusing to resolve {{resolve:ssm:arn:aws:ssm:us-west-2:123456789012:parameter/app/***}}: ${REFUSAL_TAIL}`
    );
    for (const line of everyLine()) expect(line).not.toContain(NAME);
  });

  it("refuses the issue's substring-arm row: an above-floor value a literal sibling embeds", async () => {
    const message = await refusalOf(
      persist({ A: { 'Fn::Sub': 'x-{{resolve:ssm:/app/${Big}}}' }, B: `prefix-${BIG_VALUE}` }, true)
    );
    expect(message).toBe(`Refusing to resolve {{resolve:ssm:/app/***}}: ${REFUSAL_TAIL}`);
    for (const line of everyLine()) expect(line).not.toContain(BIG_NAME);
  });

  // The same resolver first resolves the token spelled literally with a
  // name that is not a secret, so it is resolved and cached; the second
  // spelling then takes the cache arm. One per half of the detector.
  for (const [label, name, second, secret] of [
    ['the twin half: an Fn::Sub variable resolving to a sub-floor secret', SHORT_NAME, subOf('${N}', NAME_SOURCES[1][3])('port:{{resolve:ssm:/app/${Name}}}'), false],
    ['the needle half: a literal spelling of an inherited secret', NAME, `port:{{resolve:ssm:/app/${NAME}}}`, true],
  ] as const) {
    it(`is refused on a cache hit too, by ${label}`, async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const first = await persist({ A: `port:{{resolve:ssm:/app/${name}}}` }, false, resolver);
      expect(first.resolved['A'], 'premise: the literal spelling resolves').toBe('port:q7');
      const lookups = ssmCalls.count;
      const message = await refusalOf(persist({ A: second }, secret, resolver));
      expect(message).toBe(`Refusing to resolve {{resolve:ssm:/app/***}}: ${REFUSAL_TAIL}`);
      expect(ssmCalls.count, 'premise: the second resolution is a cache hit, not a lookup').toBe(lookups);
    });
  }
});

describe('issue #4166: what the refusal leaves alone', () => {
  // Review M0: `DB_USER` resolves first and records `myapp`, which the
  // `DB_PASSWORD` token spells literally. Literal template text discloses
  // nothing, so neither key order may refuse.
  for (const order of [
    ['DB_USER', 'DB_PASSWORD'],
    ['DB_PASSWORD', 'DB_USER'],
  ] as const) {
    it(`does not refuse a literal token spelling a secret this pass resolved (${order.join(' before ')})`, async () => {
      const tokens = {
        DB_USER: '{{resolve:secretsmanager:myapp-db:SecretString:username}}',
        DB_PASSWORD: '{{resolve:secretsmanager:myapp-db:SecretString:password}}',
      };
      // Premise: `myapp` clears the needle floor, and the union masker the
      // unsupported-service refusal uses changes the literal password token.
      expect('myapp'.length).toBeGreaterThanOrEqual(MIN_NEEDLE_LENGTH);
      expect(maskRecordedSecretsInText(tokens.DB_PASSWORD, new Map([['myapp', 'x']]))).not.toBe(tokens.DB_PASSWORD);
      const properties = Object.fromEntries(order.map((key) => [key, tokens[key]]));
      const { resolved } = await persist(properties, false);
      expect(resolved).toEqual({ DB_USER: 'myapp', DB_PASSWORD: 'db-password-value' });
    });
  }

  it('the comparison path does not pin the verdict of a token the deploy path would refuse', async () => {
    // Review M2: `skipDynamicReferences` reads the `Type` without decrypting
    // and resolves nothing. CONTROL: the same token from a plain name is pinned.
    const token = `{{resolve:ssm:/app/${NAME}}}`;
    const compare = async (secret: boolean): Promise<void> => {
      const context = { ...contextFor(new Map(), secret), skipDynamicReferences: true };
      await new IntrinsicFunctionResolver('us-east-1').resolve(
        { A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Name}}}' } },
        context as never
      );
    };
    await compare(true);
    expect(ssmCalls.count, 'premise: the comparison path looked the parameter up').toBe(1);
    expect(isRecordedSecretExpression(token)).toBe(false);
    await compare(false);
    expect(isRecordedSecretExpression(token)).toBe(true);
  });

  it('the comparison path over PERSISTED text pins the verdict, as its deploy path records it', async () => {
    const token = `{{resolve:ssm:/app/${NAME}}}`;
    const context = { ...contextFor(new Map(), true), skipDynamicReferences: true };
    await new IntrinsicFunctionResolver('us-east-1').resolveDynamicReferences(`port:${token}`, context as never);
    expect(ssmCalls.count, 'premise: the comparison path looked the parameter up').toBe(1);
    expect(isRecordedSecretExpression(token)).toBe(true);
  });

  it('CONTROL: the same token with a name that is NOT a secret persists its expression', async () => {
    const { resolved, record } = await persist({ A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Name}}}' } }, false);
    expect(resolved['A']).toBe('port:q7');
    expect(record['A']).toBe(`port:{{resolve:ssm:/app/${NAME}}}`);
  });

  it('a PUBLIC result of a token assembled from a secret resolves: it records no expression', async () => {
    const { resolved, record } = await persist({ A: { 'Fn::Sub': 'x-{{resolve:ssm:/pub/${Name}}}' } }, true);
    expect(resolved['A']).toBe('x-public-value');
    expect(JSON.stringify(record)).not.toContain(NAME);
  });

  it('a PUBLIC result resolves from the cache too', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await persist({ A: `x-{{resolve:ssm:/pub/${NAME}}}` }, false, resolver);
    const lookups = ssmCalls.count;
    const { resolved } = await persist({ A: { 'Fn::Sub': 'x-{{resolve:ssm:/pub/${Name}}}' } }, true, resolver);
    expect(resolved['A']).toBe('x-public-value');
    expect(ssmCalls.count, 'premise: a cache hit, not a lookup').toBe(lookups);
  });

  it('an EMPTY secret result resolves, fresh and from the cache', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    for (const read of ['a lookup', 'a cache hit']) {
      const { resolved } = await persist({ A: { 'Fn::Sub': 'x-{{resolve:ssm:/empty/${Name}}}' } }, true, resolver);
      expect(resolved['A'], read).toBe('x-');
    }
    expect(ssmCalls.count, 'premise: the second read is a cache hit').toBe(1);
  });

  it('a lookup that FAILS keeps its own masked error', async () => {
    const message = await refusalOf(persist({ A: { 'Fn::Sub': 'x-{{resolve:ssm:/missing/${Name}}}' } }, true));
    expect(message).toBeDefined();
    expect(message).not.toMatch(/^Refusing to resolve/);
    expect(message).not.toContain(NAME);
  });

  it('persisted text (cdkd drift, the rollback replay) is exempt, as for issue #2743', async () => {
    // Twice on one resolver: the second read is a cache hit, exempt too.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    for (const read of ['a lookup', 'a cache hit']) {
      const resolved = await resolver.resolveDynamicReferences(
        `port:{{resolve:ssm:/app/${NAME}}}`,
        contextFor(new Map(), true) as never
      );
      expect(resolved, read).toBe('port:q7');
    }
    expect(ssmCalls.count, 'premise: the second read is a cache hit').toBe(1);
    // The same through a region-pinned token, which a sibling resolves: the
    // exemption is propagated to it, fresh and from its cache.
    const arn = `port:{{resolve:ssm:arn:aws:ssm:us-west-2:123456789012:parameter/app/${NAME}}}`;
    for (const read of ['a sibling lookup', 'a sibling cache hit']) {
      const resolved = await resolver.resolveDynamicReferences(arn, contextFor(new Map(), true) as never);
      expect(resolved, read).toBe('port:q7');
    }
    expect(ssmCalls.count, 'premise: the sibling looked up once').toBe(2);
    for (const line of everyLine()) expect(line).not.toContain(NAME);
    // CONTROL: the same text as a TEMPLATE leaf is refused. Its name spells a
    // recorded four-or-more-character secret, the bound issue #2743 set.
    const message = await refusalOf(persist({ A: `port:{{resolve:ssm:/app/${NAME}}}` }, true));
    expect(message).toBe(`Refusing to resolve {{resolve:ssm:/app/***}}: ${REFUSAL_TAIL}`);
  });
});

describe('issue #4166: a custom resource NoEcho value in a reference name', () => {
  const noEchoContext = (skipDynamicReferences: boolean) => ({
    ...contextFor(new Map([['crnoechovalue', SECRET_MASK]]), false),
    resources: {
      CR: { physicalId: 'cr-phys', resourceType: 'Custom::Probe', attributes: { Password: 'crnoechovalue' } },
    },
    template: { Parameters: {}, Resources: { CR: { Type: 'Custom::Probe', Properties: {} } } },
    ...(skipDynamicReferences ? { skipDynamicReferences: true } : {}),
  });

  it('the comparison path does not pin its verdict either: the twin half', async () => {
    // Review M2, the twin half: the value reaches the token through its twin
    // mask, not through an inherited needle.
    await new IntrinsicFunctionResolver('us-east-1').resolve(
      { A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${CR.Password}}}' } },
      noEchoContext(true) as never
    );
    expect(ssmCalls.count, 'premise: the comparison path looked the parameter up').toBe(1);
    expect(isRecordedSecretExpression('{{resolve:ssm:/app/crnoechovalue}}')).toBe(false);
  });

  it('is refused: the value is a mask-only key of the pass bag, and its twin masks it', async () => {
    // What `docs/state-management.md` says about a reference NAME built from a
    // `NoEcho` value: when the reference resolves to a secret it is refused.
    const bag: RecordedSecretValues = new Map([['crnoechovalue', SECRET_MASK]]);
    const context = {
      ...contextFor(bag, false),
      resources: {
        CR: { physicalId: 'cr-phys', resourceType: 'Custom::Probe', attributes: { Password: 'crnoechovalue' } },
      },
      template: { Parameters: {}, Resources: { CR: { Type: 'Custom::Probe', Properties: {} } } },
    };
    const message = await refusalOf(
      new IntrinsicFunctionResolver('us-east-1').resolve(
        { A: { 'Fn::Sub': 'port:{{resolve:ssm:/app/${CR.Password}}}' } },
        context as never
      )
    );
    expect(message).toBe(`Refusing to resolve {{resolve:ssm:/app/***}}: ${REFUSAL_TAIL}`);
    for (const line of everyLine()) expect(line).not.toContain('crnoechovalue');
  });
});
