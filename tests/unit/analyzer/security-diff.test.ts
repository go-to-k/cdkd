import { describe, it, expect } from 'vite-plus/test';
import { diffSecurity, securityDiffTemplates } from '../../../src/analyzer/security-diff.js';
import type { PropertyChange, ResourceChange, ResourceState } from '../../../src/types/state.js';

const BUCKET_ARN = 'arn:aws:s3:::my-bucket';

const policyDoc = (...statements: Array<Record<string, unknown>>) => ({
  Version: '2012-10-17',
  Statement: statements,
});
const allow = (action: string, resource: unknown = BUCKET_ARN) => ({
  Effect: 'Allow',
  Action: action,
  Resource: resource,
});

const policyProps = (doc: unknown) => ({
  PolicyName: 'P',
  Roles: ['my-role'],
  PolicyDocument: doc,
});

const record = (resourceType: string, properties: Record<string, unknown>): ResourceState =>
  ({ physicalId: 'p', resourceType, properties }) as ResourceState;

const verdict = async (changes: ResourceChange[], records: Record<string, ResourceState> = {}) =>
  (await diffSecurity({ stackName: 'S', changes, records })).broadening;

describe('diffSecurity (go-to-k/cdkd#4601)', () => {
  it('an IAM policy gaining a statement broadens', async () => {
    const before = policyProps(policyDoc(allow('s3:GetObject')));
    const change: ResourceChange = {
      logicalId: 'Pol',
      changeType: 'UPDATE',
      resourceType: 'AWS::IAM::Policy',
      currentProperties: before,
      propertyChanges: [
        {
          path: 'PolicyDocument',
          oldValue: before.PolicyDocument,
          newValue: policyDoc(allow('s3:GetObject'), allow('s3:PutObject')),
          requiresReplacement: false,
        },
      ],
    };
    const result = await diffSecurity({
      stackName: 'S',
      changes: [change],
      records: { Pol: record('AWS::IAM::Policy', before) },
    });
    expect(result.broadening).toBe(true);
    expect(result.rendered).toContain('s3:PutObject');
  });

  it('an IAM policy losing a statement does not broaden', async () => {
    const before = policyProps(policyDoc(allow('s3:GetObject'), allow('s3:PutObject')));
    const change: ResourceChange = {
      logicalId: 'Pol',
      changeType: 'UPDATE',
      resourceType: 'AWS::IAM::Policy',
      currentProperties: before,
      propertyChanges: [
        {
          path: 'PolicyDocument',
          oldValue: before.PolicyDocument,
          newValue: policyDoc(allow('s3:GetObject')),
          requiresReplacement: false,
        },
      ],
    };
    expect(await verdict([change], { Pol: record('AWS::IAM::Policy', before) })).toBe(false);
  });

  it('a new security-group ingress rule broadens; a non-security change does not', async () => {
    const sgBefore = { GroupDescription: 'sg', SecurityGroupIngress: [] };
    const sgChange: ResourceChange = {
      logicalId: 'Sg',
      changeType: 'UPDATE',
      resourceType: 'AWS::EC2::SecurityGroup',
      currentProperties: sgBefore,
      propertyChanges: [
        {
          path: 'SecurityGroupIngress',
          oldValue: [],
          newValue: [{ CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 22, ToPort: 22 }],
          requiresReplacement: false,
        },
      ],
    };
    expect(await verdict([sgChange])).toBe(true);

    const queue: ResourceChange = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      currentProperties: { VisibilityTimeout: 30 },
      propertyChanges: [
        { path: 'VisibilityTimeout', oldValue: 30, newValue: 60, requiresReplacement: false },
      ],
    };
    expect(await verdict([queue])).toBe(false);
  });

  it('a created role with an inline policy broadens; a deleted one does not', async () => {
    const roleProps = {
      AssumeRolePolicyDocument: policyDoc({
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }),
    };
    expect(
      await verdict([
        {
          logicalId: 'Role',
          changeType: 'CREATE',
          resourceType: 'AWS::IAM::Role',
          desiredProperties: roleProps,
        },
      ])
    ).toBe(true);
    expect(
      await verdict(
        [
          {
            logicalId: 'Role',
            changeType: 'DELETE',
            resourceType: 'AWS::IAM::Role',
            currentProperties: roleProps,
          },
        ],
        { Role: record('AWS::IAM::Role', roleProps) }
      )
    ).toBe(false);
  });

  it('a new AWS::Lambda::Permission broadens', async () => {
    expect(
      await verdict([
        {
          logicalId: 'Perm',
          changeType: 'CREATE',
          resourceType: 'AWS::Lambda::Permission',
          desiredProperties: {
            Action: 'lambda:InvokeFunction',
            FunctionName: 'fn',
            Principal: 's3.amazonaws.com',
          },
        },
      ])
    ).toBe(true);
  });

  it('a propagated reference change alone does not broaden (the template did not change)', async () => {
    const before = policyProps(policyDoc(allow('s3:GetObject')));
    const change: ResourceChange = {
      logicalId: 'Pol',
      changeType: 'UPDATE',
      resourceType: 'AWS::IAM::Policy',
      currentProperties: before,
      propertyChanges: [
        {
          path: 'PolicyDocument',
          oldValue: before.PolicyDocument,
          newValue: policyDoc(allow('s3:GetObject', { 'Fn::GetAtt': ['Bucket', 'Arn'] })),
          requiresReplacement: false,
          replacementPropagated: true,
        },
      ],
    };
    expect(await verdict([change], { Pol: record('AWS::IAM::Policy', before) })).toBe(false);
    // ...while the same change as a real template edit does.
    const real = { ...change, propertyChanges: [{ ...change.propertyChanges![0]!, replacementPropagated: undefined }] };
    expect(await verdict([real], { Pol: record('AWS::IAM::Policy', before) })).toBe(true);
  });

  describe('secretMask (the deploy prompt prints resolved values)', () => {
    const NEEDLE = 'ext-id-s3cr3t-4601';
    const mask = (text: string) => text.split(NEEDLE).join('***');
    // A NoEcho parameter's value inside a policy string (an ExternalId condition).
    const trustBefore = policyDoc();
    const trustUpdate: ResourceChange = {
      logicalId: 'Trust',
      changeType: 'UPDATE',
      resourceType: 'AWS::IAM::Policy',
      currentProperties: policyProps(trustBefore),
      propertyChanges: [
        {
          path: 'PolicyDocument',
          oldValue: trustBefore,
          newValue: policyDoc({
            ...allow('s3:GetObject'),
            Condition: { StringEquals: { 'sts:ExternalId': `prefix-${NEEDLE}` } },
          }),
          requiresReplacement: false,
        },
      ],
    };
    const sgCreate: ResourceChange = {
      logicalId: 'Sg',
      changeType: 'CREATE',
      resourceType: 'AWS::EC2::SecurityGroup',
      desiredProperties: {
        GroupDescription: 'sg',
        SecurityGroupIngress: [{ CidrIp: '10.1.2.0/24', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }],
      },
    };

    it('masks a value holding a secret, decides on it, and still prints the rest', async () => {
      const result = await diffSecurity({
        stackName: 'S',
        changes: [trustUpdate, sgCreate],
        records: {},
        secretMask: () => mask,
      });
      expect(result.broadening).toBe(true);
      expect(result.rendered).not.toContain('s3cr3t');
      expect(result.rendered).toContain('10.1.2.0/24');
      expect(result.rendered).toContain('(Values that hold a secret are shown as ***.)');
      // The statement around the secret is still shown.
      expect(result.rendered).toContain('sts:ExternalId');
      // The secret-bearing change alone still asks.
      const alone = await diffSecurity({
        stackName: 'S',
        changes: [trustUpdate],
        records: {},
        secretMask: () => mask,
      });
      expect(alone.broadening).toBe(true);
      expect(alone.rendered).not.toContain('s3cr3t');
    });

    it('prints a value the mask does not hide', async () => {
      const result = await diffSecurity({
        stackName: 'S',
        changes: [sgCreate],
        records: {},
        secretMask: () => mask,
      });
      expect(result.rendered).toContain('10.1.2.0/24');
      expect(result.rendered).not.toContain('shown as ***');
    });

    it('masks a whole object whose secret keys would collide, never dropping one', async () => {
      const keyMask = (text: string) => text.replace(/key-[ab]-s3cr3t/g, '***');
      const result = await diffSecurity({
        stackName: 'S',
        changes: [
          {
            logicalId: 'Pol',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Policy',
            desiredProperties: policyProps(
              policyDoc({
                ...allow('s3:GetObject'),
                Condition: { StringEquals: { 'key-a-s3cr3t': 'x', 'key-b-s3cr3t': 'y' } },
              })
            ),
          },
        ],
        records: {},
        secretMask: () => keyMask,
      });
      expect(result.broadening).toBe(true);
      expect(result.rendered).not.toContain('s3cr3t');
      expect(result.rendered).toContain('s3:GetObject');
    });

    it('masks a Number NoEcho value used as a port', async () => {
      const portMask = (text: string) => text.split('8443').join('***');
      const result = await diffSecurity({
        stackName: 'S',
        changes: [
          {
            ...sgCreate,
            desiredProperties: {
              GroupDescription: 'sg',
              SecurityGroupIngress: [{ CidrIp: '10.1.2.0/24', IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443 }],
            },
          },
        ],
        records: {},
        secretMask: () => portMask,
      });
      expect(result.broadening).toBe(true);
      expect(result.rendered).not.toContain('8443');
      expect(result.rendered).toContain('10.1.2.0/24');
    });

    it('masks a secret in an unchanged property the table shows as context', async () => {
      const before = { PolicyName: 'P', Roles: [`app-${NEEDLE}`], PolicyDocument: policyDoc(allow('s3:GetObject')) };
      const result = await diffSecurity({
        stackName: 'S',
        changes: [
          {
            logicalId: 'Pol',
            changeType: 'UPDATE',
            resourceType: 'AWS::IAM::Policy',
            currentProperties: before,
            propertyChanges: [
              {
                path: 'PolicyDocument',
                oldValue: before.PolicyDocument,
                newValue: policyDoc(allow('s3:GetObject'), allow('s3:PutObject')),
                requiresReplacement: false,
              },
            ],
          },
        ],
        records: {},
        secretMask: () => mask,
      });
      expect(result.broadening).toBe(true);
      expect(result.rendered).toContain('s3:PutObject');
      expect(result.rendered).not.toContain(NEEDLE);
    });

    it.each([
      [
        'cannot be built',
        () => {
          throw new Error('no masker');
        },
      ],
      [
        'throws',
        () => () => {
          throw new Error('mask failed');
        },
      ],
    ])('fails closed when the mask %s: no table, the verdict stands', async (_, secretMask) => {
      const result = await diffSecurity({
        stackName: 'S',
        changes: [trustUpdate, sgCreate],
        records: {},
        secretMask,
      });
      expect(result.broadening).toBe(true);
      expect(result.rendered).toBe(
        'The security changes are not shown: they could not be checked for secrets.\n'
      );
    });
  });

  describe('a masked value whose expression changed (go-to-k/cdkd#4543)', () => {
    const maskedUpdate = (resourceType: string, path: string, other: PropertyChange[] = []): ResourceChange => ({
      logicalId: 'X',
      changeType: 'UPDATE',
      resourceType,
      currentProperties: { [path]: '***' },
      propertyChanges: [
        { path, oldValue: '***', newValue: '***', requiresReplacement: false, maskedExpressionChanged: true },
        ...other,
      ],
    });

    it.each([
      ['AWS::IAM::Policy', 'PolicyDocument'],
      ['AWS::IAM::Role', 'AssumeRolePolicyDocument'],
      ['AWS::EC2::SecurityGroup', 'SecurityGroupIngress'],
      ['AWS::Lambda::Permission', 'Principal'],
      ['AWS::S3::BucketPolicy', 'PolicyDocument'],
    ])('in a security property of %s (%s) cannot be judged, so it asks', async (type, path) => {
      const result = await diffSecurity({ stackName: 'S', changes: [maskedUpdate(type, path)], records: {} });
      expect(result.broadening).toBe(true);
      expect(result.rendered).toContain(
        'These changed values are masked, so whether they broaden permissions could not be evaluated:'
      );
      expect(result.rendered).toContain(`  X (${type}): ${path}`);
    });

    it('in a property the security diff does not read does not ask', async () => {
      const result = await diffSecurity({
        stackName: 'S',
        changes: [maskedUpdate('AWS::SSM::Parameter', 'Value'), maskedUpdate('AWS::IAM::Role', 'Description')],
        records: {},
      });
      expect(result.broadening).toBe(false);
      expect(result.rendered).toBe('');
    });

    it('an unchanged masked policy beside another change does not ask', async () => {
      const result = await diffSecurity({
        stackName: 'S',
        changes: [
          {
            logicalId: 'X',
            changeType: 'UPDATE',
            resourceType: 'AWS::IAM::Role',
            currentProperties: { AssumeRolePolicyDocument: '***', Description: 'a' },
            propertyChanges: [{ path: 'Description', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
          },
        ],
        records: {},
      });
      expect(result.broadening).toBe(false);
    });
  });

  it('an empty change list does not broaden', async () => {
    expect(await diffSecurity({ stackName: 'S', changes: [], records: {} })).toEqual({
      broadening: false,
      rendered: '',
    });
  });
});

describe('securityDiffTemplates', () => {
  it('builds an UPDATE from the record plus the diff values, untouched keys equal on both sides', () => {
    const current = { PolicyName: 'P', Roles: ['r'], PolicyDocument: { a: 1 } };
    const { oldTemplate, newTemplate } = securityDiffTemplates(
      [
        {
          logicalId: 'Pol',
          changeType: 'UPDATE',
          resourceType: 'AWS::IAM::Policy',
          currentProperties: current,
          desiredProperties: { PolicyDocument: { 'Fn::Join': ['', []] } },
          propertyChanges: [
            { path: 'PolicyDocument', oldValue: { a: 1 }, newValue: { b: 2 }, requiresReplacement: false },
            { path: 'Roles', oldValue: ['r'], newValue: undefined, requiresReplacement: false },
          ],
        },
        { logicalId: 'Same', changeType: 'NO_CHANGE', resourceType: 'AWS::IAM::Policy' },
      ],
      {}
    );
    expect(oldTemplate.Resources).toEqual({
      Pol: { Type: 'AWS::IAM::Policy', Properties: current },
    });
    expect(newTemplate.Resources).toEqual({
      Pol: { Type: 'AWS::IAM::Policy', Properties: { PolicyName: 'P', PolicyDocument: { b: 2 } } },
    });
  });

  it('a type change puts the recorded type on the old side and the template on the new', () => {
    const { oldTemplate, newTemplate } = securityDiffTemplates(
      [
        {
          logicalId: 'X',
          changeType: 'UPDATE',
          resourceType: 'AWS::IAM::ManagedPolicy',
          currentProperties: { a: 1 },
          desiredProperties: { b: 2 },
          propertyChanges: [
            { path: 'Type', oldValue: 'AWS::IAM::Policy', newValue: 'AWS::IAM::ManagedPolicy', requiresReplacement: true },
          ],
        },
      ],
      {}
    );
    expect(oldTemplate.Resources.X).toEqual({ Type: 'AWS::IAM::Policy', Properties: { a: 1 } });
    expect(newTemplate.Resources.X).toEqual({ Type: 'AWS::IAM::ManagedPolicy', Properties: { b: 2 } });
  });
});
