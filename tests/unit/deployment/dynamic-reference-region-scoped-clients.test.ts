import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Region-scoped lookup clients (issue
 * [#1957](https://github.com/go-to-k/cdkd/issues/1957)).
 *
 * WHY THIS FILE MOCKS THE SDK RATHER THAN `getAwsClients()`. Every other
 * resolver suite replaces `src/utils/aws-clients.js` wholesale with a plain
 * object, which is exactly what makes it unable to see this bug: the fake has
 * no region, so "which region answered?" is not a question it can be asked.
 * The subject here is precisely the region the lookup client is BUILT with, so
 * this file uses the REAL `AwsClients` — the real region comparison, the real
 * credential carry-over, the real safety gate — and fakes only the leaf SDK
 * client classes, whose constructor config is the assertion target.
 *
 * Responses are primed per (REGION, COMMAND) rather than with
 * `mockResolvedValueOnce`, so there is no `*Once` queue a test could leave
 * undrained.
 */

interface FakeClientConfig {
  region?: string;
  profile?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

interface FakeClient {
  /** The object the SDK client CONSTRUCTOR received — the assertion target. */
  ctorConfig: FakeClientConfig;
}

interface FakeSend {
  region: string | undefined;
  /**
   * The region the sending client was CONSTRUCTED with — `undefined` for a
   * region-less ambient bag, set for every bag `withRegion` derives.
   *
   * This is the discriminator for "which bag answered", and it exists because
   * the obvious alternative does not work: `ambient.ssm` is a LAZY getter, so
   * touching it inside an assertion CONSTRUCTS it and makes it the newest
   * instance — an `expect(ambient.ssm).not.toBe(instances.at(-1))` therefore
   * measures the assertion's own side effect rather than the code under test.
   */
  ctorRegion: string | undefined;
  command: string;
  input: unknown;
}

// Hoisted because the `vi.mock` factories below run during the import phase,
// i.e. BEFORE this module's own top-level bindings are initialised.
const {
  responses,
  profileRegion,
  ssmInstances,
  secretsInstances,
  ec2Instances,
  stsInstances,
  serviceDiscoveryInstances,
  ssmSends,
  secretSends,
  ec2Sends,
  serviceDiscoverySends,
  makeFakeClientClass,
} = vi.hoisted(() => {
  const responses = new Map<string, unknown>();
  /**
   * Stands in for a region that only `~/.aws/config` can supply — the `aws
   * configure` setup that neither an explicit config nor `AWS_REGION` can
   * describe, and the configuration issue #1957's disclosure was reachable on.
   */
  const profileRegion: { value?: string } = {};

  const makeFakeClientClass = (
    instances: FakeClient[],
    sends: FakeSend[],
    serviceLabel: string
  ): unknown =>
    class {
      readonly ctorConfig: FakeClientConfig;
      readonly config: { region: () => Promise<string>; profile?: string };
      /**
       * MEMOIZED, exactly like the real SDK: `@smithy/node-config-provider`'s
       * `loadConfig` wraps the region provider chain in `memoize`, so a
       * region-less client pins whatever the environment said at its FIRST
       * resolution and keeps using it afterwards. Modelling that is the whole
       * point — an unmemoized fake cannot express the case where the ambient
       * client is talking to a region the environment no longer names.
       */
      private resolved?: Promise<string>;

      constructor(ctorConfig: FakeClientConfig = {}) {
        this.ctorConfig = ctorConfig;
        this.config = {
          ...(ctorConfig.profile !== undefined && { profile: ctorConfig.profile }),
          region: () => this.resolveRegion(),
        };
        instances.push(this);
      }

      private resolveRegion(): Promise<string> {
        if (!this.resolved) {
          const region =
            this.ctorConfig.region || process.env['AWS_REGION'] || profileRegion.value;
          this.resolved = region
            ? Promise.resolve(region)
            : Promise.reject(new Error('Region is missing'));
        }
        return this.resolved;
      }

      async send(command: { input?: unknown; constructor: { name: string } }): Promise<unknown> {
        // Keyed on the region the client will ACTUALLY talk to, which for a
        // region-less client is the resolved one rather than the ctor arg.
        let region: string | undefined;
        try {
          region = await this.resolveRegion();
        } catch {
          region = undefined;
        }
        const name = command.constructor.name;
        sends.push({
          region,
          ctorRegion: this.ctorConfig.region,
          command: name,
          input: command.input,
        });
        const response = responses.get(`${String(region)}|${name}`);
        if (response === undefined) {
          throw new Error(`no ${serviceLabel} response primed for ${String(region)}|${name}`);
        }
        return response;
      }
      destroy(): void {}
    };

  return {
    responses,
    profileRegion,
    ssmInstances: [] as FakeClient[],
    secretsInstances: [] as FakeClient[],
    ec2Instances: [] as FakeClient[],
    stsInstances: [] as FakeClient[],
    serviceDiscoveryInstances: [] as FakeClient[],
    ssmSends: [] as FakeSend[],
    secretSends: [] as FakeSend[],
    ec2Sends: [] as FakeSend[],
    serviceDiscoverySends: [] as FakeSend[],
    makeFakeClientClass,
  };
});

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass(ssmInstances, ssmSends, 'ssm') };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretsInstances, secretSends, 'secretsmanager'),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, EC2Client: makeFakeClientClass(ec2Instances, ec2Sends, 'ec2') };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass(stsInstances, [], 'sts') };
});

vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ServiceDiscoveryClient: makeFakeClientClass(
      serviceDiscoveryInstances,
      serviceDiscoverySends,
      'servicediscovery'
    ),
  };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  isClientSafeRegion,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const AMBIENT_REGION = 'us-east-1';
const STACK_REGION = 'ap-northeast-1';
const OTHER_REGION = 'eu-west-1';
const PROFILE = 'cdkd-lane-1957';

const emptyContext: ResolverContext = { template: { Resources: {} }, resources: {} };

/** Prime a response for one (region, command) pair. */
function prime(region: string | undefined, command: string, response: unknown): void {
  responses.set(`${String(region)}|${command}`, response);
}

describe('IntrinsicFunctionResolver — region-scoped lookup clients (issue #1957)', () => {
  let savedRegion: string | undefined;
  let savedDefaultRegion: string | undefined;

  beforeEach(() => {
    savedRegion = process.env['AWS_REGION'];
    savedDefaultRegion = process.env['AWS_DEFAULT_REGION'];
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    responses.clear();
    delete profileRegion.value;
    for (const bag of [
      ssmInstances,
      secretsInstances,
      ec2Instances,
      stsInstances,
      serviceDiscoveryInstances,
    ]) {
      bag.length = 0;
    }
    for (const bag of [ssmSends, secretSends, ec2Sends, serviceDiscoverySends]) bag.length = 0;
    resetAccountInfoCache();
    // Every region resolves the same account; only the region is under test.
    for (const region of [AMBIENT_REGION, STACK_REGION, OTHER_REGION, 'us-west-2', 'undefined']) {
      prime(region === 'undefined' ? undefined : region, 'GetCallerIdentityCommand', {
        Account: '123456789012',
      });
    }
  });

  afterEach(() => {
    resetAwsClients();
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
    if (savedDefaultRegion === undefined) delete process.env['AWS_DEFAULT_REGION'];
    else process.env['AWS_DEFAULT_REGION'] = savedDefaultRegion;
  });

  /** Install an ambient singleton the way `deploy.ts` / `scrub.ts` do. */
  function installAmbient(region: string | undefined): AwsClients {
    const ambient = new AwsClients({ ...(region && { region }), profile: PROFILE });
    setAwsClients(ambient);
    return ambient;
  }

  describe('{{resolve:ssm:...}}', () => {
    it('reads the RESOLVER region, not the ambient one, and carries the profile across', async () => {
      // Issue #1957 site 1: `cdkd deploy` defaults to `--stack-concurrency 4`
      // and re-points the singleton per stack, so two stacks in different
      // regions race for ONE mutable global and stack B's GetParameter can run
      // against stack A's client. Without the fix this resolves
      // 'virginia-value'.
      installAmbient(AMBIENT_REGION);
      prime(AMBIENT_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'virginia-value', Type: 'String' },
      });
      prime(STACK_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'tokyo-value', Type: 'String' },
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const result = await resolver.resolveDynamicReferences(
        '{{resolve:ssm:/shared/db/password}}',
        emptyContext
      );

      expect(result).toBe('tokyo-value');
      expect(ssmSends).toHaveLength(1);
      expect(ssmSends[0]?.region).toBe(STACK_REGION);
      expect(ssmInstances).toHaveLength(1);
      expect(ssmInstances[0]?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
    });

    it('classifies a region-B SecureString as secret even when region A holds a plain String namesake', async () => {
      // Acceptance criterion 3 (issue #1957 site 2, `cdkd scrub --all`): the
      // clients are installed ONCE while stacks in several regions are
      // resolved, so a region-B `SecureString` was classified against region
      // A's `String` namesake, judged PUBLIC, and left in PLAINTEXT in
      // state.json — the GHSA-p5qg-v9gv-hc7w class. Without the fix
      // `recordedSecretValues` comes back EMPTY and the resolved value is
      // region A's 'public-config'.
      installAmbient(AMBIENT_REGION);
      prime(AMBIENT_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'public-config', Type: 'String' },
      });
      prime(STACK_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'tokyo-secret', Type: 'SecureString' },
      });

      const recordedSecretValues = new Map<string, string>();
      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const expression = '{{resolve:ssm:/shared/db/password}}';
      const result = await resolver.resolveDynamicReferences(expression, {
        ...emptyContext,
        recordedSecretValues,
      });

      expect(result).toBe('tokyo-secret');
      expect(recordedSecretValues.get('tokyo-secret')).toBe(expression);
      expect(recordedSecretValues.has('public-config')).toBe(false);
      expect(ssmSends.map((s) => s.region)).toEqual([STACK_REGION]);
    });

    it('resolves an AWS::SSM::Parameter::Value<> template default in the resolver region', async () => {
      installAmbient(AMBIENT_REGION);
      prime(AMBIENT_REGION, 'GetParameterCommand', { Parameter: { Value: 'ami-virginia' } });
      prime(STACK_REGION, 'GetParameterCommand', { Parameter: { Value: 'ami-tokyo' } });

      const template: CloudFormationTemplate = {
        Parameters: {
          ImageId: {
            Type: 'AWS::SSM::Parameter::Value<String>',
            Default: '/aws/service/ami-amazon-linux-latest/al2023-x86_64',
          },
        },
        Resources: {
          Instance: { Type: 'AWS::EC2::Instance', Properties: { ImageId: { Ref: 'ImageId' } } },
        },
      };
      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const parameters = await resolver.resolveParameters(template);

      expect(parameters['ImageId']).toBe('ami-tokyo');
      expect(ssmInstances[0]?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
    });
  });

  describe('{{resolve:secretsmanager:...}}', () => {
    it('reads the RESOLVER region, not the ambient one', async () => {
      installAmbient(AMBIENT_REGION);
      prime(AMBIENT_REGION, 'GetSecretValueCommand', { SecretString: 'virginia-password' });
      prime(STACK_REGION, 'GetSecretValueCommand', { SecretString: 'tokyo-password' });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:shared/db:SecretString}}',
        emptyContext
      );

      expect(result).toBe('tokyo-password');
      expect(secretSends.map((s) => s.region)).toEqual([STACK_REGION]);
      expect(secretsInstances).toHaveLength(1);
      expect(secretsInstances[0]?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
    });
  });

  describe('Fn::GetAtt EC2 attribute lookups', () => {
    it('describes an INSTANCE through a client in the resolver region', async () => {
      // A foreign-region client answers InvalidInstanceID.NotFound, which this
      // branch catches and degrades to the physical-id fallback — handing an
      // `i-...` to a consumer expecting an IP. Priming ONLY the resolver's
      // region is what makes the assertion discriminating: an ambient-region
      // call rejects and the value falls back to the instance id.
      installAmbient(AMBIENT_REGION);
      prime(STACK_REGION, 'DescribeInstancesCommand', {
        Reservations: [{ Instances: [{ PrivateIpAddress: '10.1.2.3' }] }],
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const result = await resolver.resolve(
        { 'Fn::GetAtt': ['MyInstance', 'PrivateIp'] },
        {
          template: { Resources: {} },
          resources: {
            MyInstance: {
              physicalId: 'i-0abc1957deadbeef',
              resourceType: 'AWS::EC2::Instance',
              properties: {},
            },
          },
        }
      );

      expect(result).toBe('10.1.2.3');
      expect(ec2Sends.map((s) => s.region)).toEqual([STACK_REGION]);
      expect(ec2Instances[0]?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
    });

    it('describes a LAUNCH TEMPLATE through a client in the resolver region', async () => {
      // Same shape; a foreign-region client would fall back to '$Latest'.
      installAmbient(AMBIENT_REGION);
      prime(STACK_REGION, 'DescribeLaunchTemplatesCommand', {
        LaunchTemplates: [{ LatestVersionNumber: 7 }],
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const result = await resolver.resolve(
        { 'Fn::GetAtt': ['MyLt', 'LatestVersionNumber'] },
        {
          template: { Resources: {} },
          resources: {
            MyLt: {
              physicalId: 'lt-0abc1957deadbeef',
              resourceType: 'AWS::EC2::LaunchTemplate',
              properties: {},
            },
          },
        }
      );

      expect(result).toBe('7');
      expect(ec2Sends.map((s) => s.region)).toEqual([STACK_REGION]);
      expect(ec2Instances[0]?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
    });
  });

  describe('the two lookups that used to build their own client (issue #1994)', () => {
    /** `Fn::GetAtt` against a VPC / namespace resource, with an empty state. */
    function getAtt(
      resolver: IntrinsicFunctionResolver,
      logicalId: string,
      resourceType: string,
      physicalId: string,
      attributeName: string
    ): Promise<unknown> {
      return resolver.resolve(
        { 'Fn::GetAtt': [logicalId, attributeName] },
        {
          template: { Resources: {} },
          resources: { [logicalId]: { physicalId, resourceType, properties: {} } },
        }
      );
    }

    const associatedVpc = {
      Vpcs: [
        {
          Ipv6CidrBlockAssociationSet: [
            { Ipv6CidrBlock: '2600:1f18::/56', Ipv6CidrBlockState: { State: 'associated' } },
          ],
        },
      ],
    };

    describe('AWS::EC2::VPC Ipv6CidrBlocks', () => {
      it('carries the credential configuration and reuses ONE client across lookups', async () => {
        // Both halves of issue #1994 in one case. The old
        // `new EC2Client({ region: this.resolverRegion })` carried NO profile
        // (so a `--profile` run reached the wrong account's VPC) and built a
        // fresh client — with its own socket pool, never destroyed — on EVERY
        // lookup, so a template with N dual-stack VPCs leaked N of them.
        installAmbient(AMBIENT_REGION);
        prime(STACK_REGION, 'DescribeVpcsCommand', associatedVpc);

        const resolver = new IntrinsicFunctionResolver(STACK_REGION);
        await expect(
          getAtt(resolver, 'VpcA', 'AWS::EC2::VPC', 'vpc-0aaa1994', 'Ipv6CidrBlocks')
        ).resolves.toEqual(['2600:1f18::/56']);
        await expect(
          getAtt(resolver, 'VpcB', 'AWS::EC2::VPC', 'vpc-0bbb1994', 'Ipv6CidrBlocks')
        ).resolves.toEqual(['2600:1f18::/56']);

        expect(ec2Sends.map((s) => s.command)).toEqual([
          'DescribeVpcsCommand',
          'DescribeVpcsCommand',
        ]);
        expect(ec2Instances).toHaveLength(1);
        expect(ec2Instances[0]?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
      });

      it('follows the AMBIENT region when the resolver was given none, not the us-east-1 guess', async () => {
        // The FAIL-OPEN half: `resolverRegion` substitutes `AWS_REGION` and
        // then a hard-coded `us-east-1`, so with neither set the lookup went to
        // us-east-1 while the ambient clients pointed elsewhere —
        // `InvalidVpcID.NotFound`, swallowed by the branch's catch, and an
        // EMPTY list handed to whatever consumed the attribute. Priming ONLY
        // the ambient's region is what makes this discriminating.
        installAmbient(OTHER_REGION);
        prime(OTHER_REGION, 'DescribeVpcsCommand', associatedVpc);

        const resolver = new IntrinsicFunctionResolver();
        await expect(
          getAtt(resolver, 'Vpc', 'AWS::EC2::VPC', 'vpc-0ccc1994', 'Ipv6CidrBlocks')
        ).resolves.toEqual(['2600:1f18::/56']);

        expect(ec2Sends.map((s) => s.region)).toEqual([OTHER_REGION]);
      });
    });

    describe('AWS::ServiceDiscovery::*Namespace HostedZoneId', () => {
      it('carries the credential configuration and reuses ONE client across lookups', async () => {
        installAmbient(AMBIENT_REGION);
        prime(STACK_REGION, 'GetNamespaceCommand', {
          Namespace: { Properties: { DnsProperties: { HostedZoneId: 'Z01994TOKYO' } } },
        });

        const resolver = new IntrinsicFunctionResolver(STACK_REGION);
        await expect(
          getAtt(
            resolver,
            'NsA',
            'AWS::ServiceDiscovery::PrivateDnsNamespace',
            'ns-aaa1994',
            'HostedZoneId'
          )
        ).resolves.toBe('Z01994TOKYO');
        await expect(
          getAtt(
            resolver,
            'NsB',
            'AWS::ServiceDiscovery::PublicDnsNamespace',
            'ns-bbb1994',
            'HostedZoneId'
          )
        ).resolves.toBe('Z01994TOKYO');

        expect(serviceDiscoverySends.map((s) => s.command)).toEqual([
          'GetNamespaceCommand',
          'GetNamespaceCommand',
        ]);
        expect(serviceDiscoveryInstances).toHaveLength(1);
        expect(serviceDiscoveryInstances[0]?.ctorConfig).toEqual({
          region: STACK_REGION,
          profile: PROFILE,
        });
      });

      it('follows the AMBIENT region when the resolver was given none, not the us-east-1 guess', async () => {
        // Same fail-open as the VPC sibling, with a worse degradation: this
        // branch returns `undefined` on a miss, which is a `Fn::GetAtt` that
        // silently disappears from the consuming property.
        installAmbient(OTHER_REGION);
        prime(OTHER_REGION, 'GetNamespaceCommand', {
          Namespace: { Properties: { DnsProperties: { HostedZoneId: 'Z01994IRELAND' } } },
        });

        const resolver = new IntrinsicFunctionResolver();
        await expect(
          getAtt(
            resolver,
            'Ns',
            'AWS::ServiceDiscovery::PrivateDnsNamespace',
            'ns-ccc1994',
            'HostedZoneId'
          )
        ).resolves.toBe('Z01994IRELAND');

        expect(serviceDiscoverySends.map((s) => s.region)).toEqual([OTHER_REGION]);
      });

      it('builds ONE client across ten lookups dispatched together', async () => {
        // SCOPE NOTE, measured rather than assumed: this case reds when the
        // cache is removed (ten clients, ten socket pools), but it does NOT
        // discriminate memoizing the PROMISE from memoizing the client — a
        // probe that awaited before the cache write still produced exactly one
        // client, because these ten callers serialize on `getAccountInfo`'s own
        // in-flight promise and reach the seam one at a time. The promise
        // memoization stays because the seam IS async and a caller that gets
        // there from a different await depth can interleave; this case is not
        // what proves it.
        installAmbient(AMBIENT_REGION);
        prime(STACK_REGION, 'GetNamespaceCommand', {
          Namespace: { Properties: { DnsProperties: { HostedZoneId: 'Z01994CONC' } } },
        });

        const resolver = new IntrinsicFunctionResolver(STACK_REGION);
        await Promise.all(
          Array.from({ length: 10 }, (_unused, i) =>
            getAtt(
              resolver,
              `Ns${i}`,
              'AWS::ServiceDiscovery::HttpNamespace',
              `ns-conc${i}`,
              'HostedZoneId'
            )
          )
        );

        expect(serviceDiscoverySends).toHaveLength(10);
        expect(serviceDiscoveryInstances).toHaveLength(1);
      });
    });
  });

  describe('Fn::GetAZs', () => {
    it('describes availability zones through a client in the REQUESTED region', async () => {
      installAmbient(AMBIENT_REGION);
      prime('us-west-2', 'DescribeAvailabilityZonesCommand', {
        AvailabilityZones: [{ ZoneName: 'us-west-2b' }, { ZoneName: 'us-west-2a' }],
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const result = await resolver.resolve({ 'Fn::GetAZs': 'us-west-2' }, emptyContext);

      expect(result).toEqual(['us-west-2a', 'us-west-2b']);
      expect(ec2Instances).toHaveLength(1);
      expect(ec2Instances[0]?.ctorConfig).toEqual({ region: 'us-west-2', profile: PROFILE });
    });

    it('falls back to the RESOLVER region when the template names no region', async () => {
      // The `Fn::GetAZs: ''` arm (a bare `{"Fn::GetAZs": ""}`, which CDK emits
      // for "this stack's region"). Untested until now, and its failure mode is
      // the silent one: the ambient client answers, the `region-name` filter
      // matches nothing, and an EMPTY list is cached as the resolved value.
      installAmbient(AMBIENT_REGION);
      prime(STACK_REGION, 'DescribeAvailabilityZonesCommand', {
        AvailabilityZones: [{ ZoneName: 'ap-northeast-1a' }],
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const result = await resolver.resolve({ 'Fn::GetAZs': '' }, emptyContext);

      expect(result).toEqual(['ap-northeast-1a']);
      expect(ec2Instances[0]?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
    });

    it('REFUSES a region-shaped-looking value that could escape the hostname', async () => {
      // BLOCKER: the `Fn::GetAZs` argument is template-derived and can arrive
      // via `Fn::ImportValue` or a parameter. Binding lookups to a region is
      // what made it able to select an SDK ENDPOINT, so the gate ships with the
      // binding. `evil.example.com#` turns the SSM endpoint template into
      // `https://ssm.evil.example.com/#.amazonaws.com` — a SigV4-SIGNED request
      // to an attacker-controlled host.
      installAmbient(AMBIENT_REGION);

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      await expect(
        resolver.resolve({ 'Fn::GetAZs': 'evil.example.com#' }, emptyContext)
      ).rejects.toThrow(/is not a valid AWS region name/);

      // The load-bearing assertion: NO client was constructed from it. A test
      // that only checked the throw would still pass if the client were built
      // first and the request merely failed afterwards.
      expect(ec2Instances).toHaveLength(0);
      expect(ec2Sends).toHaveLength(0);
    });

    it('REFUSES an empty availability-zone list instead of caching it', async () => {
      // Every enabled region has at least one AZ, so an empty list means the
      // call was answered by the wrong region's endpoint or the region is
      // opt-in and not enabled. `cachedAvailabilityZones` is module-global, so
      // storing one degenerate answer would replay it for the whole process.
      installAmbient(AMBIENT_REGION);
      prime('us-west-2', 'DescribeAvailabilityZonesCommand', { AvailabilityZones: [] });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      await expect(
        resolver.resolve({ 'Fn::GetAZs': 'us-west-2' }, emptyContext)
      ).rejects.toThrow(/no availability zones returned/);

      // Not cached: a second attempt must ask again rather than replay.
      prime('us-west-2', 'DescribeAvailabilityZonesCommand', {
        AvailabilityZones: [{ ZoneName: 'us-west-2a' }],
      });
      await expect(resolver.resolve({ 'Fn::GetAZs': 'us-west-2' }, emptyContext)).resolves.toEqual([
        'us-west-2a',
      ]);
    });
  });

  describe('Fn::GetStackOutput Region', () => {
    /** Minimal state backend that RECORDS the region it was asked for. */
    function recordingStateBackend(asked: Array<{ stackName: string; region: string }>) {
      return {
        getState: async (stackName: string, region: string) => {
          asked.push({ stackName, region });
          return null;
        },
      } as unknown as NonNullable<ResolverContext['stateBackend']>;
    }

    it('REFUSES a region that could escape the hostname or the state key', async () => {
      // The `Region` argument is template-derived — `{"Region": {"Ref": P}}`
      // resolves through `resolveValue` — and it reaches TWO trusted sinks:
      // a CloudFormationClient region (SigV4-signed DescribeStacks to
      // `https://cloudformation.<region>.amazonaws.com`) and an S3 STATE KEY
      // segment (`cdkd/{stack}/{region}/state.json`, where `../` traverses
      // within the state bucket). Pre-existing rather than introduced here,
      // but the gate is one call away and the sinks are this issue's subject.
      installAmbient(AMBIENT_REGION);
      const asked: Array<{ stackName: string; region: string }> = [];
      // `cfnFallback: false` is REQUIRED, not tidiness. It defaults TRUE, and
      // `@aws-sdk/client-cloudformation` is not in this file's `vi.mock` list,
      // so a resolver left on the default reaches the real CFn fallback and
      // issues a signed AWS call from a unit test — masked by the surrounding
      // `.catch(() => undefined)`, so the test passes either way.
      const resolver = new IntrinsicFunctionResolver(STACK_REGION, { cfnFallback: false });

      await expect(
        resolver.resolve(
          {
            'Fn::GetStackOutput': {
              StackName: 'Producer',
              OutputName: 'ApiUrl',
              Region: 'evil.example.com#',
            },
          },
          {
            template: { Resources: {} },
            resources: {},
            stateBackend: recordingStateBackend(asked),
          }
        )
      ).rejects.toThrow(/is not a valid AWS region name/);

      // Neither sink was reached: no state key was built from it...
      expect(asked).toEqual([]);
      // ...and no client was constructed for it.
      expect(ec2Instances).toHaveLength(0);
    });

    it('passes the CANONICAL region to the state key', async () => {
      // The client and the state key must agree on one spelling, so the
      // canonical (lowercased) form is what flows onward rather than the raw
      // template text.
      installAmbient(AMBIENT_REGION);
      const asked: Array<{ stackName: string; region: string }> = [];
      // See the sibling test above: the default `cfnFallback: true` would
      // reach the real CloudFormation client from a unit test.
      const resolver = new IntrinsicFunctionResolver(STACK_REGION, { cfnFallback: false });

      await resolver
        .resolve(
          {
            'Fn::GetStackOutput': {
              StackName: 'Producer',
              OutputName: 'ApiUrl',
              Region: 'US-WEST-2',
            },
          },
          {
            template: { Resources: {} },
            resources: {},
            stateBackend: recordingStateBackend(asked),
            bestEffort: true,
          }
        )
        .catch(() => undefined);

      expect(asked).toEqual([{ stackName: 'Producer', region: 'us-west-2' }]);
    });
  });

  describe('isClientSafeRegion', () => {
    it('accepts every real partition, including the four-letter eusc- prefix', () => {
      for (const region of [
        'us-east-1',
        'ap-southeast-7',
        'mx-central-1',
        'il-central-1',
        'us-gov-west-1',
        'cn-north-1',
        'us-iso-east-1',
        'us-isob-east-1',
        'eu-isoe-west-1',
        'us-isof-south-1',
        'eusc-de-east-1',
      ]) {
        expect(isClientSafeRegion(region), region).toBe(true);
      }
    });

    it('rejects anything that could leave the hostname label', () => {
      for (const bad of [
        'evil.example.com#',
        'evil.example.com',
        'ssm.attacker.io',
        'a/b',
        'x:1',
        'u@h',
        '..',
        '',
        'a'.repeat(40),
      ]) {
        expect(isClientSafeRegion(bad), bad).toBe(false);
      }
    });
  });

  describe('the client cache', () => {
    it('builds ONE scoped client per region and reuses it across lookups', async () => {
      installAmbient(AMBIENT_REGION);
      prime(STACK_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'tokyo-value', Type: 'String' },
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      // Two DIFFERENT expressions, so the instance value cache cannot be what
      // collapses the second lookup — the client cache has to be.
      await resolver.resolveDynamicReferences('{{resolve:ssm:/one}}', emptyContext);
      await resolver.resolveDynamicReferences('{{resolve:ssm:/two}}', emptyContext);

      expect(ssmSends).toHaveLength(2);
      expect(ssmInstances).toHaveLength(1);
    });

    it('keys the cache by REGION — two foreign regions get two clients', async () => {
      // Without this case the map could be keyed by a constant and stay green:
      // one foreign region cannot tell "cached correctly" from "cached
      // globally". Reachable in production through two `Fn::GetAZs` naming
      // different explicit regions.
      installAmbient(AMBIENT_REGION);
      prime('us-west-2', 'DescribeAvailabilityZonesCommand', {
        AvailabilityZones: [{ ZoneName: 'us-west-2a' }],
      });
      prime(OTHER_REGION, 'DescribeAvailabilityZonesCommand', {
        AvailabilityZones: [{ ZoneName: 'eu-west-1a' }],
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      await expect(resolver.resolve({ 'Fn::GetAZs': 'us-west-2' }, emptyContext)).resolves.toEqual([
        'us-west-2a',
      ]);
      await expect(
        resolver.resolve({ 'Fn::GetAZs': OTHER_REGION }, emptyContext)
      ).resolves.toEqual(['eu-west-1a']);

      expect(ec2Instances).toHaveLength(2);
      expect(ec2Instances.map((c) => c.ctorConfig.region).sort()).toEqual([OTHER_REGION, 'us-west-2']);
    });

    it('canonicalizes case, and BUILDS the scoped client for the lowercased region', async () => {
      // `--region AP-NORTHEAST-1` is documented reachable and the repo
      // lowercases elsewhere (`canonicalizeRegion`, issues #1795 / #1850).
      //
      // ASSERTION SHAPE, deliberately not the obvious one. The obvious test —
      // an uppercase region that MATCHES the ambient, asserting the ambient is
      // reused — is VACUOUS: with `canonicalizeRegion` deleted the value is no
      // longer region-shaped, so it takes a different arm and reaches the same
      // observable. That is the second time in this file's own history that an
      // assertion targeted a state BOTH the fixed and the broken code reach
      // (the first was a fake whose `config.region` was not a function). The
      // rule the two share: assert the DISCRIMINATOR — which client got built,
      // and with what region — never the convenient side effect.
      //
      // So: mismatch, and assert the constructed client's region is the
      // LOWERCASED form. Delete the canonicalization and this throws instead
      // (not region-shaped); break it and the client carries the wrong string.
      installAmbient(AMBIENT_REGION);
      prime(STACK_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'tokyo-value', Type: 'String' },
      });

      const resolver = new IntrinsicFunctionResolver('AP-NORTHEAST-1');
      const result = await resolver.resolveDynamicReferences('{{resolve:ssm:/p}}', emptyContext);

      expect(result).toBe('tokyo-value');
      expect(ssmInstances).toHaveLength(1);
      expect(ssmInstances[0]?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
      expect(ssmSends.map((x) => x.region)).toEqual([STACK_REGION]);
    });

    it('builds ONE scoped client under CONCURRENT first-time lookups', async () => {
      // `clientsForRegion` is synchronous, so today nothing can interleave
      // between its cache read and its cache write. This case exists to KEEP
      // that true: an earlier revision was async (it awaited the ambient's
      // region), and in that shape N concurrent first-time callers all missed
      // the cache, all derived, and N-1 client sets were used and never
      // destroyed — up to the deploy engine's default `concurrency: 10` per
      // foreign region, which falsified the "at most one per foreign region
      // per resolver" bound this map's own doc claims. Re-introduce an await
      // before the map write without memoizing the PROMISE and this reds.
      installAmbient(AMBIENT_REGION);
      prime(STACK_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'tokyo-value', Type: 'String' },
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      await Promise.all(
        Array.from({ length: 10 }, (_unused, i) =>
          resolver.resolveDynamicReferences(`{{resolve:ssm:/p${i}}}`, emptyContext)
        )
      );

      expect(ssmSends).toHaveLength(10);
      expect(ssmInstances).toHaveLength(1);
    });
  });

  describe('when the ambient clients are already correct', () => {
    it('uses the AMBIENT instance when the resolver region matches, constructing no extra client', async () => {
      const ambient = installAmbient(AMBIENT_REGION);
      prime(AMBIENT_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'virginia-value', Type: 'String' },
      });

      const resolver = new IntrinsicFunctionResolver(AMBIENT_REGION);
      const result = await resolver.resolveDynamicReferences(
        '{{resolve:ssm:/shared/db/password}}',
        emptyContext
      );

      expect(result).toBe('virginia-value');
      expect(ssmInstances).toHaveLength(1);
      // Not merely "one client" — it is the AMBIENT one, so nothing was
      // derived and no socket was opened behind the singleton's back.
      expect(ambient.ssm as unknown).toBe(ssmInstances[0]);
    });

    it('does NOT reuse an UNCONFIGURED ambient, even when the environment agrees', async () => {
      // `cdkd scrub` builds its clients with `...(options.region && { region })`,
      // so without `--region` the ambient has no CONFIGURED region. It is
      // tempting to resolve one and reuse the bag when it agrees — an earlier
      // revision did exactly that — but agreement cannot be established for a
      // bag whose members have not all decided yet. See the divergence case
      // below for what that costs. Only a CONFIGURED ambient is reusable.
      process.env['AWS_REGION'] = STACK_REGION;
      const ambient = installAmbient(undefined);
      prime(STACK_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'tokyo-value', Type: 'String' },
      });

      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const result = await resolver.resolveDynamicReferences('{{resolve:ssm:/p}}', emptyContext);

      expect(result).toBe('tokyo-value');
      // A DERIVED bag answered: the sending client was CONSTRUCTED with an
      // explicit region, which the region-less ambient never is. Asserting on
      // the send is what keeps this independent of the lazy getters.
      expect(ssmSends).toHaveLength(1);
      expect(ssmSends[0]?.ctorRegion).toBe(STACK_REGION);
      expect(ambient.configuredRegion).toBeUndefined();
    });

    it('does not scope when the resolver was given no region at all (API contract, not a shipped path)', async () => {
      // SCOPE NOTE, so this is not mistaken for production coverage: every
      // cdkd caller defaults the region BEFORE the constructor and passes a
      // `string` (`deploy.ts`, `scrub.ts`, `drift.ts`, `import.ts`,
      // `export.ts`, `diff-recursive.ts`, `rollback-executor.ts`), so this arm
      // is reachable only through the no-argument constructor. It is fenced
      // because the parameter is optional and the arm therefore exists — a
      // resolver that was told nothing must not re-point anything — not
      // because a shipped path depends on it. The user-visible consequence of
      // the arm being dead is recorded on `explicitRegion` and in the
      // changelog.
      const ambient = installAmbient(OTHER_REGION);
      prime(OTHER_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'ireland-value', Type: 'String' },
      });

      const resolver = new IntrinsicFunctionResolver();
      const result = await resolver.resolveDynamicReferences('{{resolve:ssm:/p}}', emptyContext);

      expect(result).toBe('ireland-value');
      expect(ambient.ssm as unknown).toBe(ssmInstances[0]);
    });
  });

  describe('when the ambient region cannot be proven equal (issue #1957 blocker 3)', () => {
    it('SCOPES when the ambient region is resolvable only from the profile', async () => {
      // THE disclosure case, and the polarity an earlier revision got backwards.
      // `aws configure` writes the region to `~/.aws/config`, and `cdkd scrub`
      // sets a client region only when `--region` is passed — so the ambient
      // has no configured region and no AWS_REGION. Declining to override there
      // fails OPEN: region B's reference is answered by region A, classified
      // against A's `String` namesake, and B's plaintext stays in state.json.
      //
      // Modelled with `profileRegion` and NO `AWS_REGION`: a region only the
      // shared config file supplies is exactly what `configuredRegion` cannot
      // see, so this case is the one an env-reading getter gets wrong.
      profileRegion.value = AMBIENT_REGION;
      installAmbient(undefined);
      prime(AMBIENT_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'public-config', Type: 'String' },
      });
      prime(STACK_REGION, 'GetParameterCommand', {
        Parameter: { Value: 'tokyo-secret', Type: 'SecureString' },
      });

      const recordedSecretValues = new Map<string, string>();
      const resolver = new IntrinsicFunctionResolver(STACK_REGION);
      const expression = '{{resolve:ssm:/shared/db/password}}';
      const result = await resolver.resolveDynamicReferences(expression, {
        ...emptyContext,
        recordedSecretValues,
      });

      expect(result).toBe('tokyo-secret');
      expect(recordedSecretValues.get('tokyo-secret')).toBe(expression);
      expect(ssmSends.map((s) => s.region)).toEqual([STACK_REGION]);
      expect(ssmInstances.at(-1)?.ctorConfig).toEqual({ region: STACK_REGION, profile: PROFILE });
    });

    it('is not fooled by an unconfigured ambient whose MEMBERS pinned DIFFERENT regions', async () => {
      // THE case that makes "ask the ambient what region it is" unsound, and
      // the reason only a CONFIGURED ambient may be reused.
      //
      // An unconfigured `AwsClients` is not a bag of clients, it is a bag of
      // DEFERRED constructions: `clientOptions` omits `region`, the getters are
      // lazy, and each member resolves and MEMOIZES its own region at its own
      // first construction — from an environment `deploy.ts`'s `switchRegion`
      // is actively mutating and restoring per stack.
      //
      // Sequence: `ssm` pins us-west-2; a sibling stack's `finally` restores
      // AWS_REGION to us-east-1; `secretsManager` is constructed only now and
      // pins us-east-1. Anything that measured `ssm` would have concluded the
      // bag was us-west-2 and reused it — and the GetSecretValue would have
      // been answered by us-east-1. That is issue #1957 Site 1 surviving
      // inside the arm meant to fix it, so this test's discriminator is WHICH
      // REGION ANSWERED THE SECRET, not which client object was used.
      const PINNED = 'us-west-2';
      process.env['AWS_REGION'] = PINNED;
      const ambient = installAmbient(undefined);
      // `ssm` decides first, while the environment still says us-west-2.
      await expect(ambient.ssm.config.region()).resolves.toBe(PINNED);

      // A sibling stack's teardown moves the environment on. `secretsManager`
      // has NOT been constructed yet, so it will pin the new value.
      process.env['AWS_REGION'] = AMBIENT_REGION;
      prime(PINNED, 'GetSecretValueCommand', { SecretString: 'oregon-password' });
      prime(AMBIENT_REGION, 'GetSecretValueCommand', { SecretString: 'virginia-password' });

      const resolver = new IntrinsicFunctionResolver(PINNED);
      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:shared/db:SecretString}}',
        emptyContext
      );

      expect(result).toBe('oregon-password');
      expect(secretSends.map((x) => x.region)).toEqual([PINNED]);
      // ...and it was answered by a DERIVED bag, not by the ambient's own
      // `secretsManager` (which would have carried no constructor region and
      // pinned us-east-1 from the moved environment).
      expect(secretSends[0]?.ctorRegion).toBe(PINNED);
    });
  });
});
