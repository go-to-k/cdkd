import { ACCOUNT, TAG_THROWS, createOnlyOf, setOutputOverrides, type Bag, type TypeCase } from './sdk-wire-harness.js';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';

/**
 * Wire cases for Cloud Map (#3723): the three namespace kinds and the
 * service. Run by `sdk-wire-coverage-cloudmap.test.ts`, which mocks the
 * clients the provider builds; the ledger in `sdk-wire-coverage.test.ts`
 * counts them as covered.
 */

const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

const NAMESPACE_ID = 'ns-1234567890abcdef';
const SERVICE_ID = 'srv-1234567890abcdef';

/**
 * Cloud Map's writes are operations polled to SUCCESS, which name the created
 * namespace; the reads answer the live resource the previous bag describes.
 */
function armCloudMap(physicalId: string, bag: Bag): void {
  const soa = (bag['Properties'] as { DnsProperties?: { SOA?: { TTL?: number } } } | undefined)
    ?.DnsProperties?.SOA;
  setOutputOverrides({
    GetOperationCommand: () => ({
      Operation: { Status: 'SUCCESS', Targets: { NAMESPACE: NAMESPACE_ID, SERVICE: SERVICE_ID } },
    }),
    CreateServiceCommand: () => ({
      Service: { Id: SERVICE_ID, Arn: `arn:aws:servicediscovery:us-east-1:${ACCOUNT}:service/${SERVICE_ID}` },
    }),
    GetNamespaceCommand: () => ({
      Namespace: {
        Id: physicalId,
        Arn: `arn:aws:servicediscovery:us-east-1:${ACCOUNT}:namespace/${physicalId}`,
        Name: bag['Name'],
        Description: bag['Description'],
        Properties: { DnsProperties: { HostedZoneId: 'Z1', ...(soa && { SOA: soa }) } },
      },
    }),
    GetServiceCommand: () => ({
      Service: {
        Id: physicalId,
        Arn: `arn:aws:servicediscovery:us-east-1:${ACCOUNT}:service/${physicalId}`,
        Name: bag['Name'],
        Description: bag['Description'],
      },
    }),
    GetServiceAttributesCommand: () => ({
      ServiceAttributes: { Attributes: (bag['ServiceAttributes'] ?? {}) as Record<string, string> },
    }),
  });
}

/** A namespace's schema requires `Name`: refused when absent, before any call. */
const NAMESPACE_NAME_REQUIRED = {
  why: 'the schema requires a namespace Name; refused when absent, before any call',
  says: /Name is required for/,
};

// A service's `Name` has no such entry: CloudFormation generates a name the
// template omits, and so does cdkd (go-to-k/cdkd#5348), so `create:Name`
// delivers a generated name instead of throwing.

/**
 * A field removed on its own keeps its live value, as CloudFormation does
 * (go-to-k/cdkd#1160, measured live); `UpdateService`'s `DnsConfigChange`
 * carries `DnsRecords` only, so `DnsConfig.NamespaceId` (deprecated for the
 * top-level `NamespaceId`) and `DnsConfig.RoutingPolicy` have no member to send
 * after the create. CloudFormation does not apply either (go-to-k/cdkd#5373,
 * measured: the update completes with no replacement and the service keeps
 * both), so cdkd sends nothing too and names them in a warning.
 */
const KEPT_ALONE = 'a field removed on its own keeps its live value, as in CloudFormation (#1160)';
const NO_CHANGE_MEMBER =
  "UpdateService's DnsConfigChange has no member for it; CloudFormation does not apply it either, and cdkd warns (#5373)";
const SERVICE_SILENT: Record<string, string> = {
  'update-remove:Description': KEPT_ALONE,
  'update-remove:DnsConfig': KEPT_ALONE,
  'update-remove:DnsConfig.DnsRecords': KEPT_ALONE,
  'update-remove:HealthCheckConfig': KEPT_ALONE,
  'update-add:DnsConfig.NamespaceId': NO_CHANGE_MEMBER,
  'update-remove:DnsConfig.NamespaceId': NO_CHANGE_MEMBER,
  'update-vary:DnsConfig.NamespaceId': NO_CHANGE_MEMBER,
  'update-add:DnsConfig.RoutingPolicy': NO_CHANGE_MEMBER,
  'update-remove:DnsConfig.RoutingPolicy': NO_CHANGE_MEMBER,
  'update-vary:DnsConfig.RoutingPolicy': NO_CHANGE_MEMBER,
};

const SOA_PROPERTIES = { DnsProperties: { SOA: { TTL: 60 } } };

export const CASES_CLOUDMAP: TypeCase[] = [
  {
    resourceType: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
    provider: () => new ServiceDiscoveryProvider(),
    physicalId: NAMESPACE_ID,
    createOnly: createOnlyOf('AWS::ServiceDiscovery::PrivateDnsNamespace'),
    arm: armCloudMap,
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Name: 'ns.local',
          Vpc: 'vpc-1',
          Description: 'd',
          Properties: SOA_PROPERTIES,
          Tags: TAGS,
        },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
          'create:Name': NAMESPACE_NAME_REQUIRED,
          'create:Vpc': {
            why: 'CreatePrivateDnsNamespace requires the VPC; refused before any call',
            says: /Vpc is required for/,
          },
        },
      },
    ],
  },
  {
    resourceType: 'AWS::ServiceDiscovery::HttpNamespace',
    provider: () => new ServiceDiscoveryProvider(),
    physicalId: NAMESPACE_ID,
    createOnly: createOnlyOf('AWS::ServiceDiscovery::HttpNamespace'),
    arm: armCloudMap,
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: { Name: 'ns', Description: 'd', Tags: TAGS },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
          'create:Name': NAMESPACE_NAME_REQUIRED,
        },
      },
    ],
  },
  {
    resourceType: 'AWS::ServiceDiscovery::PublicDnsNamespace',
    provider: () => new ServiceDiscoveryProvider(),
    physicalId: NAMESPACE_ID,
    createOnly: createOnlyOf('AWS::ServiceDiscovery::PublicDnsNamespace'),
    arm: armCloudMap,
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: { Name: 'example.com', Description: 'd', Properties: SOA_PROPERTIES, Tags: TAGS },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
          'create:Name': NAMESPACE_NAME_REQUIRED,
        },
      },
    ],
  },
  {
    resourceType: 'AWS::ServiceDiscovery::Service',
    provider: () => new ServiceDiscoveryProvider(),
    physicalId: SERVICE_ID,
    createOnly: createOnlyOf('AWS::ServiceDiscovery::Service'),
    arm: armCloudMap,
    exempt: {},
    targets: [
      {
        path: ['ServiceAttributes', 'a1'],
        command: 'DeleteServiceAttributesCommand',
        names: 'a1',
        notNames: 'a2',
      },
      {
        path: ['ServiceAttributes', 'a2'],
        command: 'DeleteServiceAttributesCommand',
        names: 'a2',
        notNames: 'a1',
      },
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'a DNS service with a Route 53 health check',
        bag: {
          Name: 's',
          NamespaceId: NAMESPACE_ID,
          Description: 'd',
          DnsConfig: {
            NamespaceId: NAMESPACE_ID,
            RoutingPolicy: 'MULTIVALUE',
            DnsRecords: [
              { Type: 'A', TTL: 60 },
              { Type: 'AAAA', TTL: 120 },
            ],
          },
          HealthCheckConfig: { Type: 'HTTP', ResourcePath: '/h', FailureThreshold: 2 },
          ServiceAttributes: { a1: 'v1', a2: 'v2' },
          Tags: TAGS,
        },
        variants: {
          'DnsConfig.RoutingPolicy': 'WEIGHTED',
          'DnsConfig.DnsRecords.0.Type': 'SRV',
          'DnsConfig.DnsRecords.1.Type': 'CNAME',
          'HealthCheckConfig.Type': 'HTTPS',
        },
        expectedSilent: SERVICE_SILENT,
        expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
      },
      {
        name: 'an HTTP service with a custom health check',
        bag: {
          Name: 's',
          NamespaceId: NAMESPACE_ID,
          Type: 'HTTP',
          HealthCheckCustomConfig: { FailureThreshold: 1 },
        },
      },
    ],
  },
];
