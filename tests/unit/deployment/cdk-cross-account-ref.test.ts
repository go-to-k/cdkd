import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  cdkCrossAccountRefRefusal,
  classifyCdkCrossAccountRef,
  describeInnermostAwsError,
  isGeneratedReaderRole,
  isLookupRoleDenial,
  producerLookupOver,
  producerLookupRoleArn,
  refuseUnreadableCdkCrossAccountRefs,
  roleArnShape,
  type RoleArnReference,
} from '../../../src/deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import { inferCrossStackStackDeps } from '../../../src/analyzer/cross-stack-deps.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  CONSUMER_ACCOUNT,
  PRODUCER_ACCOUNT,
  SECOND_CONSUMER_ACCOUNT,
  synthesizeCrossAccountApp,
  type SynthesizedApp,
} from './cdk-cross-account-fixture.js';

const LOOKUP_ROLE = `cdk-hnb659fds-lookup-role-${PRODUCER_ACCOUNT}-us-east-1`;

let generated: SynthesizedApp;
let partitionLiterals: SynthesizedApp;
let userFormatArn: SynthesizedApp;

beforeAll(() => {
  generated = synthesizeCrossAccountApp('generated');
  partitionLiterals = synthesizeCrossAccountApp('generated-partition-literals');
  userFormatArn = synthesizeCrossAccountApp('user-format-arn');
}, 120_000);

describe('the shapes aws-cdk-lib synthesizes for a cross-account reference', () => {
  it('writes the consumer RoleArn as Fn::Join over AWS::Partition, and S1 folds exactly that', () => {
    const roleArn = generated.reference['RoleArn'];
    expect(roleArn).toEqual({
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          expect.stringMatching(
            new RegExp(`^:iam::${PRODUCER_ACCOUNT}:role/ProducerPublishGetStackOutputRole`)
          ),
        ],
      ],
    });
    const shape = roleArnShape(roleArn);
    expect(shape).toMatchObject({ form: 'join', accountId: PRODUCER_ACCOUNT });
    expect(shape?.roleName).toMatch(/^ProducerPublishGetStackOutputRole/);
  });

  it('reads the producer artifact lookup role through AssemblyReader', () => {
    expect(generated.producer.lookupRoleArn).toBe(
      `arn:\${AWS::Partition}:iam::${PRODUCER_ACCOUNT}:role/${LOOKUP_ROLE}`
    );
  });

  it('detects the generated reference (S1 and S2)', () => {
    const shape = roleArnShape(generated.reference['RoleArn']);
    if (!shape) throw new Error('S1 did not hold');
    const verdict = classifyCdkCrossAccountRef(
      shape,
      'Producer',
      'us-east-1',
      producerLookupOver(generated.stacks)
    );
    expect(verdict).toEqual({
      kind: 'generated',
      shape,
      lookupRoleArn: `arn:aws:iam::${PRODUCER_ACCOUNT}:role/${LOOKUP_ROLE}`,
    });
  });

  it('detects it with @aws-cdk/core:enablePartitionLiterals on (a literal RoleArn)', () => {
    const roleArn = partitionLiterals.reference['RoleArn'];
    expect(roleArn).toMatch(
      new RegExp(`^arn:aws:iam::${PRODUCER_ACCOUNT}:role/ProducerPublishGetStackOutputRole`)
    );
    const shape = roleArnShape(roleArn);
    expect(shape?.form).toBe('literal');
    const verdict = classifyCdkCrossAccountRef(
      shape!,
      'Producer',
      'us-east-1',
      producerLookupOver(partitionLiterals.stacks)
    );
    expect(verdict.kind).toBe('generated');
  });

  it('does NOT detect a user formatArn-built reader role (S1 holds, S2 does not)', () => {
    const shape = roleArnShape(userFormatArn.reference['RoleArn']);
    expect(shape).toEqual({ form: 'join', accountId: PRODUCER_ACCOUNT, roleName: 'cdkd-state-reader' });
    expect(
      classifyCdkCrossAccountRef(shape!, 'Producer', 'us-east-1', producerLookupOver(userFormatArn.stacks))
    ).toEqual({ kind: 'not-generated' });
  });

  it('a user literal RoleArn is not-generated, with or without a producer artifact', () => {
    const shape = roleArnShape(`arn:aws:iam::${PRODUCER_ACCOUNT}:role/cdkd-state-reader`);
    expect(shape?.form).toBe('literal');
    expect(
      classifyCdkCrossAccountRef(shape!, 'Producer', 'us-east-1', producerLookupOver(userFormatArn.stacks))
    ).toEqual({ kind: 'not-generated' });
    expect(classifyCdkCrossAccountRef(shape!, 'Producer', 'us-east-1', producerLookupOver([]))).toEqual({
      kind: 'not-generated',
    });
  });

  it('the generated Fn::Join with no producer artifact is producer-absent; a literal is not', () => {
    const lookup = producerLookupOver([generated.consumer]);
    const joinShape = roleArnShape(generated.reference['RoleArn'])!;
    expect(classifyCdkCrossAccountRef(joinShape, 'Producer', 'us-east-1', lookup)).toEqual({
      kind: 'producer-absent',
      shape: joinShape,
    });
    const literalShape = roleArnShape(partitionLiterals.reference['RoleArn'])!;
    expect(classifyCdkCrossAccountRef(literalShape, 'Producer', 'us-east-1', lookup)).toEqual({
      kind: 'not-generated',
    });
  });

  it('matches the producer by account and region too, not by stack name alone', () => {
    const shape = roleArnShape(generated.reference['RoleArn'])!;
    const lookup = producerLookupOver(generated.stacks);
    expect(classifyCdkCrossAccountRef(shape, 'Producer', 'eu-west-1', lookup).kind).toBe(
      'producer-absent'
    );
    expect(
      classifyCdkCrossAccountRef({ ...shape, accountId: '333333333333' }, 'Producer', 'us-east-1', lookup)
        .kind
    ).toBe('producer-absent');
  });

  it('a command that wires no producer lookup classifies nothing', () => {
    const shape = roleArnShape(generated.reference['RoleArn'])!;
    expect(classifyCdkCrossAccountRef(shape, 'Producer', 'us-east-1', undefined)).toEqual({
      kind: 'not-generated',
    });
  });

  it('a producer whose generated role is missing its lookup role names none', () => {
    const shape = roleArnShape(generated.reference['RoleArn'])!;
    const lookup = producerLookupOver([{ ...generated.producer, lookupRoleArn: undefined }]);
    const verdict = classifyCdkCrossAccountRef(shape, 'Producer', 'us-east-1', lookup);
    expect(verdict).toMatchObject({ kind: 'generated', lookupRoleArn: undefined });
  });
});

describe('roleArnShape (S1) refuses every other shape', () => {
  const tail = `:iam::${PRODUCER_ACCOUNT}:role/R`;
  it.each([
    ['Fn::Sub', { 'Fn::Sub': `arn:\${AWS::Partition}${tail}` }],
    ['a Ref', { Ref: 'RoleParam' }],
    ['a non-empty delimiter', { 'Fn::Join': ['-', ['arn:', { Ref: 'AWS::Partition' }, tail]] }],
    ['a fourth part', { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, tail, 'x']] }],
    ['another pseudo parameter', { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Region' }, tail]] }],
    ['an extra key', { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, tail]], x: 1 }],
    ['a role path', { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `${tail}/sub`]] }],
    ['a short account', { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::1:role/R']] }],
    ['a user ARN', `arn:aws:iam::${PRODUCER_ACCOUNT}:user/R`],
    ['a role with a path', `arn:aws:iam::${PRODUCER_ACCOUNT}:role/path/R`],
    ['an empty string', ''],
  ])('%s', (_label, raw) => {
    expect(roleArnShape(raw)).toBeUndefined();
  });
});

describe('isGeneratedReaderRole (S2)', () => {
  const role = (
    principal: unknown,
    type = 'AWS::IAM::Role'
  ): Parameters<typeof isGeneratedReaderRole>[0] => ({
    Resources: {
      R: {
        Type: type,
        Properties: {
          RoleName: 'Gen',
          AssumeRolePolicyDocument: {
            Statement: [{ Effect: 'Allow', Principal: principal, Action: ['sts:AssumeRole'] }],
          },
        },
      },
    },
  });
  const cfnExec = (account: string): unknown => ({
    'Fn::Sub': `arn:\${AWS::Partition}:iam::${account}:role/cdk-hnb659fds-cfn-exec-role-${account}-us-east-1`,
  });

  it('holds for an all-cfn-exec-role trust, one consumer or several', () => {
    expect(isGeneratedReaderRole(role({ AWS: cfnExec('222222222222') }), 'Gen')).toBe(true);
    expect(
      isGeneratedReaderRole(role({ AWS: [cfnExec('222222222222'), cfnExec('444444444444')] }), 'Gen')
    ).toBe(true);
  });

  it('refuses a trust naming anything that is not a cfn-exec role', () => {
    expect(
      isGeneratedReaderRole(role({ AWS: [cfnExec('222222222222'), { 'Fn::Sub': 'arn:aws:iam::222222222222:root' }] }), 'Gen')
    ).toBe(false);
    expect(isGeneratedReaderRole(role({ Service: 'lambda.amazonaws.com' }), 'Gen')).toBe(false);
    expect(isGeneratedReaderRole(role({ AWS: [] }), 'Gen')).toBe(false);
  });

  it('takes the Fn::Sub aws-cdk-lib writes, never a bare string principal', () => {
    // aws-cdk-lib wraps every consumer role in `Fn::Sub`; a user-written role
    // naming the same cfn-exec role as a plain string is not the generated one.
    expect(
      isGeneratedReaderRole(
        role({ AWS: 'arn:aws:iam::222222222222:role/cdk-hnb659fds-cfn-exec-role-222222222222-us-east-1' }),
        'Gen'
      )
    ).toBe(false);
  });

  it('matches the RoleName exactly', () => {
    expect(isGeneratedReaderRole(role({ AWS: cfnExec('222222222222') }), 'Other')).toBe(false);
  });

  it('requires the AWS::IAM::Role type', () => {
    expect(isGeneratedReaderRole(role({ AWS: cfnExec('222222222222') }, 'AWS::SSO::Role'), 'Gen')).toBe(
      false
    );
  });
});

describe('producerLookupRoleArn substitutes the producer region partition', () => {
  const raw = (account: string, region: string): string =>
    `arn:\${AWS::Partition}:iam::${account}:role/cdk-hnb659fds-lookup-role-${account}-${region}`;
  it.each([
    ['us-east-1', 'aws'],
    ['cn-north-1', 'aws-cn'],
    ['us-gov-west-1', 'aws-us-gov'],
  ])('%s -> %s', (region, partition) => {
    expect(producerLookupRoleArn(raw(PRODUCER_ACCOUNT, region), region, PRODUCER_ACCOUNT)).toBe(
      `arn:${partition}:iam::${PRODUCER_ACCOUNT}:role/cdk-hnb659fds-lookup-role-${PRODUCER_ACCOUNT}-${region}`
    );
  });

  it('refuses a lookup role of another account, an unparsable one, or none', () => {
    expect(producerLookupRoleArn(raw('333333333333', 'us-east-1'), 'us-east-1', PRODUCER_ACCOUNT)).toBe(
      undefined
    );
    expect(
      producerLookupRoleArn('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/x', 'us-east-1', PRODUCER_ACCOUNT)
    ).toBeUndefined();
    expect(producerLookupRoleArn(undefined, 'us-east-1', PRODUCER_ACCOUNT)).toBeUndefined();
    expect(producerLookupRoleArn('', 'us-east-1', PRODUCER_ACCOUNT)).toBeUndefined();
  });
});

describe('the refusal message', () => {
  const message = cdkCrossAccountRefRefusal({
    consumer: 'Consumer',
    output: 'PublishOutputRefTopic',
    producer: 'Producer',
    region: 'us-east-1',
    producerAccount: PRODUCER_ACCOUNT,
    roleName: 'ProducerPublishGetStackOutputRole66419B34',
    consumerAccount: CONSUMER_ACCOUNT,
    reason: 'assuming the lookup role X failed: AccessDenied',
  });

  it('names the reference, the generated role, the cause and both remedies', () => {
    for (const needle of [
      'output PublishOutputRefTopic of stack Producer',
      `region us-east-1, account ${PRODUCER_ACCOUNT}`,
      'for stack Consumer',
      'ProducerPublishGetStackOutputRole66419B34',
      'assuming the lookup role X failed: AccessDenied',
      `cdk bootstrap --trust-for-lookup ${CONSUMER_ACCOUNT}`,
      `--trust ${CONSUMER_ACCOUNT}`,
      "cdk.Fn.getStackOutput('Producer', 'PublishOutputRefTopic', 'us-east-1', '<roleArn>')",
      `s3:GetBucketLocation and s3:GetObject on cdkd-state-${PRODUCER_ACCOUNT}`,
      'https://cdkd.dev/cross-stack-references/#reading-from-another-account',
    ]) {
      expect(message).toContain(needle);
    }
  });

  it('prints the placeholder for a consumer account that is not 12 digits', () => {
    for (const account of ['22222222222\u001b[2K', '2222\u202e22222222', 'abc', '2222222222222']) {
      const text = cdkCrossAccountRefRefusal({
        consumer: 'Consumer',
        output: 'O',
        producer: 'Producer',
        region: 'us-east-1',
        producerAccount: PRODUCER_ACCOUNT,
        roleName: 'R',
        consumerAccount: account,
        reason: 'r',
      });
      expect(text, account).toContain("--trust-for-lookup <consumer-account>'");
      expect(text, account).not.toContain('\u001b');
      expect(text, account).not.toContain('\u202e');
    }
  });

  it('names a synthesizer remedy when the producer names no lookup role, and one period per join', () => {
    const base = {
      consumer: 'Consumer',
      output: 'O',
      producer: 'Producer',
      region: 'us-east-1',
      producerAccount: PRODUCER_ACCOUNT,
      roleName: 'R',
      consumerAccount: CONSUMER_ACCOUNT,
      reason: 'AWS said no.',
    };
    const bootstrap = cdkCrossAccountRefRefusal(base);
    expect(bootstrap).toContain(
      `(1) in account ${PRODUCER_ACCOUNT}, run 'cdk bootstrap --trust-for-lookup ${CONSUMER_ACCOUNT}'`
    );
    expect(bootstrap).not.toContain('synthesizer');
    expect(bootstrap).toContain('but AWS said no. Fix it');
    const synth = cdkCrossAccountRefRefusal({ ...base, noLookupRole: true });
    expect(synth).toContain(
      '(1) synthesize stack Producer with a stack synthesizer that names a lookup role ' +
        `(the default DefaultStackSynthesizer), and in account ${PRODUCER_ACCOUNT} run ` +
        `'cdk bootstrap --trust-for-lookup ${CONSUMER_ACCOUNT}'`
    );
    expect(synth).toContain(
      "(2) write the reference as cdk.Fn.getStackOutput('Producer', 'O', 'us-east-1', '<roleArn>')"
    );
  });

  it('describes the innermost AWS error of a wrapped failure', () => {
    const aws = Object.assign(new Error('User is not authorized.'), { name: 'AccessDenied' });
    const wrapped = new Error('AssumeRole into x failed: ... If this is a trust-policy issue.', {
      cause: aws,
    });
    expect(describeInnermostAwsError(wrapped)).toBe('AccessDenied: User is not authorized.');
    expect(
      describeInnermostAwsError(
        new Error('outer', { cause: Object.assign(new Error('m'), { Code: 'NoSuchEntity' }) })
      )
    ).toBe('NoSuchEntity: m');
    expect(describeInnermostAwsError(new Error('plain'))).toBe('plain');
  });

  it('carries no issue number and no date', () => {
    expect(message).not.toMatch(/#\d/);
    expect(message).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  it('keeps an already-quoted (non-plain) value as it is rendered', () => {
    const quoted = cdkCrossAccountRefRefusal({
      consumer: undefined,
      output: '"a b"',
      producer: 'Producer',
      region: 'us-east-1',
      producerAccount: PRODUCER_ACCOUNT,
      roleName: 'R',
      consumerAccount: undefined,
      reason: 'r',
    });
    expect(quoted).toContain(`cdk.Fn.getStackOutput('Producer', "a b", 'us-east-1', '<roleArn>')`);
    expect(quoted).toContain('--trust-for-lookup <consumer-account>');
    expect(quoted).not.toContain('for stack');
  });
});

describe('the deploy pre-flight', () => {
  const consumerOf =
    (app: SynthesizedApp) =>
    (name: string): { region?: string | undefined; account?: string | undefined } => {
      const stack = app.stacks.find((s) => s.stackName === name);
      return { region: stack?.region, account: stack?.account };
    };
  const refsOf = (app: SynthesizedApp): RoleArnReference[] => {
    const refs: RoleArnReference[] = [];
    inferCrossStackStackDeps(app.stacks, {
      onRoleArnReference: (consumer, args) => refs.push({ consumer, args }),
    });
    return refs;
  };

  it('the cross-stack walk hands over exactly the RoleArn-carrying references', () => {
    const refs = refsOf(generated);
    expect(refs).toEqual([{ consumer: 'Consumer', args: generated.reference }]);
    const spy = vi.fn();
    inferCrossStackStackDeps(
      [
        {
          stackName: 'C',
          template: {
            Resources: {
              Q: {
                Type: 'AWS::SQS::Queue',
                Properties: {
                  QueueName: { 'Fn::GetStackOutput': { StackName: 'P', OutputName: 'O' } },
                },
              },
            },
          },
        },
      ],
      { onRoleArnReference: spy }
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes a readable generated reference', () => {
    expect(() =>
      refuseUnreadableCdkCrossAccountRefs(
        refsOf(generated),
        new Set(['Consumer']),
        consumerOf(generated),
        producerLookupOver(generated.stacks)
      )
    ).not.toThrow();
  });

  it('refuses a producer naming no lookup role, before anything is deployed', () => {
    const stacks = generated.stacks.map((s) =>
      s.stackName === 'Producer' ? { ...s, lookupRoleArn: undefined } : s
    );
    let caught: unknown;
    try {
      refuseUnreadableCdkCrossAccountRefs(
        refsOf(generated),
        new Set(['Consumer']),
        consumerOf(generated),
        producerLookupOver(stacks)
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isMarkedNonRetryable(caught)).toBe(true);
    expect((caught as Error).message).toContain('names no CDK lookup role');
    expect((caught as Error).message).toContain('(1) synthesize stack Producer with a stack synthesizer');
    expect((caught as Error).message).toContain(`--trust-for-lookup ${CONSUMER_ACCOUNT}`);
  });

  it('refuses the generated Fn::Join whose producer is not in the assembly', () => {
    expect(() =>
      refuseUnreadableCdkCrossAccountRefs(
        refsOf(generated),
        new Set(['Consumer']),
        consumerOf(generated),
        producerLookupOver([generated.consumer])
      )
    ).toThrow(/not in this app's cloud assembly/);
  });

  it('checks only the stacks being deployed, and leaves user roles alone', () => {
    const lookup = producerLookupOver([generated.consumer]);
    expect(() =>
      refuseUnreadableCdkCrossAccountRefs(refsOf(generated), new Set(['Producer']), consumerOf(generated), lookup)
    ).not.toThrow();
    expect(() =>
      refuseUnreadableCdkCrossAccountRefs(
        refsOf(userFormatArn),
        new Set(['Consumer']),
        consumerOf(userFormatArn),
        producerLookupOver(userFormatArn.stacks)
      )
    ).not.toThrow();
  });

  it('names the deployed consumer stack own account when one producer serves two consumers', () => {
    const app = synthesizeCrossAccountApp('two-consumers');
    const stacks = app.stacks.map((st) =>
      st.stackName === 'Producer' ? { ...st, lookupRoleArn: undefined } : st
    );
    const refuse = (consumer: string): string => {
      try {
        refuseUnreadableCdkCrossAccountRefs(
          refsOf(app),
          new Set([consumer]),
          consumerOf(app),
          producerLookupOver(stacks)
        );
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a refusal');
    };
    const second = refuse('ConsumerB');
    expect(second).toContain(`--trust-for-lookup ${SECOND_CONSUMER_ACCOUNT}'`);
    expect(second).not.toContain(CONSUMER_ACCOUNT);
    const first = refuse('Consumer');
    expect(first).toContain(`--trust-for-lookup ${CONSUMER_ACCOUNT}'`);
    expect(first).not.toContain(SECOND_CONSUMER_ACCOUNT);
  }, 60_000);

  it('skips a reference a deploy may never resolve (a Condition, an Fn::If, an Output)', () => {
    const ref = generated.reference;
    const template = {
      Conditions: { C: { 'Fn::Equals': ['a', 'b'] }, D: { 'Fn::Equals': [{ 'Fn::GetStackOutput': ref }, 'x'] } },
      Resources: {
        Guarded: { Type: 'AWS::SQS::Queue', Condition: 'C', Properties: { QueueName: { 'Fn::GetStackOutput': ref } } },
        Branch: {
          Type: 'AWS::SQS::Queue',
          Properties: { QueueName: { 'Fn::If': ['C', { 'Fn::GetStackOutput': ref }, 'q'] } },
        },
        Meta: { Type: 'AWS::SQS::Queue', Metadata: { M: { 'Fn::GetStackOutput': ref } } },
      },
      Outputs: { O: { Value: { 'Fn::GetStackOutput': ref } } },
    };
    const refs: RoleArnReference[] = [];
    const deps = inferCrossStackStackDeps(
      [{ stackName: 'Consumer', template }, generated.producer],
      { onRoleArnReference: (consumer, args) => refs.push({ consumer, args }) }
    );
    expect(refs).toEqual([]);
    // The ordering edge still sees every reference, as before.
    expect([...(deps.get('Consumer') ?? [])]).toEqual(['Producer']);
    const plain = { Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: { 'Fn::GetStackOutput': ref } } } } };
    inferCrossStackStackDeps([{ stackName: 'Consumer', template: plain }], {
      onRoleArnReference: (consumer, args) => refs.push({ consumer, args }),
    });
    expect(refs).toHaveLength(1);
  });
});

describe('isLookupRoleDenial', () => {
  const sdk = (name: string, status?: number): Error =>
    Object.assign(new Error(name), { name, ...(status && { $metadata: { httpStatusCode: status } }) });
  it.each([
    ['AssumeRole AccessDenied, wrapped', new Error('AssumeRole into x failed', { cause: sdk('AccessDenied') })],
    ['a wrapped state read 403', new Error('Failed to get state', { cause: sdk('Forbidden', 403) })],
    ['NoSuchEntity on the role', sdk('NoSuchEntity')],
    ['AccessDeniedException', sdk('AccessDeniedException')],
  ])('%s is a denial', (_label, error) => {
    expect(isLookupRoleDenial(error)).toBe(true);
  });
  it.each([
    ['a malformed record', new Error('State file has no body')],
    ['a missing bucket', new Error('x', { cause: sdk('NoSuchBucket', 404) })],
    ['throttling', sdk('ThrottlingException', 400)],
    ['a 5xx', sdk('InternalError', 500)],
    ['a network failure', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('%s is not', (_label, error) => {
    expect(isLookupRoleDenial(error)).toBe(false);
  });
});
