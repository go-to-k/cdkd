import { describe, expect, it } from 'vite-plus/test';
import { buildCloudMapIndex } from '../../../src/local/cloud-map-resolver.js';
import { EcsTaskResolutionError } from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

function buildStack(name: string, resources: Record<string, TemplateResource>): StackInfo {
  const template: CloudFormationTemplate = { Resources: resources };
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template,
    dependencyNames: [],
  };
}

describe('buildCloudMapIndex', () => {
  it('returns empty index when no Cloud Map resources are present', () => {
    const stack = buildStack('Stack', {});
    const index = buildCloudMapIndex(stack);
    expect(index.namespacesByLogicalId.size).toBe(0);
    expect(index.namespacesByName.size).toBe(0);
    expect(index.servicesByLogicalId.size).toBe(0);
    expect(index.warnings).toEqual([]);
  });

  it('parses a single PrivateDnsNamespace', () => {
    const stack = buildStack('Stack', {
      Ns: {
        Type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
        Properties: { Name: 'cdkd-local.local', Vpc: { Ref: 'Vpc' } },
      },
    });
    const index = buildCloudMapIndex(stack);
    expect(index.namespacesByLogicalId.get('Ns')).toEqual({
      logicalId: 'Ns',
      name: 'cdkd-local.local',
    });
    expect(index.namespacesByName.get('cdkd-local.local')?.logicalId).toBe('Ns');
  });

  it('parses an AWS::ServiceDiscovery::Service whose NamespaceId is Fn::GetAtt', () => {
    const stack = buildStack('Stack', {
      Ns: {
        Type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
        Properties: { Name: 'cdkd-local.local' },
      },
      OrdersSvc: {
        Type: 'AWS::ServiceDiscovery::Service',
        Properties: {
          Name: 'orders',
          NamespaceId: { 'Fn::GetAtt': ['Ns', 'Id'] },
          DnsConfig: {
            DnsRecords: [
              { TTL: 60, Type: 'A' },
              { TTL: 60, Type: 'SRV' },
            ],
            NamespaceId: { 'Fn::GetAtt': ['Ns', 'Id'] },
          },
        },
      },
    });
    const index = buildCloudMapIndex(stack);
    const svc = index.servicesByLogicalId.get('OrdersSvc');
    expect(svc?.namespaceLogicalId).toBe('Ns');
    expect(svc?.namespaceName).toBe('cdkd-local.local');
    expect(svc?.name).toBe('orders');
    expect(svc?.dnsRecords).toEqual([
      { type: 'A', ttlSeconds: 60 },
      { type: 'SRV', ttlSeconds: 60 },
    ]);
  });

  it('accepts NamespaceId as Ref shape (defensive fallback)', () => {
    const stack = buildStack('Stack', {
      Ns: {
        Type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
        Properties: { Name: 'cdkd-local.local' },
      },
      Svc: {
        Type: 'AWS::ServiceDiscovery::Service',
        Properties: {
          Name: 'svc',
          NamespaceId: { Ref: 'Ns' },
          DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
        },
      },
    });
    const index = buildCloudMapIndex(stack);
    expect(index.servicesByLogicalId.get('Svc')?.namespaceName).toBe('cdkd-local.local');
  });

  it('rejects PublicDnsNamespace with an actionable error', () => {
    const stack = buildStack('Stack', {
      Ns: { Type: 'AWS::ServiceDiscovery::PublicDnsNamespace', Properties: { Name: 'public.com' } },
    });
    expect(() => buildCloudMapIndex(stack)).toThrow(EcsTaskResolutionError);
    expect(() => buildCloudMapIndex(stack)).toThrow(/PublicDnsNamespace.*not supported/);
  });

  it('rejects HttpNamespace with an actionable error', () => {
    const stack = buildStack('Stack', {
      Ns: { Type: 'AWS::ServiceDiscovery::HttpNamespace', Properties: { Name: 'cdkd' } },
    });
    expect(() => buildCloudMapIndex(stack)).toThrow(/HttpNamespace.*not supported/);
  });

  it('rejects a PrivateDnsNamespace with no literal Name', () => {
    const stack = buildStack('Stack', {
      Ns: {
        Type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
        Properties: { Name: { 'Fn::Sub': 'foo.${AWS::Region}' } },
      },
    });
    expect(() => buildCloudMapIndex(stack)).toThrow(/no literal Name/);
  });

  it('rejects a Service whose NamespaceId references a missing namespace', () => {
    const stack = buildStack('Stack', {
      Svc: {
        Type: 'AWS::ServiceDiscovery::Service',
        Properties: {
          Name: 'svc',
          NamespaceId: { 'Fn::GetAtt': ['GoneNs', 'Id'] },
          DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
        },
      },
    });
    expect(() => buildCloudMapIndex(stack)).toThrow(/no PrivateDnsNamespace with that logical id/);
  });

  it('rejects a Service whose NamespaceId is an unsupported intrinsic', () => {
    const stack = buildStack('Stack', {
      Ns: {
        Type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
        Properties: { Name: 'cdkd-local.local' },
      },
      Svc: {
        Type: 'AWS::ServiceDiscovery::Service',
        Properties: {
          Name: 'svc',
          NamespaceId: { 'Fn::Sub': '${Ns.Id}' },
          DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
        },
      },
    });
    expect(() => buildCloudMapIndex(stack)).toThrow(/unsupported NamespaceId reference shape/);
  });

  it('warns when two namespaces share the same Name in one stack', () => {
    const stack = buildStack('Stack', {
      NsA: {
        Type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
        Properties: { Name: 'cdkd-local.local' },
      },
      NsB: {
        Type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
        Properties: { Name: 'cdkd-local.local' },
      },
    });
    const index = buildCloudMapIndex(stack);
    expect(index.warnings.length).toBe(1);
    expect(index.warnings[0]).toContain('NsA');
    expect(index.warnings[0]).toContain('NsB');
  });

  it('skips AAAA / CNAME record types and tolerates string-typed TTLs', () => {
    const stack = buildStack('Stack', {
      Ns: {
        Type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
        Properties: { Name: 'cdkd-local.local' },
      },
      Svc: {
        Type: 'AWS::ServiceDiscovery::Service',
        Properties: {
          Name: 'svc',
          NamespaceId: { 'Fn::GetAtt': ['Ns', 'Id'] },
          DnsConfig: {
            DnsRecords: [
              { Type: 'A', TTL: '30' }, // string TTL
              { Type: 'AAAA', TTL: 60 }, // skipped
            ],
          },
        },
      },
    });
    const records = buildCloudMapIndex(stack).servicesByLogicalId.get('Svc')?.dnsRecords;
    expect(records?.length).toBe(1);
    expect(records?.[0]).toEqual({ type: 'A', ttlSeconds: 30 });
  });
});
