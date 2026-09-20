/**
 * `resourcesNamingDeclaredParameter` — the fail-closed reading of a reason-less
 * `observedBaselineRefused` marker (issue
 * [#3468](https://github.com/go-to-k/cdkd/issues/3468)). The dependence walk it
 * is built on is fenced, shape by shape, in
 * `tests/unit/cli/import-deployed-parameters.test.ts`; the engine-level
 * behaviour in `tests/unit/deployment/deploy-engine-parameter-refusal.test.ts`.
 * This file holds the verdict's own contract, above all the arms that answer
 * "yes" because nothing could be read.
 */
import { describe, it, expect } from 'vite-plus/test';
import { resourcesNamingDeclaredParameter } from '../../../src/analyzer/parameter-dependence.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const asTemplate = (value: unknown): CloudFormationTemplate => value as CloudFormationTemplate;

const PARAMETERS = { DbPassword: { Type: 'String', Default: 'CHANGEME' } };

describe('resourcesNamingDeclaredParameter', () => {
  it('answers per resource on a readable template: dependents and their attribute readers, nothing else', () => {
    const names = resourcesNamingDeclaredParameter(
      asTemplate({
        Parameters: PARAMETERS,
        Resources: {
          Direct: { Type: 'T', Properties: { V: { Ref: 'DbPassword' } } },
          Reader: { Type: 'T', Properties: { V: { 'Fn::GetAtt': ['Direct', 'Value'] } } },
          SubReader: { Type: 'T', Properties: { V: { 'Fn::Sub': '${Reader.Arn}' } } },
          Pointer: { Type: 'T', Properties: { V: { Ref: 'Direct' } } },
          Pseudo: { Type: 'T', Properties: { V: { Ref: 'AWS::Region' } } },
          Plain: { Type: 'T', Properties: { V: 'CHANGEME' } },
        },
      })
    );
    expect(names('Direct')).toBe(true);
    expect(names('Reader')).toBe(true);
    expect(names('SubReader')).toBe(true);
    // A plain Ref of a resource yields its physical id and is not followed.
    expect(names('Pointer')).toBe(false);
    expect(names('Pseudo')).toBe(false);
    expect(names('Plain')).toBe(false);
    // Not defined by the template: the resource is being removed.
    expect(names('Gone')).toBe(false);
    expect(names.failedClosed).toBeUndefined();
  });

  // DELIBERATE, same rule as ARM 4: an older import's ARM 4 never ran on a
  // template in which nothing names a declared parameter, so it cannot have
  // written a marker there, and every CDK stack declares `BootstrapVersion`.
  it('answers NO for everything when no parameter is declared, or none is named, unclassifiable bags included', () => {
    const resources = {
      Odd: { Type: 'T', Properties: { V: { 'Fn::ToJsonString': { a: 1 } } } },
      Plain: { Type: 'T', Properties: { V: 1 } },
    };
    for (const template of [
      { Resources: resources },
      { Parameters: {}, Resources: resources },
      {
        Parameters: { BootstrapVersion: { Type: 'AWS::SSM::Parameter::Value<String>' } },
        Rules: { Check: { Assertions: [{ Assert: { Ref: 'BootstrapVersion' } }] } },
        Resources: resources,
      },
    ]) {
      const names = resourcesNamingDeclaredParameter(asTemplate(template));
      expect(names('Odd')).toBe(false);
      expect(names('Plain')).toBe(false);
    }
  });

  it('an unclassifiable bag is a YES once any declared parameter is named anywhere', () => {
    const names = resourcesNamingDeclaredParameter(
      asTemplate({
        Parameters: PARAMETERS,
        Resources: {
          Odd: { Type: 'T', Properties: { V: { 'Fn::ToJsonString': { a: 1 } } } },
          Other: { Type: 'T', Properties: { V: { Ref: 'DbPassword' } } },
          Plain: { Type: 'T', Properties: { V: 1 } },
        },
      })
    );
    expect(names('Odd')).toBe(true);
    expect(names('Plain')).toBe(false);
  });

  it('a definition deeper than the call stack is a YES for that resource', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 200_000; i++) deep = { n: deep };
    const names = resourcesNamingDeclaredParameter(
      asTemplate({
        Parameters: PARAMETERS,
        Resources: {
          Deep: { Type: 'T', Properties: deep },
          Other: { Type: 'T', Properties: { V: { Ref: 'DbPassword' } } },
        },
      })
    );
    expect(names('Deep')).toBe(true);
  });

  it.each([
    ['no template', undefined],
    ['a null template', null],
    ['a template that is not an object', 'template'],
    ['no Resources section', { Parameters: PARAMETERS }],
    ['a Resources section that is not a map', { Parameters: PARAMETERS, Resources: [] }],
    ['a Parameters section that is not a map', { Parameters: 'x', Resources: {} }],
    ['a null Parameters section', { Parameters: null, Resources: {} }],
  ])('FAILS CLOSED — every logical id is a YES — on %s', (_label, template) => {
    const names = resourcesNamingDeclaredParameter(asTemplate(template));
    expect(names('Anything')).toBe(true);
    expect(names('Gone')).toBe(true);
    expect(names.failedClosed).toBe('unreadable-template');
  });

  it('FAILS CLOSED when reading the template throws', () => {
    const template = {
      Parameters: PARAMETERS,
      get Resources(): never {
        throw new Error('unreadable');
      },
    };
    const names = resourcesNamingDeclaredParameter(asTemplate(template));
    expect(names('Anything')).toBe(true);
    // The cause CLASS, never the error's text.
    expect(names.failedClosed).toBe('walk-threw');
  });
});
