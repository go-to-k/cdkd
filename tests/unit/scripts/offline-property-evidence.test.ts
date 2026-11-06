/**
 * `scripts/offline-property-evidence.ts` — the two structural facts the schema
 * refresh job is allowed to settle a removed-but-declared property from, both
 * read out of the checkout with no AWS call.
 *
 * The suite is shaped by the four ways these helpers can be WORSE than the
 * name-presence scan they sit beside (`sdkModelsMember`, whose own doc comment
 * calls itself "the wrong tool for deciding anything"):
 *
 * 1. **An exact-case-only member test.** AWS SDK v3 models several services in
 *    camelCase — `@aws-sdk/client-api-gateway` declares `stageName` and no
 *    `StageName` — so a PascalCase-only rule reports every such service's LIVE
 *    property as undeliverable. Safe in direction (it escalates to a human) and
 *    useless in practice. Both spellings are pinned here against REAL typings,
 *    one service per spelling, because the point is that the answer differs by
 *    service and cannot be assumed.
 * 2. **Counting a member cdkd can never SEND.** `typedSdkMember` was live for a
 *    while over EVERY interface the client declares, response models included,
 *    and the rationale it produced asserted "the value still reaches AWS" about
 *    a shape no operation input reaches — measured on
 *    `AWS::ApiGateway::Method.MethodResponses`, which matches the `Method`
 *    response model alone. So the membership test is now a REACHABILITY test
 *    from `*Request` / `*Input` / `*CommandInput`, and both directions are
 *    pinned below: the response-only shape is refused, and the NESTED input
 *    shape (`ResourceRecordSet`, which no suffix rule would accept) is kept.
 * 3. **Counting a READ-BACK as evidence that cdkd sends the value.** A `.X`
 *    property access used to count as wiring, and a drift comparator walking
 *    the SDK's response accesses exactly the same names — measured, it was the
 *    ONLY evidence for fifteen `AWS::Glue::Job` properties. Only a template
 *    read (`properties['X']`) counts now, and the inverted case below pins the
 *    refusal against those fifteen real names.
 * 4. **Guessing when the input is absent.** Missing typings, a missing provider
 *    file, and a name that is not a member name at all each have to answer
 *    `undefined` rather than a confident anything — each paired with a control
 *    proving the same call shape answers when the input IS there, so the
 *    `undefined` cannot be coming from a broken harness. `undefined` from
 *    `providerWiresProperty` in particular means COULD NOT DETERMINE and never
 *    "the provider does not send it": `AWS::SQS::Queue.DelaySeconds` is
 *    delivered through a lookup table and reports `undefined` here, and that
 *    case is in the suite so nobody re-reads the absence as a finding.
 */
import { describe, it, expect } from 'vite-plus/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  providerWiresProperty,
  typedSdkMember,
} from '../../../scripts/offline-property-evidence.ts';
import { collectSdkInterfaces } from '../../../scripts/gen-nested-key-coverage.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ROUTE53 = 'src/provisioning/providers/route53-provider.ts';
const APIGW = 'src/provisioning/providers/apigateway-provider.ts';
const IAM_ACCESS_KEY = 'src/provisioning/providers/iam-access-key-provider.ts';
const NESTED_STACK = 'src/provisioning/providers/nested-stack-provider.ts';
const GLUE = 'src/provisioning/providers/glue-provider.ts';
const SQS = 'src/provisioning/providers/sqs-queue-provider.ts';

/**
 * The source line a `relPath:line` site points at.
 *
 * Cases assert the SHAPE at the cited line rather than the line NUMBER: the
 * number moves whenever the provider is edited, while "the site this reported
 * really is an element access on that name" is the claim the helper makes.
 */
const lineAt = (site: string): string => {
  const at = site.lastIndexOf(':');
  const rel = site.slice(0, at);
  const line = Number(site.slice(at + 1));
  expect(Number.isInteger(line) && line > 0, `site is not a path:line — ${site}`).toBe(true);
  return readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n')[line - 1] ?? '';
};

/**
 * A scratch repo root carrying one fabricated SDK client.
 *
 * The name guard is only observable against typings that DO declare the refused
 * name: against the real clients a punctuated name misses whether the guard runs
 * or not, so a case built on them passes with the guard deleted. `dist-types`
 * member names are collected from string literals as well as identifiers, so a
 * fabricated interface can declare `'Geo.Proximity'` and make the refusal the
 * only thing standing between the caller and a hit.
 *
 * The fabricated interface must be one an operation input REACHES, so the caller
 * names it `*Request`: since the walk was narrowed to sendable shapes a lone
 * `interface Weird` is unreachable from any root and answers `undefined` for
 * every name, which would make the control below pass for the wrong reason and
 * the refusals prove nothing.
 */
const withFakeClient = (client: string, declaration: string, run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-typings-'));
  try {
    const models = join(root, 'node_modules', client, 'dist-types/models');
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, 'models_0.d.ts'), declaration);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** Run a case against a scratch repo root holding one synthetic provider file. */
const withProvider = (source: string, run: (rel: string, root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-wiring-'));
  try {
    mkdirSync(join(root, 'src/provisioning/providers'), { recursive: true });
    const rel = 'src/provisioning/providers/probe-provider.ts';
    writeFileSync(join(root, rel), source);
    run(rel, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('typedSdkMember', () => {
  it('finds the EXACT spelling where the service models PascalCase', () => {
    // The case that motivated the feature: AWS dropped `GeoProximityLocation`
    // from the CFn schema while `@aws-sdk/client-route-53` still declares it on
    // the shape cdkd sends, so cdkd keeps delivering the value.
    const found = typedSdkMember('GeoProximityLocation', '@aws-sdk/client-route-53', REPO_ROOT);
    expect(found, 'route-53 no longer declares the anchor member').toBeDefined();
    expect(found!.client).toBe('@aws-sdk/client-route-53');
    expect(found!.spelling).toBe('exact');
    expect(found!.interfaces).toContain('ResourceRecordSet');
  });

  it('accepts a NESTED input shape, which a name-suffix rule would refuse', () => {
    // The sendable set is a REACHABILITY closure, and this is why it cannot be
    // a name-suffix rule instead. `ResourceRecordSet` is not a `*Request` /
    // `*Input` / `*CommandInput` — it hangs off `ChangeResourceRecordSetsRequest`
    // through `ChangeBatch` and `Change`, an array edge included — and the
    // suffix rule that was tried first escalated the very property this feature
    // was built for. Asserting the shape's NAME here is what makes that
    // concrete: read the assertion and you can see the suffix rule miss it.
    const found = typedSdkMember('GeoProximityLocation', '@aws-sdk/client-route-53', REPO_ROOT);
    expect(found!.interfaces).toContain('ResourceRecordSet');
    for (const name of found!.interfaces) {
      expect(
        /(?:Request|Input|CommandInput)$/.test(name),
        `${name} is itself a root, so this case no longer exercises the nested reach`
      ).toBe(false);
    }
  });

  it('refuses a RESPONSE-only shape no operation input reaches', () => {
    // The measured defect the narrowing closed, not a hypothetical. Before it,
    // `AWS::ApiGateway::Method.MethodResponses` matched and the job wrote a
    // rationale asserting "the value still reaches AWS" about a member of
    // `Method` — a shape `@aws-sdk/client-api-gateway` only ever RETURNS. cdkd
    // can never send it, so the property's removal is a real decision.
    const interfaces = collectSdkInterfaces(
      join(REPO_ROOT, 'node_modules/@aws-sdk/client-api-gateway/dist-types/models')
    );
    // The case is only about reachability while the NAME is genuinely there:
    // if api-gateway ever stops declaring it, the refusal below would be an
    // ordinary miss and would pass with `sendableInterfaces` deleted.
    expect(
      interfaces.get('Method')?.has('methodResponses'),
      'the `Method` response model no longer declares the member, so this case is vacuous'
    ).toBe(true);
    expect(typedSdkMember('MethodResponses', '@aws-sdk/client-api-gateway', REPO_ROOT)).toBe(
      undefined
    );
    // Control on the SAME client: a name that IS reachable from an operation
    // input answers, so the refusal is the reachability test rather than the
    // client failing to load.
    expect(typedSdkMember('StageName', '@aws-sdk/client-api-gateway', REPO_ROOT)).toBeDefined();
  });

  it('finds the lowerFirst spelling where the service models camelCase', () => {
    // The measurement the second arm exists for, and it is a measurement
    // rather than a hedge: `spelling === 'lowerFirst'` is only reachable when
    // the exact pass found NOTHING, so this assertion IS the statement that
    // `@aws-sdk/client-api-gateway` carries no `StageName` anywhere. Under an
    // exact-case-only rule this live, wired property reports as undeliverable.
    const found = typedSdkMember('StageName', '@aws-sdk/client-api-gateway', REPO_ROOT);
    expect(found, 'api-gateway no longer declares the anchor member').toBeDefined();
    expect(found!.spelling).toBe('lowerFirst');
    expect(found!.interfaces).toContain('CreateStageRequest');
    // The ordering claim is asserted HERE and not on the route-53 case: that
    // one hits a single interface, where `toEqual(sort())` is a tautology and
    // survives a deliberately reversed list. The rationale slices the first
    // three names, so their order is what a reader sees.
    expect(found!.interfaces.length, 'a one-element list cannot show ordering').toBeGreaterThan(1);
    expect([...found!.interfaces]).toEqual([...found!.interfaces].sort());

    // The discriminating half: the SAME property name against the SAME helper
    // reports `exact` on a PascalCase-modelled service, so neither spelling can
    // be hard-coded as "the" answer.
    expect(typedSdkMember('Name', '@aws-sdk/client-route-53', REPO_ROOT)?.spelling).toBe('exact');
  });

  it('answers undefined for a name no interface declares in EITHER spelling', () => {
    expect(typedSdkMember('CdkdNotAMemberName', '@aws-sdk/client-route-53', REPO_ROOT)).toBe(
      undefined
    );
    // Control: the same client, walked the same way, does answer — so the
    // `undefined` above is "no member", not "no typings" or a broken walk.
    expect(typedSdkMember('HostedZoneId', '@aws-sdk/client-route-53', REPO_ROOT)).toBeDefined();
  });

  it('answers undefined when the client is not installed, rather than guessing', () => {
    const absent = '@aws-sdk/client-cdkd-no-such-service';
    expect(
      existsSync(join(REPO_ROOT, 'node_modules', absent)),
      'the "absent" client is installed, so this case proves nothing'
    ).toBe(false);
    expect(typedSdkMember('GeoProximityLocation', absent, REPO_ROOT)).toBe(undefined);
  });

  it('refuses a property name that is not a member name at all', () => {
    // Not a lookup that happens to miss — a refusal to answer a question nobody
    // asked, the same one `sdkModelsMember` makes.
    //
    // Every refused spelling below is DECLARED by the typings this case is run
    // against, so the lookup would answer for each of them. That is what makes
    // the assertions about the guard rather than about a coincidental miss: run
    // against the real clients they pass with the guard deleted, because no
    // real model declares a member with a dot in it.
    const CLIENT = '@aws-sdk/client-cdkd-probe';
    const REFUSED = ['Geo.Proximity', 'Geo-Proximity', 'Geo Proximity', 'Geo_Proximity', '9Lives', ''];
    withFakeClient(
      CLIENT,
      [
        // `*Request` because the walk only reaches sendable shapes now; a bare
        // `interface Weird` declares the same members and is reachable from
        // nothing, so every lookup would answer `undefined` and the control
        // below would pass without the guard existing.
        'export interface WeirdRequest {',
        ...REFUSED.map((n) => `  ${JSON.stringify(n)}?: string;`),
        '  GeoProximity?: string;',
        '}',
        '',
      ].join('\n'),
      (root) => {
        for (const bogus of REFUSED) {
          expect(
            typedSdkMember(bogus, CLIENT, root),
            `accepted a non-member name the typings DO declare: ${JSON.stringify(bogus)}`
          ).toBe(undefined);
        }
        // Control on the SAME typings: the one member whose name is a member
        // name is found, so the refusals above are the guard and not a walk
        // that never read the fabricated file.
        expect(typedSdkMember('GeoProximity', CLIENT, root)).toEqual({
          client: CLIENT,
          spelling: 'exact',
          interfaces: ['WeirdRequest'],
        });
      }
    );
  });
});

describe('providerWiresProperty', () => {
  it('counts an ELEMENT ACCESS off the template bag', () => {
    // `properties['X']` is how every provider reads a CFn property, and the
    // assertion is on the TEXT at the reported line rather than the line
    // number: what is being claimed is that the site really carries the shape.
    const wired = providerWiresProperty('GeoProximityLocation', ROUTE53, REPO_ROOT);
    expect(wired, 'the anchor provider no longer reads the property').toBeDefined();
    const reads = wired!.sites.filter((s) =>
      lineAt(s).includes("properties['GeoProximityLocation']")
    );
    expect(reads.length, 'no reported site is an element access on the template').toBeGreaterThan(0);
  });

  it('does NOT count a PROPERTY ACCESS, because a read-back spells it the same', () => {
    // INVERTED from the case that used to live here, and the inversion is a
    // correction rather than a loosening. `.X` counted as wiring until a review
    // measured what it was actually crediting: a drift comparator walking the
    // SDK's RESPONSE accesses exactly the names cdkd would send, so the shape
    // cannot tell delivery from read-back. `GlueJobProvider.readCurrentState`
    // is the real instance — it reads `job.MaxRetries`, `job.GlueVersion` and
    // the rest off a `GetJob` response — and it was the SOLE evidence for these
    // fifteen `AWS::Glue::Job` properties (measured 2026-09-08, the whole
    // declared set minus the nine that also have a template read).
    const DOT_ONLY_GLUE_JOB_PROPERTIES = [
      'AllocatedCapacity',
      'DefaultArguments',
      'ExecutionClass',
      'GlueVersion',
      'JobMode',
      'JobRunQueuingEnabled',
      'LogUri',
      'MaintenanceWindow',
      'MaxCapacity',
      'MaxRetries',
      'NonOverridableArguments',
      'NumberOfWorkers',
      'SecurityConfiguration',
      'Timeout',
      'WorkerType',
    ];
    const glue = readFileSync(join(REPO_ROOT, GLUE), 'utf8');
    for (const property of DOT_ONLY_GLUE_JOB_PROPERTIES) {
      // The half that makes the refusal observable: the access IS in the file,
      // so a `.X` recognizer answers for every one of these.
      expect(
        new RegExp(`\\.${property}\\b`).test(glue),
        `${property} is no longer read back off the SDK response — pick another anchor`
      ).toBe(true);
      expect(
        providerWiresProperty(property, GLUE, REPO_ROOT),
        `${property} was credited from a property access alone`
      ).toBe(undefined);
    }
    // Control from the same file: a Glue property the provider READS off the
    // template still answers, so the fifteen `undefined`s above are the shape
    // refusal and not the file failing to parse.
    expect(providerWiresProperty('Role', GLUE, REPO_ROOT)).toBeDefined();

    // Same refusal on the anchor provider, where the property access sits next
    // to a real template read: every reported site is an ELEMENT access, and
    // none is the `.X` shape.
    const wired = providerWiresProperty('GeoProximityLocation', ROUTE53, REPO_ROOT);
    expect(
      /[^'[]\.GeoProximityLocation\b/.test(readFileSync(join(REPO_ROOT, ROUTE53), 'utf8')),
      'the anchor provider no longer contains a property access, so this half is vacuous'
    ).toBe(true);
    for (const site of wired!.sites) {
      expect(lineAt(site), `${site} is not an element access`).toContain(
        "['GeoProximityLocation']"
      );
      expect(lineAt(site), `${site} is a property access`).not.toMatch(
        /[^'[]\.GeoProximityLocation\b/
      );
    }
    expect(
      wired!.sites.some((s) => lineAt(s).includes("properties['GeoProximityLocation']")),
      'no reported site is a template read'
    ).toBe(true);
    // KNOWN BOUND, pinned rather than described: the recognizer accepts an
    // element access on ANY object, so `result['GeoProximityLocation']` in the
    // drift read-back is credited too. The direction is the mild one — a
    // declaration is KEPT that might have been retired — but it means the
    // read-back is not fully excluded, only the `.X` half of it. If the module
    // is ever scoped to the template bag, this assertion reds and names why.
    expect(
      wired!.sites.some((s) => /\bresult\['GeoProximityLocation'\]/.test(lineAt(s))),
      'the read-back element access is no longer credited — retire this bound'
    ).toBe(true);
    // Every site is a `relPath:line` on the file that was asked about, unique
    // and sorted — a site set naming another file would be the cross-provider
    // misattribution this module's sibling was rewritten to close.
    for (const site of wired!.sites) expect(site.startsWith(`${ROUTE53}:`)).toBe(true);
    expect(new Set(wired!.sites).size).toBe(wired!.sites.length);
    expect([...wired!.sites]).toEqual([...wired!.sites].sort());
  });

  it('reports the element access at a 1-based line, and the access shape not at all', () => {
    // The line is checked at 1 because an off-by-one would still "look right"
    // in the middle of a 2500-line provider, and the second arm is the isolated
    // twin of the Glue case: the ONLY thing in the file is `request.Solo`, so
    // `undefined` cannot be coming from anything else.
    withProvider("const v = properties['Solo'];\n", (rel, root) => {
      expect(providerWiresProperty('Solo', rel, root)).toEqual({ sites: [`${rel}:1`] });
    });
    withProvider('const v = request.Solo;\n', (rel, root) => {
      expect(providerWiresProperty('Solo', rel, root)).toBe(undefined);
    });
  });

  it('answers undefined for a property the provider only DECLARES', () => {
    // `Serial` is in `iam-access-key-provider.ts`'s `handledProperties` set and
    // is returned as a bare literal from a list — and is read nowhere. That is
    // the whole discrimination: the file DOES contain the string, so a text
    // scan says "wired".
    //
    // What this case does NOT say is that the property is dead weight. The
    // helper's absence means COULD NOT DETERMINE, and the SQS case below is the
    // measured proof that reading it as "wires nowhere" produces wrong advice.
    expect(
      readFileSync(join(REPO_ROOT, IAM_ACCESS_KEY), 'utf8').includes("'Serial'"),
      'the anchor provider no longer names the property, so the case is vacuous'
    ).toBe(true);
    expect(providerWiresProperty('Serial', IAM_ACCESS_KEY, REPO_ROOT)).toBe(undefined);
    // Control from the same file: a sibling of the same declaration set IS
    // wired, so the `undefined` is not the whole file failing to parse.
    expect(providerWiresProperty('UserName', IAM_ACCESS_KEY, REPO_ROOT)).toBeDefined();

    // The second real instance, and the one the classifier's fourth arm runs
    // on: `TemplateURL` is declared by `nested-stack-provider.ts` and read
    // nowhere, while `@aws-sdk/client-cloudformation` declares the member.
    expect(providerWiresProperty('TemplateURL', NESTED_STACK, REPO_ROOT)).toBe(undefined);
    expect(typedSdkMember('TemplateURL', '@aws-sdk/client-cloudformation', REPO_ROOT)).toBeDefined();
  });

  it('answers undefined for a property the provider genuinely DELIVERS', () => {
    // The case that fixes the meaning of `undefined`, and the reason the
    // classifier no longer calls an absent site a cleanup. `AWS::SQS::Queue`
    // delivers `DelaySeconds` and `VisibilityTimeout` through
    // `CDK_TO_SQS_ATTRIBUTES`, a shorthand-keyed lookup map iterated with
    // `Object.entries(...)` and indexed as `properties[cdkKey]` — so no literal
    // `properties['DelaySeconds']` exists anywhere and this helper sees none of
    // it. Measured: both "wires nowhere" verdicts the tree could produce were
    // WRONG, and the runbook built on them told a maintainer to delete the
    // declaration for a property cdkd sends on every create and update.
    const sqs = readFileSync(join(REPO_ROOT, SQS), 'utf8');
    for (const property of ['DelaySeconds', 'VisibilityTimeout']) {
      // The delivery is real: the name is a key of the table, and the table is
      // iterated into the request. Both halves asserted, because either one
      // alone is satisfied by a declaration list.
      expect(
        new RegExp(`^\\s+${property}: '`, 'm').test(sqs),
        `${property} is no longer a key of the SQS attribute table`
      ).toBe(true);
      expect(providerWiresProperty(property, SQS, REPO_ROOT)).toBe(undefined);
    }
    expect(
      sqs.includes('for (const [cdkKey, sqsKey] of Object.entries(CDK_TO_SQS_ATTRIBUTES))') &&
        sqs.includes('properties[cdkKey]'),
      'the table-driven delivery moved, so this case no longer shows invisible wiring'
    ).toBe(true);
    // Control from the same file: the one property read by literal DOES answer,
    // so the two `undefined`s are the table being invisible rather than the
    // provider being unparsed.
    expect(providerWiresProperty('QueueName', SQS, REPO_ROOT)).toBeDefined();
  });

  it('is not a text scan: a literal, a comment and a string all fail to vouch', () => {
    // Three shapes that spell the property identically to a real use. A bare
    // literal in a declaration array is the shape `handledProperties` is built
    // from, and it must be the one thing that cannot answer this question.
    withProvider(
      [
        "const handled = new Set(['Ghost']);",
        '// obj.Ghost is deliberately only mentioned here',
        'const s = "properties[\'Ghost\']";',
        "const other = properties['Present'];",
        '',
      ].join('\n'),
      (rel, root) => {
        expect(providerWiresProperty('Ghost', rel, root)).toBe(undefined);
        // Control in the SAME file: the recognizer is alive, it just refuses
        // the three shapes above.
        expect(providerWiresProperty('Present', rel, root)).toEqual({ sites: [`${rel}:4`] });
      }
    );
  });

  it('answers undefined for no provider path and for a path that is not there', () => {
    expect(providerWiresProperty('GeoProximityLocation', undefined, REPO_ROOT)).toBe(undefined);
    expect(
      providerWiresProperty(
        'GeoProximityLocation',
        'src/provisioning/providers/cdkd-no-such-provider.ts',
        REPO_ROOT
      )
    ).toBe(undefined);
    // Control: the same name, same root, on a file that IS there.
    expect(providerWiresProperty('GeoProximityLocation', ROUTE53, REPO_ROOT)).toBeDefined();
  });

  it('scopes the answer to the provider it was asked about', () => {
    // `StageName` is wired by the API Gateway provider and by nothing in the
    // Route 53 one. A file-agnostic lookup is the misattribution class that
    // made `AWS::CodeCommit::Repository.Id` report CloudFront evidence.
    expect(providerWiresProperty('StageName', APIGW, REPO_ROOT)).toBeDefined();
    expect(providerWiresProperty('StageName', ROUTE53, REPO_ROOT)).toBe(undefined);
  });
});
