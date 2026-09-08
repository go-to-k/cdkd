/**
 * Offline evidence about a property the CFn schema has DROPPED while a provider
 * still declares it — enough for the refresh job to settle the decisive cases
 * itself instead of handing every one to a human
 * (issue [#2774](https://github.com/go-to-k/cdkd/issues/2774)).
 *
 * Two questions, both answerable from the checkout with no AWS call — which
 * matters because `.github/workflows/cfn-schema-refresh.yml` runs with
 * `permissions: {}` and no credentials, so anything needing `DescribeType` is
 * unavailable to it by construction:
 *
 * 1. **Can cdkd still DELIVER the property?** {@link typedSdkMember} asks
 *    whether the type's own service client declares a member of that name.
 * 2. **Does the provider still WIRE it?** {@link providerWiresProperty} asks
 *    whether the provider reads it off the template or writes it onto an SDK
 *    request, as opposed to merely listing it in `handledProperties`.
 *
 * Both must hold before the job may write a `bogusTolerated` entry on its own.
 * Neither is a text scan: `sdkModelsMember` in `diagnose-schema-refresh.mjs`
 * already provides the case-insensitive name-presence reading, and its own doc
 * comment calls that "the wrong tool for deciding anything, which is why the
 * caller renders it as evidence". These two are the tools for deciding, and
 * they are deliberately in a separate module from that one so the distinction
 * survives a reader skimming for "the SDK check".
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-v6';

import { collectSdkInterfaces, lowerFirst } from './gen-nested-key-coverage.ts';
import type { SdkMemberType } from './gen-nested-key-coverage.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Which spelling of the CFn property name the SDK declares. */
export type MemberSpelling = 'exact' | 'lowerFirst';

export interface TypedMemberEvidence {
  /** The client package whose typings were walked. */
  readonly client: string;
  /** The spelling found. */
  readonly spelling: MemberSpelling;
  /** Interfaces declaring it, for the report. Capped by the caller. */
  readonly interfaces: readonly string[];
}

/**
 * Whether the type's own service client declares a member of this name ON A
 * SHAPE CDKD CAN SEND — an interface whose name ends `Request`, `Input` or
 * `CommandInput`.
 *
 * **The request restriction is the difference between "the name exists in this
 * client" and "cdkd can deliver the value", and only the second is evidence
 * for keeping a declaration.** Without it every RESPONSE model counts:
 * `AWS::ApiGateway::Method`'s `MethodResponses` matches `Method` alone, which
 * appears on no `*Request` in `@aws-sdk/client-api-gateway`, and the rationale
 * written from that would assert "the value still reaches AWS" about a shape
 * cdkd can never send. Measured; it was live before this restriction.
 *
 * **Both PascalCase and lowerFirst count, and that is a measurement rather than
 * a hedge.** AWS SDK v3 wire models are camelCase for several services:
 * `@aws-sdk/client-api-gateway` declares `stageName` and carries no
 * `StageName` anywhere, while `@aws-sdk/client-route-53`,
 * `@aws-sdk/client-s3` and `@aws-sdk/client-lambda` declare the PascalCase
 * spelling (probed 2026-09-08 against the installed trees). An exact-case-only
 * rule would therefore report every camelCase-modelled service's live property
 * as undeliverable — safe in direction, since the property would escalate to a
 * human, but it would escalate nearly all of them and leave the automation
 * firing only on the services that happen to match CFn's capitalisation.
 *
 * What is NOT relaxed is the structural half: `Map.has` over the members
 * `collectSdkInterfaces` parsed out of the declarations, so a name appearing in
 * a comment, in an unrelated string, or in a DIFFERENT service's client does
 * not count. That is the whole difference from the name-presence scan.
 *
 * @param property CFn property name, e.g. `GeoProximityLocation`
 * @param clientPackage the type's own client, e.g. `@aws-sdk/client-route-53`
 * @returns evidence, or `undefined` when the client's typings are absent or
 *   declare no member of either spelling — the honest answer, not a guess
 */
export function typedSdkMember(
  property: string,
  clientPackage: string,
  repoRoot: string = REPO_ROOT
): TypedMemberEvidence | undefined {
  // A property name carrying anything but letters and digits is not a member
  // name in any SDK model, and searching for one would be answering a question
  // nobody asked — the same refusal `sdkModelsMember` makes.
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(property)) return undefined;
  const modelsDir = join(repoRoot, 'node_modules', clientPackage, 'dist-types/models');
  if (!existsSync(modelsDir)) return undefined;

  const interfaces = collectSdkInterfaces(modelsDir);
  const sendable = sendableInterfaces(interfaces);
  for (const spelling of ['exact', 'lowerFirst'] as const) {
    const needle = spelling === 'exact' ? property : lowerFirst(property);
    const hits: string[] = [];
    for (const [name, members] of interfaces) {
      if (!sendable.has(name)) continue;
      if (members.has(needle)) hits.push(name);
    }
    if (hits.length > 0) return { client: clientPackage, spelling, interfaces: hits.sort() };
  }
  return undefined;
}

/**
 * Every interface REACHABLE from an operation input, by walking member type
 * references out of the `*Request` / `*Input` / `*CommandInput` roots.
 *
 * Reachability, not a name suffix, and the difference is not cosmetic. A suffix
 * rule cuts off nested input shapes, which is where most properties live:
 * `GeoProximityLocation` is a member of `ResourceRecordSet`, reached from
 * `ChangeResourceRecordSetsRequest` through `ChangeBatch` and `Change`, and a
 * suffix rule escalated it — the very case this feature was built for.
 *
 * What it still excludes is the thing that has to be excluded: a RESPONSE-only
 * model. `AWS::ApiGateway::Method`'s `MethodResponses` matches the `Method`
 * shape, which no operation input reaches, and the rationale written from that
 * asserted "the value still reaches AWS" about something cdkd can never send.
 *
 * Array edges are followed as well as plain references — `collectSdkInterfaces`
 * carries the element type for `T[]` and `Array<T>` — because a list-valued
 * member is how most nested shapes hang off a request.
 */
/**
 * How AWS SDK v3 names an operation's INPUT shape.
 *
 * `Request` / `Input` / `CommandInput` are the json- and rest-protocol
 * spellings. `Type` and `Message` are the QUERY-protocol ones, and leaving them
 * out was not a small gap: `@aws-sdk/client-auto-scaling` names its inputs
 * `CreateAutoScalingGroupType` / `UpdateAutoScalingGroupType`, so the whole
 * service was unreachable and every one of its properties escalated for a
 * NAMING reason dressed up as "the SDK declares no member of this name".
 * Measured in the first rate reading, where the biggest escalation buckets were
 * exactly the query-protocol clients — rds, neptune, auto-scaling, docdb,
 * elasticache.
 *
 * A suffix list is a heuristic and will miss a sixth convention the same way.
 * The direction is safe — an unrecognised root over-escalates — but a bucket
 * dominated by one client is the tell, so read the escalation reasons BY CLIENT
 * before concluding the evidence is doing its job.
 */
const INPUT_ROOT_SUFFIXES = ['Request', 'Input', 'CommandInput', 'Type', 'Message'] as const;

function sendableInterfaces(
  interfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): Set<string> {
  const roots = [...interfaces.keys()].filter((n) => INPUT_ROOT_SUFFIXES.some((s) => n.endsWith(s)));
  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const members = interfaces.get(name);
    if (members === undefined) continue;
    for (const type of members.values()) {
      if (type.refName !== undefined && !reachable.has(type.refName)) queue.push(type.refName);
    }
  }
  return reachable;
}

export interface WiringEvidence {
  /** `providerRelPath:line` for each site, sorted. Capped by the caller. */
  readonly sites: readonly string[];
}

/**
 * Where the provider reads this property by NAME — an element access whose
 * argument is the string literal, `properties['X']` being the shape that matters.
 *
 * **The object is not checked, and that bounds what this excludes.** A read-back
 * indexing its own result — `result['GeoProximityLocation']` in
 * `route53-provider.ts` — is reported too, so the drift direction is only half
 * excluded here; what IS excluded is the `.X` property access, which is how a
 * read-back walks a typed SDK response and was the sole evidence for fifteen
 * `AWS::Glue::Job` properties. Scoping to the template bag would need the bag's
 * name, and providers spell it several ways.
 *
 * **This is positive evidence only. Its absence means "could not determine",
 * never "the provider does not send it", and every caller must treat it that
 * way.** Table-driven wiring is invisible here by construction: `AWS::SQS::Queue`
 * delivers `DelaySeconds` and `VisibilityTimeout` through a lookup map keyed by
 * shorthand and indexed by a loop variable (`sqs-queue-provider.ts`), so no
 * literal `properties['DelaySeconds']` exists anywhere. Measured before this
 * comment was written: both of the "wires nowhere" verdicts the tree could
 * produce were WRONG, and the runbook built on them told a maintainer to delete
 * a declaration for a property cdkd genuinely sends — the silent-drop class the
 * whole job exists to watch, reached through the job's own advice.
 *
 * A PROPERTY ACCESS (`recordSet.X`) is deliberately NOT counted, though an
 * earlier revision did. It cannot tell sending from reading back: a drift
 * comparator walking the SDK's response (`glue-provider.ts`'s
 * `readJobCurrentState`) accesses exactly the same names, and it was the sole
 * evidence for fifteen Glue Job properties. Evidence for "cdkd sends this" has
 * to come from the SENDING direction, and a template read is that direction.
 *
 * A declaration is a bare string literal inside an array, which is not this
 * shape — so the two questions cannot be confused, and no comment or unrelated
 * string can answer this one. A TEXT scan could not draw the line at all: the
 * declaration and the read spell the property identically.
 *
 * **Residual, stated rather than hidden: the walk is not scoped to the resource
 * TYPE.** 17 of 78 providers serve several types (`ec2-provider.ts` serves 15),
 * so a `properties['X']` read belonging to a sibling type credits this one. The
 * error direction is the mild one — a declaration is KEPT that could have been
 * retired, which is what a tolerance means and is reversible by deleting the
 * entry — but it is a direction that silences, so it belongs in the caller's
 * reckoning rather than in a comment nobody reads.
 */
export function providerWiresProperty(
  property: string,
  providerRelPath: string | undefined,
  repoRoot: string = REPO_ROOT
): WiringEvidence | undefined {
  if (!providerRelPath) return undefined;
  const abs = join(repoRoot, providerRelPath);
  if (!existsSync(abs)) return undefined;

  const source = ts.createSourceFile(
    abs,
    readFileSync(abs, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const sites = new Set<string>();
  const record = (node: ts.Node): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    sites.add(`${providerRelPath}:${line + 1}`);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === property
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (sites.size === 0) return undefined;
  return { sites: [...sites].sort() };
}
