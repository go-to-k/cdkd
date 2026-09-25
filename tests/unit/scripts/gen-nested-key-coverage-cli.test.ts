import { afterAll, describe, it, expect } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MIN_WRITTEN_MEMBERS_PER_PROVIDER, NESTED_KEY_ALLOW_LIST, NESTED_KEY_TARGETS, loadReport } from '../../../scripts/gen-nested-key-coverage.ts';

// Split from gen-nested-key-coverage.test.ts so these ~2s spawns run in their own
// worker instead of lengthening that file, the longest pole of the suite.
// Vitest's concurrent mode is not an option: the stream fence buffers per worker.

const repoRoot = process.cwd();
const SCRIPT = resolve(repoRoot, 'scripts/gen-nested-key-coverage.ts');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');

// The probes in gen-nested-key-coverage.test.ts drive the library functions. This block drives the
// SHIPPED command — argv parsing, `loadReport`, the failure text and the EXIT
// CODE — because that is what CI actually runs, and because two fences (the
// write-collector floors) are unreachable any other way: `loadReport`'s
// handledProperties throw precedes them unless the providers tree itself is
// swapped. Pattern copied from `gen-handled-property-wiring.test.ts` (#1448).
describe('the shipped --check command', { timeout: 30_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cdkd-nkc-cli-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const runCheck = (providersDir?: string): { status: number; stderr: string } => {
    const args = ['--check', ...(providersDir ? [`--providers-dir=${providersDir}`] : [])];
    const run = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.error, 'the critic must be spawnable').toBeUndefined();
    return { status: run.status ?? -1, stderr: run.stderr };
  };

  /** A scratch COPY of the REAL providers tree, with one regression injected. */
  const regressedTree = (name: string, file: string, edit: (source: string) => string): string => {
    const dir = join(scratch, name);
    cpSync(PROVIDERS_DIR, dir, { recursive: true });
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = edit(before);
    expect(after, `the ${name} probe changed nothing — anchor drifted?`).not.toBe(before);
    writeFileSync(path, after);
    return dir;
  };

  it('exits 0 and reports its coverage on the real providers tree', () => {
    const { status, stderr } = runCheck();
    expect(status).toBe(0);
    expect(stderr).toContain('nested-key-coverage: OK');
    expect(stderr).toContain('0 divergences');
  });

  it('exits 1 naming BuildBatchConfig.ServiceRole when its forward write is deleted (#1448)', () => {
    // The issue's acceptance criterion, run end to end against REAL provider
    // source: a MULTIPLY-written member whose forward write is gone. Under the
    // name-global evidence of #1432 this exited 0.
    const dir = regressedTree('providers-scoped', 'codebuild-provider.ts', (source) =>
      source.replace("        serviceRole: cfnBuildBatchConfig['ServiceRole'] as string | undefined,\n", '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::CodeBuild::Project: BuildBatchConfig.ServiceRole');
    expect(stderr).toContain('no-write-evidence');
  });

  // The #1464 acceptance, end to end against REAL provider source: two writes of
  // `type` under ONE top-level, each fenced by its own path. Through #1448 both
  // deletions exited 0 (the flattened fixture made them the same audited unit),
  // so these are the shipped-command twins of the inverted library probes above.
  const DUPLICATE_NAME_PROBES: ReadonlyArray<{
    readonly name: string;
    readonly anchor: string;
    readonly flagged: string;
    readonly clean: string;
  }> = [
    {
      name: 'environment-type',
      anchor:
        "        type: readConfigString(\n" +
        "          environment,\n" +
        "          'Type',\n" +
        "          'LINUX_CONTAINER',\n" +
        "          'AWS::CodeBuild::Project Environment'\n" +
        "        ) as EnvironmentType,\n",
      flagged: 'AWS::CodeBuild::Project: Environment.Type',
      clean: 'Environment.EnvironmentVariables.Type',
    },
    {
      name: 'environment-variables-type',
      anchor: "              type: (v.Type ?? 'PLAINTEXT') as EnvironmentVariableType,\n",
      flagged: 'AWS::CodeBuild::Project: Environment.EnvironmentVariables.Type',
      clean: 'Environment.Type',
    },
  ];

  for (const { name, anchor, flagged, clean } of DUPLICATE_NAME_PROBES) {
    it(`exits 1 naming ${flagged.split(': ')[1]}, leaving its cousin clean (#1464)`, () => {
      const dir = regressedTree(`providers-${name}`, 'codebuild-provider.ts', (source) => {
        expect(source, `${name} anchor drifted`).toContain(anchor);
        return source.replace(anchor, '');
      });
      const { status, stderr } = runCheck(dir);
      expect(status).toBe(1);
      expect(stderr).toContain('nested-key-coverage: FAIL');
      expect(stderr).toContain(flagged);
      expect(stderr).toContain('no-write-evidence');
      // The cousin must NOT be reported — this is the half that proves the two
      // paths are separated rather than both flagging.
      expect(stderr).not.toContain(`AWS::CodeBuild::Project: ${clean} [`);
    });
  }

  it('exits 1 naming LifecycleConfiguration.Rules.Prefix although a DIFF-side fold writes it (#1755)', () => {
    // Promoted from a COMMENT to a real probe (PR review). Issues #1754 / #1755
    // / #1759 added `foldLifecycleScope`, which writes `out['Prefix']` on the
    // DIFF side — the exact shape that, spelled as a named-member spread, makes
    // a pure function vouch for the forward mapper and switches the write pass
    // off for a whole subtree (#1475). The measurement that it does NOT was
    // recorded in prose, which decays silently; run it through the same seam as
    // its siblings so the claim re-verifies on every CI run.
    const dir = regressedTree('providers-s3-lifecycle-prefix', 's3-bucket-provider.ts', (source) =>
      source.replace(
        "        Prefix: useFilterForm ? undefined : (rule['Prefix'] as string | undefined),\n",
        ''
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::S3::Bucket: LifecycleConfiguration.Rules.Prefix');
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 1 naming BuildBatchConfig.BatchReportMode when its forward write is deleted', () => {
    const dir = regressedTree('providers-batchreport', 'codebuild-provider.ts', (source) =>
      source.replace(
        "batchReportMode: cfnBuildBatchConfig['BatchReportMode'] as BatchReportModeType | undefined,",
        ''
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('AWS::CodeBuild::Project: BuildBatchConfig.BatchReportMode');
  });

  // WHOLE-BLOB HAND-OFF probes (issue #1445), on the newly opted-in
  // `AWS::ApiGatewayV2::Stage`. `DefaultRouteSettings` is forwarded whole at
  // TWO sites (create + update) and the scope index unions write sites, so
  // every probe below edits BOTH — see the module header's known bound (2),
  // which the first probe pins.
  const ROUTE_SETTINGS_CREATE =
    "          DefaultRouteSettings: properties['DefaultRouteSettings'] as RouteSettings | undefined,\n";
  const ROUTE_SETTINGS_UPDATE =
    "      input.DefaultRouteSettings = properties['DefaultRouteSettings'] as RouteSettings;\n";
  const editRouteSettings =
    (create: string, update: string) =>
    (source: string): string => {
      expect(source, 'create-side anchor drifted').toContain(ROUTE_SETTINGS_CREATE);
      expect(source, 'update-side anchor drifted').toContain(ROUTE_SETTINGS_UPDATE);
      return source
        .replace(ROUTE_SETTINGS_CREATE, create)
        .replace(ROUTE_SETTINGS_UPDATE, update);
    };

  it('exits 1 naming every DefaultRouteSettings member when BOTH forwards are deleted', () => {
    const dir = regressedTree(
      'providers-handoff-gone',
      'apigatewayv2-provider.ts',
      editRouteSettings('', '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    for (const key of [
      'DataTraceEnabled',
      'DetailedMetricsEnabled',
      'LoggingLevel',
      'ThrottlingBurstLimit',
      'ThrottlingRateLimit',
    ]) {
      expect(stderr, key).toContain(`AWS::ApiGatewayV2::Stage: DefaultRouteSettings.${key}`);
    }
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 0 when only ONE of the two forwards is deleted (known bound 2, measured)', () => {
    // Hand-off points are unioned across write sites exactly as scopes are, so
    // a provider that stops forwarding on ONE path is not fenced. Recorded as a
    // bound rather than discovered later.
    const dir = regressedTree('providers-handoff-one-site', 'apigatewayv2-provider.ts', (source) =>
      source.replace(ROUTE_SETTINGS_CREATE, '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(0);
    // Not just "exit 0": assert the run actually AUDITED and found nothing, so
    // a target silently dropping out of the table cannot satisfy this probe.
    expect(stderr).toContain('nested-key-coverage: OK');
    expect(stderr).toContain('0 divergences');
    expect(stderr).toContain('15 fresh-object target(s)');
  });

  it('exits 1 naming ONLY the members a partial hand-mapping leaves out', () => {
    // The discrimination the whole issue turns on: the moment the provider
    // stops handing the blob over whole and starts naming members, every member
    // it does NOT name has to prove itself — and the one it does name passes.
    const dir = regressedTree(
      'providers-handoff-partial',
      'apigatewayv2-provider.ts',
      editRouteSettings(
        '          DefaultRouteSettings: {\n' +
          "            LoggingLevel: (properties['DefaultRouteSettings'] as RouteSettings | undefined)\n" +
          '              ?.LoggingLevel,\n' +
          '          },\n',
        '      input.DefaultRouteSettings = {\n' +
          "        LoggingLevel: (properties['DefaultRouteSettings'] as RouteSettings).LoggingLevel,\n" +
          '      };\n'
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    for (const key of [
      'DataTraceEnabled',
      'DetailedMetricsEnabled',
      'ThrottlingBurstLimit',
      'ThrottlingRateLimit',
    ]) {
      expect(stderr, key).toContain(`AWS::ApiGatewayV2::Stage: DefaultRouteSettings.${key}`);
    }
    expect(stderr).not.toContain('DefaultRouteSettings.LoggingLevel');
  });

  it('exits 0 when the forward is routed through the REAL generic converter', () => {
    // The positive half of the acceptance: a generic-converter-delivered key
    // does NOT flag, proven end to end against real provider source and the
    // real sibling-module `pascalToCamelCaseKeys`.
    const dir = regressedTree('providers-handoff-generic', 'apigatewayv2-provider.ts', (source) =>
      "import { pascalToCamelCaseKeys } from './agentcore-case-convert.js';\n" +
      editRouteSettings(
        '          DefaultRouteSettings: pascalToCamelCaseKeys(\n' +
          "            properties['DefaultRouteSettings']\n" +
          '          ) as RouteSettings | undefined,\n',
        '      input.DefaultRouteSettings = pascalToCamelCaseKeys(\n' +
          "        properties['DefaultRouteSettings']\n" +
          '      ) as RouteSettings;\n'
      )(source)
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(0);
    expect(stderr).toContain('nested-key-coverage: OK');
  });

  it('exits 1 on the SAME shape when the blob is not read off the property bag', () => {
    // Identical syntax, different origin: the taint root is what stops an
    // AWS-response echo from counting as a template forward.
    const dir = regressedTree('providers-handoff-untainted', 'apigatewayv2-provider.ts', (source) =>
      source
        .replace(
          ROUTE_SETTINGS_CREATE,
          "          DefaultRouteSettings: this.echoed['DefaultRouteSettings'] as RouteSettings | undefined,\n"
        )
        .replace(
          ROUTE_SETTINGS_UPDATE,
          "      input.DefaultRouteSettings = this.echoed['DefaultRouteSettings'] as RouteSettings;\n"
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('AWS::ApiGatewayV2::Stage: DefaultRouteSettings.LoggingLevel');
  });

  it('exits 1 on a collapsed hand-off walk, naming the walk (not 13 divergences)', () => {
    // Renaming the desired-state bag out of `HANDOFF_BAG_PARAM_NAMES` is a real
    // shape of collapse: every write NAME and every SCOPE survives, so only the
    // dedicated floor can name the cause.
    const dir = regressedTree('providers-handoff-collapsed', 'apigatewayv2-provider.ts', (source) =>
      source.replaceAll(/\bproperties\b/g, 'bag')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('whole-blob hand-off walk for apigatewayv2-provider.ts collapsed');
    expect(stderr).toContain('parser regression?');
    expect(stderr).not.toContain('no-write-evidence');
  });

  it('exits 1 on a collapsed write-collector parse, naming the parser (not 90 divergences)', () => {
    // Renaming the forward mappers into the reverse-map prefix is a real shape
    // of collapse (the exclusion swallows them), and it is the ONLY way to
    // reach `MIN_WRITTEN_MEMBERS_PER_PROVIDER` — hence the providers-dir seam.
    const dir = regressedTree('providers-collapsed', 'codebuild-provider.ts', (source) => {
      let out = source;
      for (const name of ['mapProperties', 'mapSource', 'mapArtifacts']) {
        out = out.replaceAll(name, `readCurrentState${name[0]!.toUpperCase()}${name.slice(1)}`);
      }
      return out;
    });
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('written-member parse for codebuild-provider.ts collapsed');
    expect(stderr).toContain('parser regression?');
    // ...and NOT a wall of bogus per-key divergences.
    expect(stderr).not.toContain('no-write-evidence');
  });

  // One spawned case per CI-BLOCKING verdict, per the repo's checker rules —
  // "each" means each, and four of these were previously proven only through
  // the library functions. Each regression below is the same one the
  // corresponding library-level probe injects, so the two stay in step.
  const BLOCKING_VERDICT_PROBES: ReadonlyArray<{
    readonly bucket: string;
    readonly file: string;
    readonly named: string;
    readonly edit: (source: string) => string;
  }> = [
    {
      bucket: 'no-sdk-member',
      file: 'cloudfront-distribution-provider.ts',
      named: 'OriginCustomHeaders',
      edit: (source) => source.replaceAll('OriginCustomHeaders', 'RemovedCustomHeaders'),
    },
    {
      bucket: 'case-divergence',
      file: 'cloudfront-distribution-provider.ts',
      named: 'AcmCertificateArn',
      edit: (source) => source.replaceAll('AcmCertificateArn', 'XcmCertificateArn'),
    },
    {
      bucket: 'array-vs-wrapper',
      file: 'cloudfront-distribution-provider.ts',
      named: 'Aliases',
      edit: (source) => source.replaceAll('Aliases', 'Xliases'),
    },
    {
      bucket: 'definition-member-missing',
      file: 'cloudfront-distribution-provider.ts',
      named: 'CachedMethods',
      edit: (source) => source.replaceAll('CachedMethods', 'XachedMethods'),
    },
  ];

  for (const { bucket, file, named, edit } of BLOCKING_VERDICT_PROBES) {
    it(`exits 1 naming a real ${bucket} divergence from the seam`, () => {
      const dir = regressedTree(`providers-${bucket}`, file, edit);
      const { status, stderr } = runCheck(dir);
      expect(status).toBe(1);
      expect(stderr).toContain('nested-key-coverage: FAIL');
      expect(stderr).toContain(named);
      expect(stderr).toContain(bucket);
    });
  }

  it('exits 1 when a BUILDER-delivered write is deleted (#1474)', () => {
    // The library-level twin of this probe asserts the FINDING SET; this one
    // asserts the shipped process EXIT CODE, which is what CI acts on.
    // CloudWatch AnomalyDetector is the write-evidence pass's first
    // builder-dependent opt-in, so "a CloudWatch finding actually exits 1" has
    // to be proven, not inferred from the sibling ECS probes (#1474 review).
    const dir = regressedTree(
      'providers-builder-assignment',
      'cloudwatch-anomaly-detector-provider.ts',
      (source) =>
        source.replace(
          /^\s*if \(ranges !== undefined\) \{\n\s*mapped\.ExcludedTimeRanges = ranges\.map\(\(r\) => \(\{\n(?:.*\n)*?\s*\}\)\);\n\s*\}\n/m,
          ''
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::CloudWatch::AnomalyDetector');
    expect(stderr).toContain('Configuration.ExcludedTimeRanges');
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 1 naming ONLY the hand-named member deleted inside a builder value (#1474)', () => {
    // The precision half at the exit-code level: the builder credit must not
    // blanket the value it carries, so `StartTime` must stay out of the report.
    const dir = regressedTree(
      'providers-builder-member',
      'cloudwatch-anomaly-detector-provider.ts',
      (source) => source.replace("        EndTime: toDate(r['EndTime'], mask),\n", '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('Configuration.ExcludedTimeRanges.EndTime');
    expect(stderr).not.toContain('Configuration.ExcludedTimeRanges.StartTime');
  });

  it('exits 1 naming DistributionConfig.IPV6Enabled when the rename map entry is deleted (#1475)', () => {
    // The issue's REQUIRED fence: the spread recognizer must not turn the
    // CloudFront opt-in into a rubber stamp, so deleting the
    // `IPV6Enabled -> IsIPV6Enabled` rename from the real provider must still
    // exit non-zero. The failing pass is the KEY pass (`case-divergence` — the
    // map entry carried the only literal evidence for the CFn spelling, and
    // the installed SDK model carries `Ipv6Enabled` as the near-miss), which
    // is precisely why the write-pass wildcard cannot silence it: the deleted
    // key is EXCLUDED from the spread's credit, and the key pass judges the
    // non-SDK spelling at full strictness regardless.
    const dir = regressedTree(
      'providers-spread-rename',
      'cloudfront-distribution-provider.ts',
      (source) => source.replace("  IPV6Enabled: 'IsIPV6Enabled',\n", '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::CloudFront::Distribution: DistributionConfig.IPV6Enabled');
    expect(stderr).toContain('case-divergence');
  });

  it('exits 1 when a same-spelling member is deleted off the spread seed (#1475)', () => {
    // The DELETE-EXCLUSION fence live on real code: inserting
    // `delete result['Aliases']` after the spread removes the member from the
    // delivered object, so the wildcard must stop vouching for it.
    const dir = regressedTree(
      'providers-spread-delete',
      'cloudfront-distribution-provider.ts',
      (source) =>
        source.replace(
          '    const result = { ...config };\n',
          "    const result = { ...config };\n    delete result['Aliases'];\n"
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::CloudFront::Distribution: DistributionConfig.Aliases');
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 1 on an UNRESOLVABLE delete key — the registration refuses fail-closed (#1475)', () => {
    // A delete whose key set cannot be bounded must refuse the WHOLE spread
    // credit, which re-flags the entire wildcard-covered interior — the loud
    // direction, proven at the exit-code level.
    const dir = regressedTree(
      'providers-spread-unresolvable',
      'cloudfront-distribution-provider.ts',
      (source) =>
        source.replace(
          '    const result = { ...config };\n',
          '    const result = { ...config };\n' +
            '    const dynamicKey = Object.keys(config)[0]!;\n' +
            '    delete result[dynamicKey];\n'
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 1 when the spread seed stops being bag-derived (#1475)', () => {
    // Every CloudFront hand-off point derives from the root spread (the nested
    // seeds spread `result['X']`, whose taint flows from `{ ...config }`), so
    // removing the seed collapses the walk to zero points and the
    // `minHandoffPoints` floor fires — one legible error, not 160 findings.
    // This is the collapse mode that floor exists for, proven on real code.
    const dir = regressedTree(
      'providers-spread-seedless',
      'cloudfront-distribution-provider.ts',
      (source) =>
        source.replace(
          '    const result = { ...config };\n',
          '    const result: Record<string, unknown> = {};\n'
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('whole-blob hand-off walk for cloudfront-distribution-provider.ts');
    expect(stderr).toContain('collapsed to 0 blob-carrying hand-off point(s)');
  });

  it('exits 1 naming a STALE segmentRenames entry (#1464)', () => {
    // The other staleness fence, proven RED against real code. Renaming the SDK
    // member `properties` back to the CFn spelling makes the un-renamed chain
    // resolve, so `ProxyConfigurationProperties -> properties` stops earning
    // its place and must be reported rather than left as an inert exception —
    // the discipline `NESTED_KEY_ALLOW_LIST` has carried since #1373.
    const dir = regressedTree('providers-stale-rename', 'ecs-provider.ts', (source) =>
      source.replace(
        "      properties: this.convertEnvironment(\n",
        "      proxyConfigurationProperties: this.convertEnvironment(\n"
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('stale segmentRenames');
    expect(stderr).toContain('AWS::ECS::TaskDefinition#ProxyConfigurationProperties');
  });

  it('exits 1 on the ECS ProxyConfiguration children when the rename map is the only bridge', () => {
    // The POSITIVE half, inverted: the rename exists because deleting the
    // provider's write must still flag. Strip the `properties:` write entirely
    // and the two children re-surface by name — which is what proves the map is
    // a spelling bridge, not a silencer.
    const dir = regressedTree('providers-proxy-props-gone', 'ecs-provider.ts', (source) =>
      source.replace(
        "      properties: this.convertEnvironment(\n" +
          "        config['ProxyConfigurationProperties'] as Array<Record<string, unknown>> | undefined\n" +
          '      ),\n',
        ''
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    for (const key of ['Name', 'Value']) {
      expect(stderr, key).toContain(
        `AWS::ECS::TaskDefinition: ProxyConfiguration.ProxyConfigurationProperties.${key}`
      );
    }
  });

  // The #1393 item-3 mixed-case-island targets, probed the way
  // `.claude/rules/testing.md` requires: a REAL regression in REAL provider
  // code, driven through the SHIPPED command, not through the `fixtureDir`
  // library seam (which is deliberately not exposed on the CLI). The fixture
  // probes elsewhere in this file inject a CFn-side key; these delete the
  // PROVIDER-side conversion, which is the other half and the one the per-path
  // `provider-handled` assertions above assert without proving.
  it('exits 1 when the EventBridge ECS capacity-provider lowercasing is deleted (#1393)', () => {
    const dir = regressedTree('providers-eb-ecs', 'eventbridge-rule-provider.ts', (source) =>
      source.replace(
        ".map((item) => this.lowerCaseItemKeys(item, ['CapacityProvider', 'Weight', 'Base']));",
        '.map((item) => item);'
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    for (const key of ['CapacityProvider', 'Weight', 'Base']) {
      expect(stderr, key).toContain(
        `AWS::Events::Rule: Targets.EcsParameters.CapacityProviderStrategy.${key}`
      );
      expect(stderr, key).toContain('case-divergence');
    }
  });

  it('exits 1 when the Scheduler ECS capacity-provider lowercasing is deleted (#1393)', () => {
    // The SAME conversion in a DIFFERENT provider file and a different SDK
    // client — the pair is what proves each target fences its own provider
    // rather than one standing in for the other.
    const dir = regressedTree('providers-sch-ecs', 'scheduler-schedule-provider.ts', (source) =>
      source.replace(
        ".map((item) => this.renameItemKeys(item, ['CapacityProvider', 'Weight', 'Base'], 'lower'));",
        '.map((item) => item);'
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    for (const key of ['CapacityProvider', 'Weight', 'Base']) {
      expect(stderr, key).toContain(
        `AWS::Scheduler::Schedule: Target.EcsParameters.CapacityProviderStrategy.${key}`
      );
      expect(stderr, key).toContain('case-divergence');
    }
  });

  it('exits 1 when the Glue crawler scanRate rename bridge is deleted (#1393)', () => {
    // BOTH directions of the rename map have to go, and that is a measured
    // property of this target rather than thoroughness: deleting only the
    // forward entry leaves the CFn spelling `'ScanRate'` as a literal in the
    // REVERSE map (`SDK_TO_CFN_DYNAMODB_TARGET_KEYS`), and the rescue then still
    // clears the key — exit 0.
    //
    // The cause is the REVERSE-MAP ASYMMETRY, header bound (iv) / #1448
    // known-bound item 2: the write-evidence pass excludes the `read*` /
    // `*ToCfn` reverse families, but the literal collector does not, so a
    // spelling that survives only on the read side still vouches for the write
    // side. It is NOT the shared-file pool of bound (i) — both maps are
    // module-level consts in the SAME file, so class-scoping the literal pool
    // would leave this behaviour exactly as it is. Do not "simplify" this probe
    // to one deletion on the belief that scoping will fix it.
    const dir = regressedTree('providers-glue-scanrate', 'glue-provider.ts', (source) =>
      source
        .replace("  ScanAll: 'scanAll',\n  ScanRate: 'scanRate',\n", "  ScanAll: 'scanAll',\n")
        .replace("  scanAll: 'ScanAll',\n  scanRate: 'ScanRate',\n", "  scanAll: 'ScanAll',\n")
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('AWS::Glue::Crawler: Targets.DynamoDBTargets.ScanRate');
    expect(stderr).toContain('case-divergence');
  });

  it('exits 1 when a target fixture has no nestedPropertyPaths capture (#1464)', () => {
    // The RED direction of `loadReport`'s new loud failure, the twin of the
    // `definitionShapes` probe. A fixture tree that was only PARTIALLY
    // re-captured must name the missing capture and the command that fixes it,
    // not silently audit zero paths.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'cdkd-nkc-fx-'));
    cpSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas'), fixtureDir, { recursive: true });
    const path = join(fixtureDir, 'AWS-CodeBuild-Project.json');
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete fixture['nestedPropertyPaths'];
    writeFileSync(path, JSON.stringify(fixture, null, 2));
    const target = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::CodeBuild::Project')!;
    expect(() => loadReport([target], undefined, undefined, fixtureDir)).toThrow(
      /has no nestedPropertyPaths capture/
    );
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('exits 1 naming a STALE allow-list entry', () => {
    // The stale-entry fence, red-proven through the scoped literal rule
    // (#1393 item 2). A floating literal can no longer flip a key to
    // `provider-handled` (that rubber stamp is exactly what the rule
    // removed — the HostKernel form this probe used pre-#1393 now
    // correctly changes nothing), so the probe targets an entry whose
    // SCOPED evidence already exists: `CorsConfiguration.CorsRules` is
    // allow-listed only because the provider reads the CFn key via typed
    // property access — the write index already carries the ci-matching
    // SDK member `CORSRules` at the resolved parent scope. Naming the
    // literal makes the key `provider-handled`, the entry stops matching,
    // and `--check` must report it rather than silently keep it.
    const dir = regressedTree('providers-stale', 's3-bucket-provider.ts', (source) =>
      source.replace(
        'export class S3BucketProvider',
        "const NAMES_THE_KEY = ['CorsRules'];\nvoid NAMES_THE_KEY;\nexport class S3BucketProvider"
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('stale NESTED_KEY_ALLOW_LIST');
    expect(stderr).toContain('AWS::S3::Bucket#CorsConfiguration.CorsRules');
  });

  it('rejects an unrecognized flag instead of falling through to WRITER mode', () => {
    // `--chekc` used to REWRITE the committed matrix and exit 0 — the same
    // silent-full-run trap `refresh-cfn-schemas.mjs --help` had before its
    // guard (#1378 rider). The SPACE form of the seam is caught here too: it
    // does not match the `--providers-dir=` prefix, so without this guard it
    // would slip into the writer path.
    for (const flag of ['--chekc', '-c', '--providers-dir']) {
      const run = spawnSync(process.execPath, [SCRIPT, flag, '/tmp'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(run.status, flag).toBe(1);
      expect(run.stderr, flag).toContain('Usage:');
      expect(run.stdout, flag).not.toContain('wrote nested-key-coverage');
    }
  });

  it('--help prints usage and exits 0 without writing anything', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage:');
    expect(run.stderr).not.toContain('wrote nested-key-coverage');
  });

  it('refuses --providers-dir= in WRITER mode instead of rewriting the matrix', () => {
    // Without the guard the seam renders docs/_generated from a scratch tree.
    const run = spawnSync(process.execPath, [SCRIPT, `--providers-dir=${PROVIDERS_DIR}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--check-only test seam');
  });
});
