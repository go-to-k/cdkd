import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// Capture the resolver's child-logger debug lines so the tests can assert on
// what a `--verbose` run would actually print (issue #1329: NoEcho parameter
// values must never reach the log).
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: debugSpy,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: ssmSend },
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const SECRET = 'hunter2-super-secret';

function debugLines(): string {
  return debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('NoEcho parameter redaction in debug logs (issue #1329)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new IntrinsicFunctionResolver();
  });

  it('redacts a user-provided NoEcho value in resolveParameters', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        DbPassword: { Type: 'String', NoEcho: true },
        PlainParam: { Type: 'String' },
      },
      Resources: {},
    };

    const params = await resolver.resolveParameters(template, {
      DbPassword: SECRET,
      PlainParam: 'visible-value',
    });

    // Resolution itself must be unaffected — only the LOG is redacted.
    expect(params['DbPassword']).toBe(SECRET);
    const logs = debugLines();
    expect(logs).not.toContain(SECRET);
    expect(logs).toContain('Parameter DbPassword: using user-provided value <redacted>');
    // No over-redaction: plain parameters keep full debug output.
    expect(logs).toContain('Parameter PlainParam: using user-provided value visible-value');
  });

  it('redacts a NoEcho default value in resolveParameters', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        ApiToken: { Type: 'String', NoEcho: true, Default: SECRET },
      },
      Resources: {},
    };

    const params = await resolver.resolveParameters(template);

    expect(params['ApiToken']).toBe(SECRET);
    const logs = debugLines();
    expect(logs).not.toContain(SECRET);
    expect(logs).toContain('Parameter ApiToken: using default value <redacted>');
  });

  it('redacts a NoEcho SSM-resolved value in resolveParameters', async () => {
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: SECRET } });
    const template: CloudFormationTemplate = {
      Parameters: {
        SsmSecret: {
          Type: 'AWS::SSM::Parameter::Value<String>',
          NoEcho: true,
          Default: '/app/secret',
        },
      },
      Resources: {
        Consumer: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Value: { Ref: 'SsmSecret' } },
        },
      },
    };

    const params = await resolver.resolveParameters(template);

    expect(params['SsmSecret']).toBe(SECRET);
    const logs = debugLines();
    expect(logs).not.toContain(SECRET);
    expect(logs).toContain('Parameter SsmSecret: resolved SSM value <redacted>');
  });

  it('redacts a NoEcho parameter value at the Ref resolution site', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        DbPassword: { Type: 'String', NoEcho: true },
        PlainParam: { Type: 'String' },
      },
      Resources: {},
    };
    const context: ResolverContext = {
      template,
      resources: {},
      parameters: { DbPassword: SECRET, PlainParam: 'visible-value' },
    };

    const resolved = await resolver.resolve({ Ref: 'DbPassword' }, context);
    const plain = await resolver.resolve({ Ref: 'PlainParam' }, context);

    // The consuming resource still receives the real value.
    expect(resolved).toBe(SECRET);
    expect(plain).toBe('visible-value');
    const logs = debugLines();
    expect(logs).not.toContain(SECRET);
    expect(logs).toContain('Resolved Ref to parameter: DbPassword -> <redacted>');
    expect(logs).toContain('Resolved Ref to parameter: PlainParam -> visible-value');
  });
});
