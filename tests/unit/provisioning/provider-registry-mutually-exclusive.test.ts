/**
 * Registry wiring for the mutually-exclusive-property pre-flight (issue
 * #1634). The rule module's own behavior is covered in
 * `mutually-exclusive-properties.test.ts`; this file pins the three things
 * only the registry can answer:
 *
 * - `validateResourceProperties` — the method the deploy engine's pre-flight
 *   calls — actually reaches the check.
 * - The refusal happens BEFORE the silent-drop routing chatter.
 * - The argument is an `Iterable`, and both passes see the same items.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';

interface LoggerSpies {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

/** Registry with a spy logger swapped in (same cast every registry test uses). */
function makeRegistry(): { registry: ProviderRegistry; logger: LoggerSpies } {
  const registry = new ProviderRegistry();
  const logger: LoggerSpies = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  (registry as unknown as { logger: LoggerSpies }).logger = logger;
  return { registry, logger };
}

const badRoute = (logicalId: string) => ({
  logicalId,
  resourceType: 'AWS::EC2::Route',
  properties: {
    RouteTableId: 'rtb-1',
    DestinationCidrBlock: '10.0.0.0/8',
    DestinationIpv6CidrBlock: '::/0',
  },
});

describe('ProviderRegistry mutually-exclusive pre-flight', () => {
  it('throws from validateResourceProperties naming the resource and both keys', () => {
    const { registry } = makeRegistry();
    expect(() => registry.validateResourceProperties([badRoute('BadRoute')])).toThrow(
      /BadRoute.*DestinationCidrBlock and DestinationIpv6CidrBlock/s
    );
  });

  it('aggregates every offending resource into ONE error', () => {
    const { registry } = makeRegistry();
    let message = '';
    try {
      registry.validateResourceProperties([badRoute('RouteA'), badRoute('RouteB')]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('RouteA');
    expect(message).toContain('RouteB');
  });

  it('accepts a single-destination route and a route whose keys are behind Fn::If', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'Ok',
          resourceType: 'AWS::EC2::Route',
          properties: { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/8' },
        },
        {
          logicalId: 'Conditional',
          resourceType: 'AWS::EC2::Route',
          properties: {
            RouteTableId: 'rtb-1',
            DestinationCidrBlock: { 'Fn::If': ['C', '10.0.0.0/8', { Ref: 'AWS::NoValue' }] },
            DestinationIpv6CidrBlock: { 'Fn::If': ['C', { Ref: 'AWS::NoValue' }, '::/0'] },
          },
        },
      ])
    ).not.toThrow();
  });

  describe('ordering vs the silent-drop routing report', () => {
    // `AWS::EC2::Route` has an EMPTY silentDrop map, so a bad-Route-only
    // fixture logs nothing either way and would pass under the swapped-order
    // mutant (report first, then validate). The batch therefore carries a
    // resource that genuinely triggers a routing line, and the control below
    // proves that line really fires — without it, a codegen change that
    // emptied the fixture would silently make this vacuous again.
    function silentDropResource(): { logicalId: string; resourceType: string; properties: Record<string, unknown> } {
      for (const [resourceType, coverage] of PROPERTY_COVERAGE_BY_TYPE) {
        const first = coverage.silentDrop.entries().next();
        if (!first.done) {
          return { logicalId: 'DropCarrier', resourceType, properties: { [first.value[0]]: 'x' } };
        }
      }
      throw new Error(
        'PROPERTY_COVERAGE_BY_TYPE has no silent-drop entries — this ordering test needs one. ' +
          'Replace with a synthetic fixture.'
      );
    }

    it('CONTROL: the silent-drop resource does emit a routing line on its own', () => {
      const { registry, logger } = makeRegistry();
      registry.validateResourceProperties([silentDropResource()]);
      expect(logger.info.mock.calls.length + logger.warn.mock.calls.length).toBeGreaterThan(0);
    });

    it('refuses BEFORE emitting any silent-drop routing line', () => {
      const { registry, logger } = makeRegistry();
      expect(() =>
        registry.validateResourceProperties([silentDropResource(), badRoute('BadRoute')])
      ).toThrow(/mutually exclusive/);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  it('walks a generator argument correctly on both passes', () => {
    // `validateResourceProperties` iterates twice (the new check, then the
    // silent-drop report). A one-shot iterable must not go empty in between —
    // without the internal materialization the second pass sees nothing.
    const { registry } = makeRegistry();
    function* resources() {
      yield {
        logicalId: 'Ok',
        resourceType: 'AWS::EC2::Route',
        properties: { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/8' },
      };
    }
    const spy = vi.spyOn(registry, 'reportSilentDropDecisions');
    registry.validateResourceProperties(resources());
    expect(spy).toHaveBeenCalledTimes(1);
    expect([...(spy.mock.calls[0]![0] as Iterable<{ logicalId: string }>)]).toHaveLength(1);
  });
});
