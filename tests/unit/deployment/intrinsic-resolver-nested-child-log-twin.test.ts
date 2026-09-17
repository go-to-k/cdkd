/**
 * Issue [#3114](https://github.com/go-to-k/cdkd/issues/3114): two routes that
 * reached the resolver's debug lines with a 1-3 character secret embedded and
 * no log twin, after go-to-k/cdkd#3100 introduced the twin.
 *
 * ROUTE 1 — a nested-stack CHILD. The parent resolves the child's `Parameters`
 * and registers the masked twin of each value it built (`port:q7` ->
 * `port:***`) under ITS pass bag. The deploy engine binds that very object as
 * the resource's secrets (`createSecrets` / `updateSecrets` are
 * `context.recordedSecretValues`), `NestedStackProvider` hands it to the child
 * as `inheritedSecrets`, and the child resolves `{ Ref: <Param> }` to the
 * plaintext. The child's own lookup keyed only by its OWN bag, so the parent's
 * registration was never found. These cases reproduce the BAG hand-off with
 * the REAL resolver: the parent context's bag IS the child context's
 * `inheritedSecrets`, the identity the engine and provider preserve (pinned by
 * `deploy-engine-resource-secrets-binding.test.ts` and, for the provider,
 * `nested-stack-provider-inherited-secrets.test.ts`). They do NOT run the
 * engine's `recordNestedStackParameterExpressions`, which turns a wholly
 * literal secretsmanager frame (the `port:` + `PIN_REF` one most cases use)
 * into a whole-value inherited entry that masks the value first. The one
 * exception is the `ssm` SecureString case: its token sits in a nested part, a
 * frame the carry still refuses (go-to-k/cdkd#3306), and it runs the carry to
 * show that refusal, since production routes such a frame through this
 * lookup.
 *
 * ROUTE 2 — a string resolved in two stages. A list element that still spells
 * a reference after its list intrinsic resolved it (a resolved VALUE that is
 * itself reference text) is re-resolved by the enclosing `Fn::Join`, and that
 * second stage must start from the element's registered twin, not its
 * plaintext.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const SECRET_ID = 'cdkd-nested-child-log-twin-probe';

/** The sub-floor secret: two characters, below `MIN_NEEDLE_LENGTH`. */
const PIN = 'q7';

/**
 * A second sub-floor secret, the first two characters of `port:q7`: a child
 * Join over it builds the same string with a DIFFERENT masked span.
 */
const HEAD = 'po';

/** A sub-floor SecureString value, for a frame the parent's carry refuses. */
const PIN_SSM = 'm8';

/** The PUBLIC ssm value route 2's second stage resolves to. */
const PUBLIC_HOST = 'pb';

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
      // Keyed by parameter NAME: `outer` answers the TEXT of another reference,
      // which is what makes route 2 two-stage; `host` answers the public value.
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        const name = command.input?.Name;
        if (name === 'outer') {
          return { Parameter: { Value: '{{resolve:ssm:host}}', Type: 'String' } };
        }
        if (name === 'host') return { Parameter: { Value: PUBLIC_HOST, Type: 'String' } };
        // The ssm case's sub-floor SecureString, in a frame the parent's
        // carry still refuses (a token in a nested part), which reaches this
        // lookup in production.
        if (name === 'pinssm') return { Parameter: { Value: PIN_SSM, Type: 'SecureString' } };
        const notFound = new Error(`ParameterNotFound: ${String(name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        if (command.input?.SecretId === SECRET_ID) {
          return { SecretString: JSON.stringify({ pin: PIN, head: HEAD }) };
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
const { recordNestedStackParameterExpressions, redactSecretsForState } = await import(
  '../../../src/deployment/secret-redaction.js'
);

const PIN_REF = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin}}`;

/** Every debug line starting with `prefix`, in emission order. */
function debugLines(prefix: string): string[] {
  return logSpies.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(prefix));
}

beforeEach(() => {
  logSpies.debug.mockClear();
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  resetAccountInfoCache();
});

/**
 * The parent's pass: resolves the nested stack's `Parameters` value (an
 * `Fn::Join` framing the pin) with `bag` as its `recordedSecretValues`, the way
 * the deploy engine resolves a resource.
 */
async function resolveParentParameter(bag: Map<string, string>): Promise<string> {
  const parent = new IntrinsicFunctionResolver('us-east-1');
  const value = await parent.resolve(
    { 'Fn::Join': ['', ['port:', PIN_REF]] },
    { template: { Resources: {} }, resources: {}, recordedSecretValues: bag } as never
  );
  return String(value);
}

/** A child context that receives the parent's bag as `inheritedSecrets`. */
function childContext(parentBag: Map<string, string>, parameterValue: string) {
  return {
    template: {
      Parameters: { Endpoint: { Type: 'String' } },
      Resources: {},
    } as CloudFormationTemplate,
    resources: {},
    parameters: { Endpoint: parameterValue },
    recordedSecretValues: new Map<string, string>(),
    inheritedSecrets: parentBag,
  };
}

describe('issue #3114 route 1: a nested child takes the mask its parent registered', () => {
  it('a child Join over a Ref to the parent-built parameter logs the mask', async () => {
    const parentBag = new Map<string, string>();
    const parameterValue = await resolveParentParameter(parentBag);
    expect(parameterValue).toBe(`port:${PIN}`);

    logSpies.debug.mockClear();
    const child = new IntrinsicFunctionResolver('us-east-1');
    const value = await child.resolve(
      { 'Fn::Join': ['', ['x-', { Ref: 'Endpoint' }]] },
      childContext(parentBag, parameterValue) as never
    );

    expect(value).toBe(`x-port:${PIN}`);
    expect(debugLines('Resolved Fn::Join: ')).toEqual(['Resolved Fn::Join: x-port:***']);
    expect(debugLines('Resolved Ref to parameter: ')).toEqual([
      'Resolved Ref to parameter: Endpoint -> port:***',
    ]);
  });

  it("the child's `Parameter X: using user-provided value` line logs the mask", async () => {
    const parentBag = new Map<string, string>();
    const parameterValue = await resolveParentParameter(parentBag);

    logSpies.debug.mockClear();
    const child = new IntrinsicFunctionResolver('us-east-1');
    await child.resolveParameters(
      childContext(parentBag, parameterValue).template,
      { Endpoint: parameterValue },
      { inheritedSecrets: parentBag }
    );

    expect(debugLines('Parameter Endpoint: ')).toEqual([
      'Parameter Endpoint: using user-provided value port:***',
    ]);
  });

  it('a child Fn::Base64 over the Ref logs the mask on its input side and stores its encoding mask-only', async () => {
    const parentBag = new Map<string, string>();
    const parameterValue = await resolveParentParameter(parentBag);

    logSpies.debug.mockClear();
    const child = new IntrinsicFunctionResolver('us-east-1');
    const ctx = childContext(parentBag, parameterValue);
    const encoded = await child.resolve({ 'Fn::Base64': { Ref: 'Endpoint' } }, ctx as never);

    expect(encoded).toBe(Buffer.from(`port:${PIN}`).toString('base64'));
    expect(debugLines('Resolved Fn::Base64: ')).toEqual(['Resolved Fn::Base64: port:*** -> ***']);
    // `resolveBase64`'s position detector (issue #3119) reads the same lookup,
    // so the child's own bag now registers the encoding for every persistence
    // reader, as the parent's does for the same encoding.
    expect(ctx.recordedSecretValues.get(String(encoded))).toBe('***');
  });

  it('control: a child Fn::Base64 over a value the parent never masked registers nothing', async () => {
    const parentBag = new Map<string, string>();
    await resolveParentParameter(parentBag);

    const child = new IntrinsicFunctionResolver('us-east-1');
    const ctx = childContext(parentBag, 'port:k9');
    const encoded = await child.resolve({ 'Fn::Base64': { Ref: 'Endpoint' } }, ctx as never);

    expect(ctx.recordedSecretValues.has(String(encoded))).toBe(false);
  });

  it('a child GetAtt reading a stored attribute equal to the parent-built value logs the mask', async () => {
    const parentBag = new Map<string, string>();
    const parameterValue = await resolveParentParameter(parentBag);

    logSpies.debug.mockClear();
    const child = new IntrinsicFunctionResolver('us-east-1');
    const ctx = {
      ...childContext(parentBag, parameterValue),
      resources: {
        Queue: {
          physicalId: 'queue-physical-id',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: { Endpoint: parameterValue },
        },
      },
    };
    await child.resolve({ 'Fn::GetAtt': ['Queue', 'Endpoint'] }, ctx as never);

    expect(debugLines('Resolved Fn::GetAtt from attributes: ')).toEqual([
      'Resolved Fn::GetAtt from attributes: Queue.Endpoint -> port:***',
    ]);
  });

  describe('the sibling Fn::GetAtt lines print a value read from the child record the same way', () => {
    /** Resolve `getAtt` in a child whose `Queue` record is `record`, and return that prefix's lines. */
    async function getAttLines(
      getAtt: [string, string],
      record: Record<string, unknown>,
      prefix: string
    ): Promise<string[]> {
      const parentBag = new Map<string, string>();
      const parameterValue = await resolveParentParameter(parentBag);
      expect(parameterValue).toBe(`port:${PIN}`);
      logSpies.debug.mockClear();
      const child = new IntrinsicFunctionResolver('us-east-1');
      await child.resolve({ 'Fn::GetAtt': getAtt }, {
        ...childContext(parentBag, parameterValue),
        resources: { Queue: record },
      } as never);
      return debugLines(prefix);
    }

    function expectMaskedOnce(lines: string[]): void {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('port:***');
      expect(lines[0]).not.toContain(`port:${PIN}`);
    }

    it('from nested attributes', async () => {
      expectMaskedOnce(
        await getAttLines(
          ['Queue', 'Endpoint.Address'],
          {
            physicalId: 'queue-physical-id',
            resourceType: 'AWS::SQS::Queue',
            properties: {},
            attributes: { Endpoint: { Address: `port:${PIN}` } },
          },
          'Resolved Fn::GetAtt from nested attributes: '
        )
      );
    });

    it('the legacy Route 53 NameServers normalization', async () => {
      expectMaskedOnce(
        await getAttLines(
          ['Queue', 'NameServers'],
          {
            physicalId: 'Z0000000000',
            resourceType: 'AWS::Route53::HostedZone',
            properties: {},
            attributes: { NameServers: `port:${PIN},ns-2.example` },
          },
          'Normalized legacy Fn::GetAtt attribute: '
        )
      );
    });

    it('the physical-id fallback', async () => {
      expectMaskedOnce(
        await getAttLines(
          ['Queue', 'Endpoint'],
          {
            physicalId: `port:${PIN}`,
            resourceType: 'Custom::Probe',
            properties: {},
            attributes: {},
          },
          'Resolved Fn::GetAtt: '
        )
      );
      // No other line of the pass prints it either (the fallback also warns).
      const everyLine = [logSpies.debug, logSpies.info, logSpies.warn, logSpies.error].flatMap(
        (spy) => spy.mock.calls.map((c) => String(c[0]))
      );
      expect(everyLine.filter((l) => l.includes(`port:${PIN}`))).toEqual([]);
    });
  });

  it("a string the child and the parent registered with DIFFERENT masks is masked whole", async () => {
    const parentBag = new Map<string, string>();
    const parameterValue = await resolveParentParameter(parentBag);

    const child = new IntrinsicFunctionResolver('us-east-1');
    const ctx = childContext(parentBag, parameterValue);
    // The child's own write of the same string, masked at the head
    // (`***rt:q7`) where the parent's is masked at the tail (`port:***`).
    const own = await child.resolve(
      {
        'Fn::Join': ['', [`{{resolve:secretsmanager:${SECRET_ID}:SecretString:head}}`, 'rt:q7']],
      },
      ctx as never
    );
    expect(own).toBe(parameterValue);

    logSpies.debug.mockClear();
    await child.resolve({ 'Fn::Join': ['', ['x-', { Ref: 'Endpoint' }]] }, ctx as never);

    // Either registration alone would print the other secret's characters.
    expect(debugLines('Resolved Fn::Join: ')).toEqual(['Resolved Fn::Join: x-***']);
  });

  it('a string the child and the parent registered with the SAME mask keeps that mask, not the whole-string one', async () => {
    const parentBag = new Map<string, string>();
    const parameterValue = await resolveParentParameter(parentBag);

    const child = new IntrinsicFunctionResolver('us-east-1');
    const ctx = childContext(parentBag, parameterValue);
    // The child's own write of the same string with the same span, so both
    // bags hold `port:q7 -> port:***`.
    await child.resolve({ 'Fn::Join': ['', ['port:', PIN_REF]] }, ctx as never);

    logSpies.debug.mockClear();
    await child.resolve({ 'Fn::Join': ['', ['x-', { Ref: 'Endpoint' }]] }, ctx as never);

    expect(debugLines('Resolved Fn::Join: ')).toEqual(['Resolved Fn::Join: x-port:***']);
  });

  it("a child Fn::Split over the parent-built value splits the parent's mask", async () => {
    const parentBag = new Map<string, string>();
    const parameterValue = await resolveParentParameter(parentBag);

    logSpies.debug.mockClear();
    const child = new IntrinsicFunctionResolver('us-east-1');
    // Split on `r`, so the secret stays inside a longer piece (`t:q7`) rather
    // than becoming a piece of its own that the whole-value mask would catch.
    const value = await child.resolve(
      { 'Fn::Join': ['|', { 'Fn::Split': ['r', { Ref: 'Endpoint' }] }] },
      childContext(parentBag, parameterValue) as never
    );

    expect(value).toBe(`po|t:${PIN}`);
    expect(debugLines('Resolved Fn::Split: ')).toEqual([
      'Resolved Fn::Split: split by "r" -> ["po","t:***"]',
    ]);
    expect(debugLines('Resolved Fn::Join: ')).toEqual(['Resolved Fn::Join: po|t:***']);
  });

  it('control: a parameter the parent carried as a whole-value entry stays masked with no registered twin', async () => {
    // The literal-frame carry (`recordNestedStackParameterExpressions`) puts
    // the whole value into the inherited bag; nothing registers a twin. The
    // part is masked whole, and since `port:q7` is also a 4+ character needle
    // inside the joined text, `logTwinText` masks the whole line.
    const parentBag = new Map<string, string>([[`port:${PIN}`, `port:${PIN_REF}`]]);

    const child = new IntrinsicFunctionResolver('us-east-1');
    await child.resolve(
      { 'Fn::Join': ['', ['x-', { Ref: 'Endpoint' }]] },
      childContext(parentBag, `port:${PIN}`) as never
    );

    expect(debugLines('Resolved Fn::Join: ')).toEqual(['Resolved Fn::Join: ***']);
  });

  it('the same lookup over an ssm SecureString frame the parent carry still refuses (a token in a nested part)', async () => {
    const parentBag = new Map<string, string>();
    const parent = new IntrinsicFunctionResolver('us-east-1');
    // The token sits inside a NESTED `Fn::Sub` part, a shape the carry still
    // refuses (go-to-k/cdkd#3306): the outer object's own text spells no
    // token. Pinned below by running the carry over this very source, so the
    // case keeps a production-reachable anchor.
    // `Control` is a LITERAL frame over the same secret in the same row, which
    // the carry does record: its entry below shows the walk ran over this bag
    // and row, so `Endpoint`'s missing entry is a refusal, not an early exit.
    const source = {
      Parameters: {
        Endpoint: { 'Fn::Join': ['', ['port:', { 'Fn::Sub': '{{resolve:ssm:pinssm}}' }]] },
        Control: 'lit:{{resolve:ssm:pinssm}}',
      },
    };
    const resolved = (await parent.resolve(source, {
      template: { Resources: {} },
      resources: {},
      recordedSecretValues: parentBag,
    } as never)) as { Parameters: { Endpoint: string; Control: string } };
    const parameterValue = resolved.Parameters.Endpoint;
    expect(parameterValue).toBe(`port:${PIN_SSM}`);
    recordNestedStackParameterExpressions(parentBag, 'AWS::CloudFormation::Stack', resolved, source);
    expect(parentBag.get(`lit:${PIN_SSM}`)).toBe('lit:{{resolve:ssm:pinssm}}');
    // Premise: after the carry, value-only redaction is SILENT on the value --
    // no whole-value entry and no substring needle -- so the child's masked
    // lines below can come only from the log twin the parent registered.
    expect(redactSecretsForState(parameterValue, parentBag)).toBe(parameterValue);

    logSpies.debug.mockClear();
    const child = new IntrinsicFunctionResolver('us-east-1');
    await child.resolve(
      { 'Fn::Join': ['', ['x-', { Ref: 'Endpoint' }]] },
      childContext(parentBag, parameterValue) as never
    );

    expect(debugLines('Resolved Fn::Join: ')).toEqual(['Resolved Fn::Join: x-port:***']);
    expect(debugLines('Resolved Ref to parameter: ')).toEqual([
      'Resolved Ref to parameter: Endpoint -> port:***',
    ]);
  });

  it("the child registers its own writes in its OWN bag, never in the parent's", async () => {
    const parentBag = new Map<string, string>();
    const parameterValue = await resolveParentParameter(parentBag);

    const child = new IntrinsicFunctionResolver('us-east-1');
    // Registers `x-port:q7 -> x-port:***` for the child's pass.
    await child.resolve(
      { 'Fn::Join': ['', ['x-', { Ref: 'Endpoint' }]] },
      childContext(parentBag, parameterValue) as never
    );

    // A PARENT-scoped pass reads the registry under the parent's bag only. Its
    // `Fn::Base64` registers the encoding mask-only exactly when the position
    // mask finds a twin for `x-port:q7`, so a registration the child had
    // written into the parent's bag would show here.
    const parent = new IntrinsicFunctionResolver('us-east-1');
    const encoded = await parent.resolve(
      { 'Fn::Base64': { 'Fn::Select': [0, [`x-port:${PIN}`]] } },
      { template: { Resources: {} }, resources: {}, recordedSecretValues: parentBag } as never
    );

    expect(parentBag.has(String(encoded))).toBe(false);
  });

  it('a value the parent never masked stays printed in the child (the lookup is not a blanket mask)', async () => {
    const parentBag = new Map<string, string>();
    await resolveParentParameter(parentBag);

    logSpies.debug.mockClear();
    const child = new IntrinsicFunctionResolver('us-east-1');
    await child.resolve(
      { 'Fn::Join': ['', ['x-', { Ref: 'Endpoint' }]] },
      childContext(parentBag, 'port:k9') as never
    );

    expect(debugLines('Resolved Fn::Join: ')).toEqual(['Resolved Fn::Join: x-port:k9']);
  });
});

describe('issue #3114 route 2: a string resolved in two stages keeps its first stage mask', () => {
  it('a Join over a Split piece that still spells a reference logs the mask', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = {
      template: { Resources: {} },
      resources: {},
      recordedSecretValues: new Map<string, string>(),
    };

    const value = await resolver.resolve(
      {
        'Fn::Join': [
          '|',
          { 'Fn::Split': [',', `port:${PIN_REF}/{{resolve:ssm:outer}},tail`] },
        ],
      },
      ctx as never
    );

    expect(value).toBe(`port:${PIN}/${PUBLIC_HOST}|tail`);
    expect(debugLines('Resolved Fn::Join: ')).toEqual([
      `Resolved Fn::Join: port:***/${PUBLIC_HOST}|tail`,
    ]);
  });

  it('control: the same shape with both references spelled directly is masked before and after', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const ctx = {
      template: { Resources: {} },
      resources: {},
      recordedSecretValues: new Map<string, string>(),
    };

    await resolver.resolve(
      { 'Fn::Join': ['|', { 'Fn::Split': [',', `port:${PIN_REF}/{{resolve:ssm:host}},tail`] }] },
      ctx as never
    );

    expect(debugLines('Resolved Fn::Join: ')).toEqual([
      `Resolved Fn::Join: port:***/${PUBLIC_HOST}|tail`,
    ]);
  });
});
