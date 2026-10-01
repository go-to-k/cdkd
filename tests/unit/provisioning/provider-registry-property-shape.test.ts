/**
 * Registry wiring for the property-shape pre-flight (issue #4357). The rule
 * module's own behavior is covered in `property-shape.test.ts`; this file pins
 * what only the registry can answer:
 *
 * - `validateResourceProperties` — the method the deploy engine's pre-flight
 *   calls with the template's raw, unresolved `Properties` — reaches the check.
 * - It runs FIRST: before the nested `required` walk (which reads arrays
 *   transparently and would report an unrelated missing member) and before
 *   any routing line is logged.
 * - The routing layer does not exempt a resource: CloudFormation validates
 *   the schema on every route.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';

interface LoggerSpies {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeRegistry(): { registry: ProviderRegistry; logger: LoggerSpies } {
  const registry = new ProviderRegistry();
  const logger: LoggerSpies = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  (registry as unknown as { logger: LoggerSpies }).logger = logger;
  return { registry, logger };
}

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

describe('ProviderRegistry.validateResourceProperties: property shapes', () => {
  it('throws ONE error listing every wrong-kind property across resources', () => {
    const { registry } = makeRegistry();
    const message = messageOf(() =>
      registry.validateResourceProperties([
        { logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', properties: { Tags: {} } },
        {
          logicalId: 'Fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: [{ Variables: {} }] },
        },
      ])
    );
    expect(message).toContain('Properties validation failed');
    expect(message).toContain(
      '  - Queue (AWS::SQS::Queue): #/Tags: expected type: JSONArray, found: JSONObject'
    );
    expect(message).toContain(
      '  - Fn (AWS::Lambda::Function): #/Environment: expected type: JSONObject, found: JSONArray'
    );
  });

  it('passes correct shapes, unresolved intrinsics and types outside the table', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.validateResourceProperties([
        { logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', properties: { Tags: [] } },
        {
          logicalId: 'Cond',
          resourceType: 'AWS::SQS::Queue',
          properties: { Tags: { 'Fn::If': ['C', [{ Key: 'k', Value: 'v' }], { Ref: 'AWS::NoValue' }] } },
        },
        { logicalId: 'Custom', resourceType: 'Custom::Thing', properties: { Tags: { a: 1 } } },
      ])
    ).not.toThrow();
  });

  it('refuses the shape BEFORE the nested required walk and before any routing line', () => {
    const { registry, logger } = makeRegistry();
    // As a LIST, the nested `required` walk reads it transparently and would
    // report `DeploymentCircuitBreaker` missing `Rollback` instead.
    const message = messageOf(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'Service',
          resourceType: 'AWS::ECS::Service',
          properties: {
            DeploymentConfiguration: [{ DeploymentCircuitBreaker: { Enable: true } }],
            CdkdUnknownKey: 'routes via Cloud Control',
          },
        },
      ])
    );
    expect(message).toContain(
      '  - Service (AWS::ECS::Service): #/DeploymentConfiguration: expected type: JSONObject, found: JSONArray'
    );
    expect(message).not.toContain('Rollback');
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('the control: the same block as an OBJECT reaches the nested required check', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'Service',
          resourceType: 'AWS::ECS::Service',
          properties: { DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true } } },
        },
      ])
    ).toThrow(/missing required member Rollback/);
  });

  it('refuses a resource whose state routes it through Cloud Control too', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'Queue',
          resourceType: 'AWS::SQS::Queue',
          properties: { Tags: { Key: 'k', Value: 'v' } },
          provisionedBy: 'cc-api',
          previousProperties: { Tags: [] },
        },
      ])
    ).toThrow('#/Tags: expected type: JSONArray, found: JSONObject');
  });
});
