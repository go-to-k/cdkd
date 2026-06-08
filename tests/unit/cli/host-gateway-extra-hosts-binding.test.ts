import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(__dirname, '../../../src/cli/commands');
const SRC_LOCAL_DIR = path.join(__dirname, '../../../src/local');
const readCmd = (file: string): string => readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');
const readLocal = (file: string): string => readFileSync(path.join(SRC_LOCAL_DIR, file), 'utf-8');

/**
 * Site-level binding test (issue #784, following cdk-local #483; pattern per
 * memory `feedback_site_level_binding_test.md`).
 *
 * `resolveHostGatewayExtraHosts()` (re-exported from cdk-local via
 * `docker-version.ts`) gives a launched container `host.docker.internal`
 * reachability so it can hit a server on the host (an `AWS_ENDPOINT_URL_*`
 * local endpoint / tunneled VPC resource) on Linux native dockerd — where the
 * alias is NOT auto-resolved. cdkd keeps its OWN `invoke` / `run-task`
 * command paths (it does not embed cdk-local's `invoke` / `run-task`
 * factories), so each must resolve the mapping AND thread it into the docker
 * run: `cdkd local invoke` (Lambda RIE container -> `runDetached`'s
 * `extraHosts`) and `cdkd local run-task` (-> `runOpts.hostGatewayExtraHosts`,
 * merged in the runner via `mergeHostGatewayAddHostFlags`). `start-service` /
 * `start-alb` inherit the reachability automatically from cdk-local's bundled
 * ECS service emulator engine (cdkd's `ecs-service-emulator.ts` is a
 * re-export shim with no local resolve site), so they are NOT asserted here.
 *
 * The reachability only differs on Linux, so the integ suite (run on Docker
 * Desktop, which resolves the name natively regardless) cannot distinguish a
 * dropped wiring. This source-level binding pins each call site so a refactor
 * that silently drops the resolve / thread is caught.
 */
describe('host.docker.internal reachability wired at every cdkd-owned container run site', () => {
  it('docker-version.ts re-exports resolveHostGatewayExtraHosts from cdk-local', () => {
    const src = readLocal('docker-version.ts');
    expect(src).toMatch(/resolveHostGatewayExtraHosts/);
    expect(src).toMatch(/from 'cdk-local\/internal'/);
  });

  it('cdkd local invoke resolves the mapping and passes it to runDetached as extraHosts', () => {
    const src = readCmd('local-invoke.ts');
    expect(src).toMatch(/resolveHostGatewayExtraHosts\(\)/);
    expect(src).toMatch(/extraHosts:\s*hostGatewayExtraHosts/);
  });

  it('cdkd local run-task resolves the mapping and sets it on the runEcsTask options', () => {
    const src = readCmd('local-run-task.ts');
    expect(src).toMatch(/resolveHostGatewayExtraHosts\(\)/);
    expect(src).toMatch(/runOpts\.hostGatewayExtraHosts\s*=/);
    // ...and the option is threaded into the run, not resolved-then-dropped.
    expect(src).toMatch(/runEcsTask\(/);
  });

  it('ecs-task-runner merges the host-gateway mapping into the per-container --add-host flags', () => {
    const src = readLocal('ecs-task-runner.ts');
    expect(src).toMatch(/mergeHostGatewayAddHostFlags\(/);
    expect(src).toMatch(/hostGatewayExtraHosts/);
  });
});
