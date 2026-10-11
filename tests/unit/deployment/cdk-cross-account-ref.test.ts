import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  cdkCrossAccountRefRefusal,
  classifyCdkCrossAccountRef,
  generatedReaderRoleTrust,
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
      consumerAccounts: [CONSUMER_ACCOUNT],
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

describe('generatedReaderRoleTrust (S2)', () => {
  const role = (principal: unknown): Parameters<typeof generatedReaderRoleTrust>[0] => ({
    Resources: {
      R: {
        Type: 'AWS::IAM::Role',
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

  it('answers the consumer accounts of an all-cfn-exec-role trust', () => {
    expect(generatedReaderRoleTrust(role({ AWS: cfnExec('222222222222') }), 'Gen')).toEqual([
      '222222222222',
    ]);
    expect(
      generatedReaderRoleTrust(role({ AWS: [cfnExec('222222222222'), cfnExec('444444444444')] }), 'Gen')
    ).toEqual(['222222222222', '444444444444']);
  });

  it('refuses a trust naming anything that is not a cfn-exec role', () => {
    expect(
      generatedReaderRoleTrust(role({ AWS: [cfnExec('222222222222'), 'arn:aws:iam::222222222222:root'] }), 'Gen')
    ).toBeUndefined();
    expect(generatedReaderRoleTrust(role({ Service: 'lambda.amazonaws.com' }), 'Gen')).toBeUndefined();
    expect(generatedReaderRoleTrust(role({ AWS: [] }), 'Gen')).toBeUndefined();
  });

  it('matches the RoleName exactly', () => {
    expect(generatedReaderRoleTrust(role({ AWS: cfnExec('222222222222') }), 'Other')).toBeUndefined();
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
    consumerAccounts: [CONSUMER_ACCOUNT],
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
      consumerAccounts: [],
      reason: 'r',
    });
    expect(quoted).toContain(`cdk.Fn.getStackOutput('Producer', "a b", 'us-east-1', '<roleArn>')`);
    expect(quoted).toContain('--trust-for-lookup <consumer-account>');
    expect(quoted).not.toContain('for stack');
  });
});

describe('the deploy pre-flight', () => {
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
        () => 'us-east-1',
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
        () => 'us-east-1',
        producerLookupOver(stacks)
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isMarkedNonRetryable(caught)).toBe(true);
    expect((caught as Error).message).toContain('names no CDK lookup role');
    expect((caught as Error).message).toContain(`--trust-for-lookup ${CONSUMER_ACCOUNT}`);
  });

  it('refuses the generated Fn::Join whose producer is not in the assembly', () => {
    expect(() =>
      refuseUnreadableCdkCrossAccountRefs(
        refsOf(generated),
        new Set(['Consumer']),
        () => 'us-east-1',
        producerLookupOver([generated.consumer])
      )
    ).toThrow(/not in this app's cloud assembly/);
  });

  it('checks only the stacks being deployed, and leaves user roles alone', () => {
    const lookup = producerLookupOver([generated.consumer]);
    expect(() =>
      refuseUnreadableCdkCrossAccountRefs(refsOf(generated), new Set(['Producer']), () => 'us-east-1', lookup)
    ).not.toThrow();
    expect(() =>
      refuseUnreadableCdkCrossAccountRefs(
        refsOf(userFormatArn),
        new Set(['Consumer']),
        () => 'us-east-1',
        producerLookupOver(userFormatArn.stacks)
      )
    ).not.toThrow();
  });
});
