/**
 * State schema v12 (go-to-k/cdkd#4847 / go-to-k/cdkd#4852): the recording
 * seam, through the REAL resolver. Each secret resolution records, beside its
 * pair and into the same pass's bag:
 *
 * - the region of the resolver that answered (a region-pinned sibling's for an
 *   ARN-form token);
 * - the version id off the lookup's own response (`VersionId`, SSM `Version`),
 *   on a cache hit too, with no second lookup;
 * - the route: `read` inside a re-resolution of a recorded value, `literal`
 *   otherwise.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const calls = vi.hoisted(() => ({ sm: 0, ssm: 0, regions: [] as string[] }));
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const smAnswer = vi.hoisted(() => async (region: string): Promise<unknown> => {
  calls.sm++;
  calls.regions.push(region);
  return {
    SecretString: JSON.stringify({ name: `value-in-${region}` }),
    VersionId: 'a1b2c3d4-0000-1111-2222-333333333333',
  };
});
const ssmAnswer = vi.hoisted(() => async (command: { input?: { Name?: string } }): Promise<unknown> => {
  calls.ssm++;
  if (command.input?.Name === '/app/public') {
    return { Parameter: { Value: 'public-ssm-value', Type: 'String', Version: 3 } };
  }
  return { Parameter: { Value: 'secure-ssm-value', Type: 'SecureString', Version: 7 } };
});
/** A client bag answering for `region`; `withRegion` builds the sibling's. */
const bagFor = vi.hoisted(() => {
  const make = (region: string): Record<string, unknown> => ({
    configuredRegion: region,
    credentialConfig: {},
    withRegion: (target: string) => make(target),
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: () => smAnswer(region),
      config: { region: () => Promise.resolve(region) },
    },
    ssm: { send: ssmAnswer, config: { region: () => Promise.resolve(region) } },
  });
  return make;
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => bagFor('us-east-1'),
}));

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { passProvenanceFor } = await import(
  '../../../src/deployment/secret-redaction/reference-provenance.js'
);
const { clearRecordedSecretExpressions } = await import(
  '../../../src/deployment/secret-redaction.js'
);

const SM = '{{resolve:secretsmanager:app:SecretString:name::}}';
const SSM_SECURE = '{{resolve:ssm-secure:/app/password}}';
const FOREIGN = '{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2:123456789012:secret:app-AbCdEf:SecretString:name::}}';

const context = (bag: Map<string, string>) => ({
  template: { Resources: {} },
  resources: {},
  recordedSecretValues: bag,
});

beforeEach(() => {
  calls.sm = 0;
  calls.ssm = 0;
  calls.regions.length = 0;
  clearRecordedSecretExpressions();
});

describe('the recording seam (state schema v12)', () => {
  it('a literal token records the answering region and the response VersionId', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const bag = new Map<string, string>();
    await resolver.resolve({ Name: SM }, context(bag) as never);
    expect(passProvenanceFor(bag, SM)).toEqual({ region: 'us-east-1', versions: [V1] });
  });

  it("an SSM parameter's numeric Version is recorded as its string form", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const bag = new Map<string, string>();
    await resolver.resolve({ Password: SSM_SECURE }, context(bag) as never);
    expect(passProvenanceFor(bag, SSM_SECURE)).toEqual({ region: 'us-east-1', versions: ['7'] });
  });

  it('a cache hit records the same provenance, with no second lookup', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve({ Name: SM }, context(new Map()) as never);
    expect(calls.sm).toBe(1);
    const second = new Map<string, string>();
    await resolver.resolve({ Name: SM }, context(second) as never);
    expect(calls.sm).toBe(1);
    expect(passProvenanceFor(second, SM)).toEqual({ region: 'us-east-1', versions: [V1] });
  });

  it('an ARN-form token records the region its region-pinned sibling answered from', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const bag = new Map<string, string>();
    await resolver.resolve({ Name: FOREIGN }, context(bag) as never);
    expect(calls.regions).toEqual(['us-west-2']);
    expect(passProvenanceFor(bag, FOREIGN)).toEqual({ region: 'us-west-2', versions: [V1] });
  });

  it('a re-resolution of a recorded value is the READ route', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const bag = new Map<string, string>();
    await resolver.reresolveCrossStackValue(
      `arn:aws:sqs:us-east-1:123456789012:${SM}`,
      undefined,
      context(bag) as never,
      'Queue.Arn',
      undefined
    );
    expect(passProvenanceFor(bag, SM)).toEqual({
      region: 'us-east-1',
      versions: [V1],
      readVersions: [V1],
    });
  });

  it('a public SSM parameter, stored resolved, records nothing', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const bag = new Map<string, string>();
    const PUBLIC = '{{resolve:ssm:/app/public}}';
    expect(await resolver.resolve({ Name: PUBLIC }, context(bag) as never)).toEqual({
      Name: 'public-ssm-value',
    });
    expect(passProvenanceFor(bag, PUBLIC)).toBeUndefined();
  });
});
