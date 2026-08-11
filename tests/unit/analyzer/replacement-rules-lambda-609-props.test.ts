import { describe, it, expect } from 'vite-plus/test';
import {
  ReplacementRulesRegistry,
  durableConfigPresenceToggled,
} from '../../../src/analyzer/replacement-rules.js';

/**
 * Replacement classification for the `AWS::Lambda::Function` properties wired
 * by the issue #609 backfill. Every rule below encodes an AWS behavior
 * established by live probe (us-east-1, 2026-08-11), not a docs reading:
 *
 *  - `TenancyConfig` is create-only in the CFn registry schema AND in the SDK
 *    (member on CreateFunctionRequest, absent from
 *    UpdateFunctionConfigurationRequest) — always a replacement.
 *  - `DurableConfig` is CONDITIONAL: an in-place edit is accepted, but adding
 *    the block to a function that lacked one is rejected outright by AWS, and
 *    removing it is inexpressible (omission keeps the live value). Both
 *    toggles must therefore drive a replacement.
 *  - `CodeSigningConfigArn` / `RuntimeManagementConfig` are mutable in place
 *    via their own control-plane APIs.
 *
 * `isClassified` is load-bearing throughout: it proves the registry holds an
 * explicit opinion, so `DiffCalculator.compareProperties` never falls through
 * to the DescribeType `createOnlyProperties` lookup for these properties.
 */
const LAMBDA = 'AWS::Lambda::Function';

describe('ReplacementRulesRegistry — Lambda Function #609 properties', () => {
  const registry = new ReplacementRulesRegistry();

  describe('TenancyConfig (create-only)', () => {
    it('is classified explicitly', () => {
      expect(registry.isClassified(LAMBDA, 'TenancyConfig')).toBe(true);
    });

    it('requires replacement when the isolation mode changes', () => {
      expect(
        registry.requiresReplacement(
          LAMBDA,
          'TenancyConfig',
          { TenantIsolationMode: 'PER_TENANT' },
          { TenantIsolationMode: 'NONE' }
        )
      ).toBe(true);
    });

    it('requires replacement when the block is added to an existing function', () => {
      expect(
        registry.requiresReplacement(LAMBDA, 'TenancyConfig', undefined, {
          TenantIsolationMode: 'PER_TENANT',
        })
      ).toBe(true);
    });
  });

  describe('DurableConfig (conditional on presence)', () => {
    it('is classified explicitly', () => {
      expect(registry.isClassified(LAMBDA, 'DurableConfig')).toBe(true);
    });

    it('does NOT require replacement for an in-place edit of an existing block', () => {
      // Live-probed: UpdateFunctionConfiguration accepted 3600 -> 7200 on a
      // function created WITH a durable config, readback confirmed.
      expect(
        registry.requiresReplacement(
          LAMBDA,
          'DurableConfig',
          { ExecutionTimeout: 3600, RetentionPeriodInDays: 14 },
          { ExecutionTimeout: 7200, RetentionPeriodInDays: 21 }
        )
      ).toBe(false);
    });

    it('REQUIRES replacement when the block is added (AWS rejects the in-place add)', () => {
      // "You cannot add a durable configuration to a function that was
      // originally created with no durable configuration."
      expect(
        registry.requiresReplacement(LAMBDA, 'DurableConfig', undefined, {
          ExecutionTimeout: 3600,
        })
      ).toBe(true);
    });

    it('REQUIRES replacement when the block is removed (omission keeps the live value)', () => {
      // Probed: a follow-up update omitting DurableConfig left
      // {RetentionPeriodInDays: 21, ExecutionTimeout: 7200} still live, so an
      // in-place classification would silently keep a config the template no
      // longer declares.
      expect(
        registry.requiresReplacement(
          LAMBDA,
          'DurableConfig',
          { ExecutionTimeout: 7200 },
          undefined
        )
      ).toBe(true);
    });

    it('treats null like absent on both sides', () => {
      expect(durableConfigPresenceToggled(null, { ExecutionTimeout: 3600 })).toBe(true);
      expect(durableConfigPresenceToggled({ ExecutionTimeout: 3600 }, null)).toBe(true);
      expect(durableConfigPresenceToggled(null, undefined)).toBe(false);
    });

    it('does not fire when both sides are absent', () => {
      expect(durableConfigPresenceToggled(undefined, undefined)).toBe(false);
    });

    it('compares an unresolved intrinsic on presence alone (conservative)', () => {
      // A non-object on one side can only over-report a replacement, never
      // silently skip a required one.
      expect(durableConfigPresenceToggled({ Ref: 'Param' }, { ExecutionTimeout: 3600 })).toBe(
        false
      );
      expect(durableConfigPresenceToggled(undefined, { Ref: 'Param' })).toBe(true);
    });
  });

  describe('in-place control-plane properties', () => {
    it('classifies CodeSigningConfigArn as updateable', () => {
      expect(registry.isClassified(LAMBDA, 'CodeSigningConfigArn')).toBe(true);
      expect(
        registry.requiresReplacement(LAMBDA, 'CodeSigningConfigArn', 'arn:csc:a', 'arn:csc:b')
      ).toBe(false);
    });

    it('classifies RuntimeManagementConfig as updateable', () => {
      expect(registry.isClassified(LAMBDA, 'RuntimeManagementConfig')).toBe(true);
      expect(
        registry.requiresReplacement(
          LAMBDA,
          'RuntimeManagementConfig',
          { UpdateRuntimeOn: 'Auto' },
          { UpdateRuntimeOn: 'FunctionUpdate' }
        )
      ).toBe(false);
    });
  });
});
