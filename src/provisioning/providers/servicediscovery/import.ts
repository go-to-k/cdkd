import {
  GetNamespaceCommand,
  GetServiceCommand,
  ListNamespacesCommand,
  NamespaceNotFound,
  ServiceNotFound,
} from '@aws-sdk/client-servicediscovery';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import { definedAttributes } from '../../attribute-map.js';
import { ServiceDiscoveryProvider } from '../servicediscovery-provider.js';

export async function importImpl(
  this: ServiceDiscoveryProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
    case 'AWS::ServiceDiscovery::HttpNamespace':
    case 'AWS::ServiceDiscovery::PublicDnsNamespace':
      return this.importNamespaceResource(input);
    case 'AWS::ServiceDiscovery::Service':
      return this.importServiceResource(input);
    default:
      return null;
  }
}

export async function importNamespaceResource(
  this: ServiceDiscoveryProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const expectedKind = ServiceDiscoveryProvider.NAMESPACE_KIND_BY_TYPE[input.resourceType];

  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new GetNamespaceCommand({ Id: input.knownPhysicalId })
      );
      if (expectedKind && resp.Namespace?.Type && resp.Namespace.Type !== expectedKind) {
        this.logger.debug(
          `Namespace ${input.knownPhysicalId} is kind ${resp.Namespace.Type}, expected ${expectedKind} for ${input.resourceType} — refusing to adopt`
        );
        return null;
      }
      return { physicalId: input.knownPhysicalId, attributes: {} };
    } catch (err) {
      if (err instanceof NamespaceNotFound) return null;
      throw err;
    }
  }

  // The `aws:cdk:path` tag leg of this walk is gone: AWS rejects
  // `aws:`-prefixed tag writes, so that tag never exists on a real resource
  // and the comparison could not match (issue #1134). The name leg below is
  // reachable and is kept — without a desired `Name` there is nothing left
  // to match on, so skip the listing entirely.
  const desiredName =
    typeof input.properties?.['Name'] === 'string' ? input.properties['Name'] : undefined;
  if (!desiredName) return null;

  let token: string | undefined;
  do {
    const list = await this.getClient().send(
      new ListNamespacesCommand({ ...(token && { NextToken: token }) })
    );
    for (const ns of list.Namespaces ?? []) {
      if (!ns.Id || !ns.Arn) continue;
      if (expectedKind && ns.Type && ns.Type !== expectedKind) continue;
      if (ns.Name === desiredName) {
        return { physicalId: ns.Id, attributes: {} };
      }
    }
    token = list.NextToken;
  } while (token);
  return null;
}

export async function importServiceResource(
  this: ServiceDiscoveryProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new GetServiceCommand({ Id: input.knownPhysicalId })
      );
      // Issue #3627: the same map `create()` records; the resolver's
      // Service arm builds only `Arn` / `Id`, so `Name` resolved to the id.
      return {
        physicalId: input.knownPhysicalId,
        attributes: definedAttributes({
          Id: input.knownPhysicalId,
          Arn: resp.Service?.Arn,
          Name: resp.Service?.Name,
        }),
      };
    } catch (err) {
      if (err instanceof ServiceNotFound) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // service reaching here needs an explicit `--resource` override.
  return null;
}
