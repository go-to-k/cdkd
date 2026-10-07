/**
 * Issue [#1889](https://github.com/go-to-k/cdkd/issues/1889): the resolver's
 * terminal BARE `Error` throws are `markNonRetryable`, not only its
 * `IntrinsicResolutionRefusalError` sites (those are fenced in
 * `intrinsic-refusal-non-retryable.test.ts`).
 *
 * Each row drives ONE throw through the real resolver, so removing the marker
 * at any one site reds exactly its own row. Where the message interpolates a
 * template-controlled value, the row puts `DependencyViolation` — a
 * whitespace-free entry in `RETRYABLE_ERROR_MESSAGE_PATTERNS` — into that
 * value and also asserts an UNMARKED twin of the same message classifies
 * retryable: that is what proves the MARKER, not the wording, decides.
 *
 * The CONTROLS at the end are the deliberate exceptions, pinned UNMARKED and
 * retryable: a relayed AWS failure (`Fn::GetAZs`' describe, SSM / Secrets
 * Manager lookups, a producer state read), and the two cross-stack not-found
 * throws, which can follow a SWALLOWED transient lookup failure (a throttled
 * ListExports / DescribeStacks, a per-stack state read that warned and moved on).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
} from '../../../src/deployment/retryable-errors.js';

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

const aws = vi.hoisted(() => ({
  ec2: 'empty' as 'empty' | 'throttle',
  secret: {} as Record<string, unknown>,
  ssm: {} as Record<string, unknown>,
  cfnStacks: [] as unknown[],
  cfnThrottle: false,
  lookup5xx: false,
}));

/** An AWS-shaped transient failure, as the SDK raises it. */
const awsError = (name: string, message: string, httpStatusCode: number): Error =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode } });

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        if (aws.cfnThrottle) throw awsError('ThrottlingException', 'Rate exceeded', 400);
        if (command.constructor.name === 'ListExportsCommand') return { Exports: [] };
        if (command.constructor.name === 'DescribeStacksCommand') return { Stacks: aws.cfnStacks };
        throw new Error(`unexpected CloudFormation command: ${command.constructor.name}`);
      }),
      destroy: vi.fn(),
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: {
      send: vi.fn(async () => {
        if (aws.ec2 === 'throttle') {
          const e = new Error('Rate exceeded');
          e.name = 'ThrottlingException';
          throw e;
        }
        return { AvailabilityZones: [] };
      }),
    },
    ssm: {
      send: vi.fn(async () => {
        if (aws.lookup5xx) throw awsError('InternalServerError', 'Internal server error', 500);
        return aws.ssm;
      }),
    },
    secretsManager: {
      send: vi.fn(async () => {
        if (aws.lookup5xx) throw awsError('InternalServiceError', 'Internal service error', 500);
        return aws.secret;
      }),
    },
  }),
}));

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const POISON = 'DependencyViolation';

interface Row {
  site: string;
  value: unknown;
  template?: CloudFormationTemplate;
  stateBackend?: Partial<S3StateBackend>;
  stackName?: string;
  /** The message interpolates a template value carrying {@link POISON}. */
  poisoned: boolean;
  /** A substring that pins the row to its site. */
  needle: string;
}

const noState: Partial<S3StateBackend> = {
  getState: vi.fn(async () => null) as never,
  listStacks: vi.fn(async () => []) as never,
};

const ROWS: Row[] = [
  // getatt.ts
  {
    site: 'Fn::GetAtt attribute name not a string',
    value: { 'Fn::GetAtt': [`My${POISON}Res`, { 'Fn::Split': [',', 'a,b'] }] },
    poisoned: true,
    needle: 'attribute name for',
  },
  // intrinsic-function-resolver.ts
  {
    site: 'unsupported intrinsic',
    value: { [`Fn::${POISON}`]: 'x' },
    poisoned: true,
    needle: 'Support%20intrinsic',
  },
  // functions.ts
  {
    site: 'Fn::And arity',
    value: { 'Fn::And': [true] },
    poisoned: false,
    needle: 'Fn::And requires',
  },
  { site: 'Fn::Or arity', value: { 'Fn::Or': [true] }, poisoned: false, needle: 'Fn::Or requires' },
  {
    site: 'Fn::Not arity',
    value: { 'Fn::Not': [true, false] },
    poisoned: false,
    needle: 'Fn::Not requires',
  },
  {
    site: 'Fn::FindInMap no Mappings',
    value: { 'Fn::FindInMap': ['M', 'a', 'b'] },
    poisoned: false,
    needle: 'no Mappings section',
  },
  {
    site: 'Fn::FindInMap mapping not found',
    value: { 'Fn::FindInMap': [`${POISON}Map`, 'a', 'b'] },
    template: { Resources: {}, Mappings: {} } as unknown as CloudFormationTemplate,
    poisoned: true,
    needle: 'not found in Mappings section',
  },
  {
    site: 'Fn::FindInMap top-level key not found',
    value: { 'Fn::FindInMap': ['M', `${POISON}Key`, 'b'] },
    template: { Resources: {}, Mappings: { M: {} } } as unknown as CloudFormationTemplate,
    poisoned: true,
    needle: 'top-level key',
  },
  {
    site: 'Fn::FindInMap second-level key not found',
    value: { 'Fn::FindInMap': ['M', 'K', `${POISON}Key`] },
    template: { Resources: {}, Mappings: { M: { K: {} } } } as unknown as CloudFormationTemplate,
    poisoned: true,
    needle: 'second-level key',
  },
  {
    site: 'Fn::Base64 non-string',
    value: { 'Fn::Base64': ['a'] },
    poisoned: false,
    needle: 'Fn::Base64: value must resolve',
  },
  {
    site: 'Fn::GetAZs invalid region',
    value: { 'Fn::GetAZs': `${POISON}.example` },
    poisoned: true,
    needle: 'is not a valid AWS region name',
  },
  {
    site: 'Fn::GetAZs empty list',
    value: { 'Fn::GetAZs': 'us-east-1' },
    poisoned: false,
    needle: 'no availability zones returned',
  },
  {
    site: 'Fn::Cidr non-string ipBlock',
    value: { 'Fn::Cidr': [[POISON], 2, 8] },
    poisoned: true,
    needle: 'Fn::Cidr: ipBlock must be a string',
  },
  // string-functions.ts
  {
    site: 'Fn::Join non-list',
    value: { 'Fn::Join': [',', 'x'] },
    poisoned: false,
    needle: "Fn::Join's second argument must be a list",
  },
  {
    site: 'Fn::Select non-list',
    value: { 'Fn::Select': [0, 'x'] },
    poisoned: false,
    needle: 'Fn::Select: list must be an array',
  },
  // cross-stack.ts
  {
    site: 'Fn::ImportValue non-string name',
    value: { 'Fn::ImportValue': { 'Fn::Split': [',', 'a,b'] } },
    stateBackend: noState,
    poisoned: false,
    needle: 'export name must resolve to a string',
  },
  {
    site: 'Fn::ImportValue without a state backend',
    value: { 'Fn::ImportValue': 'X' },
    poisoned: false,
    needle: 'Fn::ImportValue: state backend is required',
  },
  // stack-output.ts
  {
    site: 'Fn::GetStackOutput non-object argument',
    value: { 'Fn::GetStackOutput': 'x' },
    poisoned: false,
    needle: 'argument must be an object',
  },
  {
    site: 'Fn::GetStackOutput missing StackName',
    value: { 'Fn::GetStackOutput': { OutputName: 'o' } },
    poisoned: false,
    needle: 'StackName is required',
  },
  {
    site: 'Fn::GetStackOutput missing OutputName',
    value: { 'Fn::GetStackOutput': { StackName: 's' } },
    poisoned: false,
    needle: 'OutputName is required',
  },
  {
    site: 'Fn::GetStackOutput non-string StackName',
    value: { 'Fn::GetStackOutput': { StackName: ['a'], OutputName: 'o' } },
    poisoned: false,
    needle: 'StackName must resolve to a non-empty string',
  },
  {
    site: 'Fn::GetStackOutput non-string OutputName',
    value: { 'Fn::GetStackOutput': { StackName: 's', OutputName: ['a'] } },
    poisoned: false,
    needle: 'OutputName must resolve to a non-empty string',
  },
  {
    site: 'Fn::GetStackOutput non-string Region',
    value: { 'Fn::GetStackOutput': { StackName: 's', OutputName: 'o', Region: ['a'] } },
    poisoned: false,
    needle: 'Region must resolve to a non-empty string',
  },
  {
    site: 'Fn::GetStackOutput invalid Region',
    value: { 'Fn::GetStackOutput': { StackName: 's', OutputName: 'o', Region: `${POISON}.x` } },
    poisoned: true,
    needle: 'valid AWS region name',
  },
  {
    site: 'Fn::GetStackOutput non-literal RoleArn',
    value: { 'Fn::GetStackOutput': { StackName: 's', OutputName: 'o', RoleArn: { Ref: 'R' } } },
    poisoned: false,
    needle: 'RoleArn must be a literal string',
  },
  {
    site: 'Fn::GetStackOutput own stack',
    value: { 'Fn::GetStackOutput': { StackName: `${POISON}Stack`, OutputName: 'o' } },
    stackName: `${POISON}Stack`,
    stateBackend: noState,
    poisoned: true,
    needle: 'cannot reference own stack',
  },
  {
    site: 'Fn::GetStackOutput output missing from a CloudFormation stack',
    value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: `${POISON}Out` } },
    stateBackend: noState,
    poisoned: true,
    needle: 'not found in CloudFormation stack',
  },
  {
    site: 'Fn::GetStackOutput output missing from cdkd state',
    value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: `${POISON}Out` } },
    stateBackend: {
      getState: vi.fn(async () => ({
        state: { outputs: { Other: 'v' } },
        etag: 'e',
      })) as never,
    },
    poisoned: true,
    needle: 'not found in stack',
  },
  // stack-state.ts (reached through Fn::GetStackOutput's state read)
  {
    site: 'Fn::GetStackOutput without a state backend',
    value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'o' } },
    poisoned: false,
    needle: 'Fn::GetStackOutput: state backend is required',
  },
  {
    site: 'Fn::GetStackOutput malformed RoleArn',
    value: {
      'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'o', RoleArn: `${POISON}` },
    },
    stateBackend: noState,
    poisoned: true,
    needle: 'is not a valid IAM role ARN',
  },
  // dynamic-ref-lookups.ts
  {
    site: 'secretsmanager empty SECRET_ID',
    value: '{{resolve:secretsmanager::SecretString:k}}',
    poisoned: false,
    needle: 'SECRET_ID is required',
  },
  {
    site: 'secretsmanager no SecretString',
    value: `{{resolve:secretsmanager:${POISON}Secret:SecretString:k}}`,
    poisoned: true,
    needle: 'does not contain a SecretString value',
  },
  {
    site: 'secretsmanager JSON key not found',
    value: `{{resolve:secretsmanager:s:SecretString:${POISON}Key}}`,
    poisoned: true,
    needle: 'not found in secret',
  },
  {
    site: 'secretsmanager value not JSON',
    value: `{{resolve:secretsmanager:${POISON}Secret:SecretString:k}}`,
    poisoned: true,
    needle: 'is not valid JSON',
  },
  {
    site: 'ssm empty PARAMETER_NAME',
    value: '{{resolve:ssm:}}',
    poisoned: false,
    needle: 'PARAMETER_NAME is required',
  },
  {
    site: 'ssm parameter has no value',
    value: `{{resolve:ssm:${POISON}Param}}`,
    poisoned: true,
    needle: 'not found or has no value',
  },
];

/** Per-row AWS answers, set before the row runs. */
const AWS_SETUP: Record<string, () => void> = {
  'secretsmanager no SecretString': () => {
    aws.secret = { SecretBinary: new Uint8Array([1]) };
  },
  'secretsmanager JSON key not found': () => {
    aws.secret = { SecretString: JSON.stringify({ other: 'v' }) };
  },
  'secretsmanager value not JSON': () => {
    aws.secret = { SecretString: 'not-json' };
  },
  'ssm parameter has no value': () => {
    aws.ssm = { Parameter: {} };
  },
  'Fn::GetStackOutput output missing from a CloudFormation stack': () => {
    aws.cfnStacks = [
      { StackName: 'Producer', Outputs: [{ OutputKey: 'Other', OutputValue: 'v' }] },
    ];
  },
};

async function thrownBy(row: Row): Promise<Error> {
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const context = {
    template: row.template ?? ({ Resources: {} } as CloudFormationTemplate),
    resources: {},
    stackName: row.stackName ?? 'Consumer',
    recordedSecretValues: new Map<string, string>(),
    ...(row.stateBackend && { stateBackend: row.stateBackend as S3StateBackend }),
  };
  try {
    await resolver.resolve(row.value, context as never);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`${row.site}: expected the resolver to throw`);
}

describe('terminal bare-Error resolver throws are non-retryable (#1889)', () => {
  beforeEach(() => {
    aws.ec2 = 'empty';
    aws.secret = {};
    aws.ssm = {};
    aws.cfnStacks = [];
    aws.cfnThrottle = false;
    aws.lookup5xx = false;
  });

  it('PREMISE: the poison is a retryable message pattern', () => {
    expect(RETRYABLE_ERROR_MESSAGE_PATTERNS).toContain(POISON);
  });

  for (const row of ROWS) {
    it(`${row.site} is marked non-retryable`, async () => {
      AWS_SETUP[row.site]?.();
      const error = await thrownBy(row);
      expect(error.message).toContain(row.needle);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(isRetryableTransientError(error, error.message)).toBe(false);
      if (row.poisoned) {
        // The message really carries the pattern, so without the marker the
        // classifier would retry it: the marker is what decides.
        expect(error.message).toContain(POISON);
        const twin = new Error(error.message);
        expect(isRetryableTransientError(twin, twin.message)).toBe(true);
      }
    });
  }

  it('resolveParameters: a required parameter with no value is marked non-retryable', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const error = await resolver
      .resolveParameters({
        Resources: {},
        Parameters: { [`${POISON}Param`]: { Type: 'String' } },
      } as unknown as CloudFormationTemplate)
      .then(
        () => {
          throw new Error('expected resolveParameters to throw');
        },
        (e: unknown) => e as Error
      );
    expect(error.message).toContain('is required but no value was provided');
    expect(error.message).toContain(POISON);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isRetryableTransientError(error, error.message)).toBe(false);
    expect(isRetryableTransientError(new Error(error.message), error.message)).toBe(true);
  });

  it('CONTROL: a THROTTLED Fn::GetAZs describe stays unmarked and retryable', async () => {
    // A relayed AWS failure, so its retryability is the classifiers' call.
    aws.ec2 = 'throttle';
    const error = await thrownBy({
      site: 'Fn::GetAZs describe failure',
      value: { 'Fn::GetAZs': 'us-east-1' },
      poisoned: false,
      needle: '',
    });
    expect(error.message).toContain('failed to describe availability zones');
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
  });

  describe('CONTROLS: possibly-transient failures stay unmarked', () => {
    const expectUnmarked = (error: Error, needle: string): void => {
      expect(error.message).toContain(needle);
      expect(isMarkedNonRetryable(error)).toBe(false);
    };
    const throttledGetState: Partial<S3StateBackend> = {
      getState: vi.fn(async () => {
        throw awsError('SlowDown', 'Please reduce your request rate.', 503);
      }) as never,
      listStacks: vi.fn(async () => [{ stackName: 'Producer', region: 'us-east-1' }]) as never,
    };

    it('Fn::ImportValue not-found after a THROTTLED ListExports is unmarked', async () => {
      aws.cfnThrottle = true;
      const error = await thrownBy({
        site: 'import after throttled ListExports',
        value: { 'Fn::ImportValue': 'Missing' },
        stateBackend: noState,
        poisoned: false,
        needle: '',
      });
      expectUnmarked(error, 'not found in any stack');
    });

    it('Fn::ImportValue not-found after a SWALLOWED per-stack state read failure is unmarked', async () => {
      const error = await thrownBy({
        site: 'import after throttled state read',
        value: { 'Fn::ImportValue': 'Missing' },
        stateBackend: throttledGetState,
        poisoned: false,
        needle: '',
      });
      expect(throttledGetState.getState).toHaveBeenCalled();
      expectUnmarked(error, 'not found in any stack');
    });

    it('Fn::GetStackOutput stack-not-found after a THROTTLED DescribeStacks is unmarked', async () => {
      aws.cfnThrottle = true;
      const error = await thrownBy({
        site: 'stack output after throttled DescribeStacks',
        value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'o' } },
        stateBackend: noState,
        poisoned: false,
        needle: '',
      });
      expectUnmarked(error, 'not found in region');
    });

    it('Fn::GetStackOutput with a THROTTLED producer state read relays a retryable error', async () => {
      const error = await thrownBy({
        site: 'stack output state read throttled',
        value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'o' } },
        stateBackend: throttledGetState,
        poisoned: false,
        needle: '',
      });
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(isRetryableTransientError(error, error.message)).toBe(true);
    });

    for (const [service, value] of [
      ['SSM GetParameter', '{{resolve:ssm:SomeParam}}'],
      ['Secrets Manager GetSecretValue', '{{resolve:secretsmanager:s:SecretString:k}}'],
    ] as const) {
      it(`a 5xx from ${service} relays unmarked and retryable`, async () => {
        aws.lookup5xx = true;
        const error = await thrownBy({ site: service, value, poisoned: false, needle: '' });
        expect(isMarkedNonRetryable(error)).toBe(false);
        expect(isRetryableTransientError(error, error.message)).toBe(true);
      });
    }
  });
});
