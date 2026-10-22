/**
 * go-to-k/cdkd#5175: two stacks in different CDK Stages that share one
 * physical `stackName` (`new Stack(stage, 'Api', { stackName: 'Shared' })` in
 * a Beta and a Prod Stage). `cdkd local` must refuse a target that names the
 * shared name as ambiguous, naming both stacks by their CDK paths, and must
 * still resolve a target that names one clone by its CDK path. The
 * state-keyed commands keep one stack per name, but the one they keep is the
 * stack the pattern SELECTED.
 */
import { describe, expect, it } from 'vite-plus/test';
import { matchStacks, selectTargetStack } from '../../../src/cli/stack-matcher.js';
import { parseTarget, resolveLambdaTarget } from '../../../src/local/lambda-resolver.js';
import { parseEcsTarget, resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';
import {
  assertServedLogicalIdsUnambiguous,
  pickTargetStacks,
  resolveLambdaByLogicalId,
  targetStackHint,
} from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';

const SHARED = 'SharedApiStack';

function inlineFn(stage: string, marker: string): TemplateResource {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: `exports.handler = async () => ${JSON.stringify(marker)};` },
    },
    Metadata: { 'aws:cdk:path': `${stage}/Api/Fn/Resource` },
  };
}

function taskDef(stage: string, image: string): TemplateResource {
  return {
    Type: 'AWS::ECS::TaskDefinition',
    Properties: { ContainerDefinitions: [{ Name: 'app', Image: image }] },
    Metadata: { 'aws:cdk:path': `${stage}/Api/Task/Resource` },
  };
}

/** A Stage clone: `<stage>/Api`, physical name `SharedApiStack`. */
function clone(stage: string, marker: string): StackInfo {
  return {
    stackName: SHARED,
    displayName: `${stage}/Api`,
    stagePath: stage,
    artifactId: `${stage}Api`,
    template: {
      Resources: {
        FnABC123: inlineFn(stage, marker),
        TaskDEF456: taskDef(stage, `${marker}-image`),
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: {} },
      },
    },
    dependencyNames: [],
  } as unknown as StackInfo;
}

const beta = clone('Beta', 'beta');
const prod = clone('Prod', 'prod');
const stacks = [beta, prod];

describe('matchStacks with a shared physical name (#5175)', () => {
  it('returns the stack a display path selects, not the first stack of its name', () => {
    // Before the fix the name-dedup re-mapped `Prod/Api` to `Beta/Api`.
    expect(matchStacks(stacks, ['Prod/Api'])).toEqual([prod]);
    expect(matchStacks(stacks, ['Beta/Api'])).toEqual([beta]);
  });

  it('keeps one stack per name by default, and every selected stack by identity', () => {
    expect(matchStacks(stacks, [SHARED])).toEqual([beta]);
    expect(matchStacks(stacks, [SHARED], { dedupe: 'identity' })).toEqual([beta, prod]);
    expect(matchStacks(stacks, ['**'], { dedupe: 'identity' })).toEqual([beta, prod]);
  });

  it('still selects a stack once when two patterns both select it', () => {
    expect(matchStacks(stacks, ['Prod/Api', 'Prod/*'], { dedupe: 'identity' })).toEqual([prod]);
  });
});

describe('selectTargetStack (#5175)', () => {
  it('refuses the colon form naming the shared physical name', () => {
    const sel = selectTargetStack(parseTarget(`${SHARED}:FnABC123`), `${SHARED}:FnABC123`, stacks);
    expect(sel).toEqual({ kind: 'ambiguous', pattern: SHARED, matched: [beta, prod] });
  });

  it('refuses the path form whose head is the shared physical name', () => {
    const target = `${SHARED}/Fn`;
    const sel = selectTargetStack(parseTarget(target), target, stacks);
    expect(sel).toEqual({ kind: 'ambiguous', pattern: SHARED, matched: [beta, prod] });
    // Order-independent: the reversed app is refused the same way.
    expect(selectTargetStack(parseTarget(target), target, [prod, beta]).kind).toBe('ambiguous');
  });

  it('resolves a path-form target naming one clone by its CDK path', () => {
    const target = 'Prod/Api/Fn';
    expect(selectTargetStack(parseTarget(target), target, stacks)).toEqual({
      kind: 'found',
      stack: prod,
    });
  });
});

describe('cdkd local invoke resolver (#5175)', () => {
  it.each([`${SHARED}:FnABC123`, `${SHARED}/Fn`])(
    'refuses %s, naming both stacks by CDK path and the next step',
    (target) => {
      expect(() => resolveLambdaTarget(target, stacks)).toThrow(
        `Stack pattern ${SHARED} matched 2 stacks: ${SHARED} (Beta/Api), ${SHARED} (Prod/Api), ` +
          `which share that physical stack name. Name one stack by its CDK path, shown in ` +
          `parentheses (e.g. 'Beta/Api/<construct path>').`
      );
    }
  );

  it('lists the available stacks by CDK path, so two clones read as two stacks', () => {
    const list = `Available stacks: ${SHARED} (Beta/Api), ${SHARED} (Prod/Api).`;
    expect(() => resolveLambdaTarget('Nope:FnABC123', stacks)).toThrow(list);
    expect(() => resolveLambdaTarget('FnABC123', stacks)).toThrow(list);
    expect(() => resolveEcsTaskTarget('Nope:TaskDEF456', stacks)).toThrow(list);
  });

  it('runs the Prod clone for a Prod CDK-path target', () => {
    const resolved = resolveLambdaTarget('Prod/Api/Fn', stacks);
    expect(resolved.stack).toBe(prod);
  });
});

describe('cdkd local run-task resolver (#5175)', () => {
  it.each([`${SHARED}:TaskDEF456`, `${SHARED}/Task`])('refuses %s as ambiguous', (target) => {
    expect(parseEcsTarget(target).stackPattern).toBe(SHARED);
    expect(() => resolveEcsTaskTarget(target, stacks)).toThrow(
      /matched 2 stacks: SharedApiStack \(Beta\/Api\), SharedApiStack \(Prod\/Api\)/
    );
  });

  it('runs the Prod clone for a Prod CDK-path target', () => {
    expect(resolveEcsTaskTarget('Prod/Api/Task', stacks).stack).toBe(prod);
  });
});

describe('cdkd local start-api (#5175)', () => {
  it('serves both clones for --stack <shared name>, never only the first', () => {
    expect(pickTargetStacks(stacks, SHARED)).toEqual([beta, prod]);
  });

  it('turns a path target headed by the shared name into a pattern selecting both', () => {
    const hint = targetStackHint(`${SHARED}/HttpApi`, stacks);
    expect(hint).toBe(SHARED);
    expect(pickTargetStacks(stacks, undefined, undefined, hint)).toEqual([beta, prod]);
  });

  it('keeps the clone a CDK-path target names', () => {
    expect(targetStackHint('Prod/Api/HttpApi', stacks)).toBe(prod);
  });

  const route = {
    method: 'GET',
    pathPattern: '/',
    lambdaLogicalId: 'FnABC123',
    source: 'http-api',
    apiVersion: 'v2',
    stage: '$default',
    apiLogicalId: 'HttpApi',
    apiStackName: SHARED,
    declaredAt: 'HttpApi',
  } as unknown as DiscoveredRoute;
  const withAuth: RouteWithAuth[] = [{ route, authorizer: undefined } as RouteWithAuth];

  it('refuses to serve two stacks sharing a physical name, naming both and the next step', () => {
    expect(() => assertServedLogicalIdsUnambiguous(stacks, [route], withAuth)).toThrow(
      `The served stacks ${SHARED} (Beta/Api), ${SHARED} (Prod/Api) share the physical stack ` +
        `name ${SHARED}, and cdkd local start-api reads each stack's deployed state by that name, ` +
        `so it cannot serve them together. Serve one stack at a time: pass --stack with its CDK ` +
        `path (e.g. --stack 'Beta/Api'), or a target starting with that path.`
    );
  });

  it('refuses two stacks sharing a physical name even when no logical id collides', () => {
    const prodOnly = {
      ...prod,
      template: { Resources: { ProdOnlyFn: inlineFn('Prod', 'prod') } },
    } as unknown as StackInfo;
    expect(() => assertServedLogicalIdsUnambiguous([beta, prodOnly], [route], withAuth)).toThrow(
      /share the physical stack name SharedApiStack/
    );
  });

  // Distinct physical names (`--stack '**'` over a Stage deployed twice with
  // generated names): served side by side, each stack's Lambda and API keyed
  // by (stack, logical id) -- no longer refused (#5181).
  const renamed = (s: StackInfo, name: string): StackInfo =>
    ({ ...s, stackName: name }) as unknown as StackInfo;
  const betaN = renamed(beta, 'Beta-Api');
  const prodN = { ...renamed(prod, 'Prod-Api') } as StackInfo;
  const prodRoute = { ...route, apiStackName: 'Prod-Api' } as DiscoveredRoute;
  const betaRoute = { ...route, apiStackName: 'Beta-Api' } as DiscoveredRoute;
  const both = [betaRoute, prodRoute];
  const bothWithAuth = both.map((r) => ({ route: r, authorizer: undefined }) as RouteWithAuth);

  it('serves a union of uniquely named stacks reusing a Lambda and an API logical id', () => {
    expect(() => assertServedLogicalIdsUnambiguous([betaN, prodN], both, bothWithAuth)).not.toThrow();
  });

  it('still refuses a bare --assume-role logical id both of them declare, naming both', () => {
    const assumeRole = { perLambda: { FnABC123: 'arn:aws:iam::123456789012:role/R' } };
    expect(() =>
      assertServedLogicalIdsUnambiguous([betaN, prodN], both, bothWithAuth, [], { assumeRole })
    ).toThrow(
      /--assume-role names Lambda FnABC123 by its bare logical ID, which 2 of the served stacks declare \(Beta-Api \(Beta\/Api\), Prod-Api \(Prod\/Api\)\)/
    );
  });

  it('serves one clone without complaint', () => {
    expect(() => assertServedLogicalIdsUnambiguous([prod], [route], withAuth)).not.toThrow();
  });

  it('serves a union whose logical ids do not collide', () => {
    const other = {
      ...prod,
      stackName: 'Other',
      displayName: 'Other',
      template: { Resources: { OtherFn: inlineFn('Other', 'other') } },
    } as unknown as StackInfo;
    expect(() => assertServedLogicalIdsUnambiguous([beta, other], [route], withAuth)).not.toThrow();
  });

  it('resolveLambdaByLogicalId refuses a Lambda id two stacks declare', () => {
    expect(() => resolveLambdaByLogicalId('FnABC123', stacks)).toThrow(
      /Lambda FnABC123 is declared by 2 stacks \(SharedApiStack \(Beta\/Api\), SharedApiStack \(Prod\/Api\)\)/
    );
    expect(resolveLambdaByLogicalId('FnABC123', [prod]).stack).toBe(prod);
  });
});
