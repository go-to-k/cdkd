import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Integ fixture for issue #3199 — the rollback executor's
 * `reverse-replacement` replay-CREATE must fill a `FALLBACK_NAME_RULES` name
 * when the re-create is routed to Cloud Control.
 *
 * WHY `AWS::IAM::Role`
 *
 * Three constraints have to hold at once, and this type is the only cheap one
 * that satisfies all three. Two earlier drafts failed on the first two, so the
 * reasoning is recorded rather than re-derived:
 *
 *  1. **The replacement must CHANGE the physical id**, because that is what
 *     `isReplacementOp` keys on. `RoleName` is both the primary identifier and
 *     a create-only property, so changing the name IS the replacement trigger
 *     and the id necessarily changes.
 *  2. **No duplicate-name collision may occur on the path.** The new role is
 *     created under a DIFFERENT name, so the create-first attempt never
 *     collides. This matters because every collision-based route is currently
 *     blocked by go-to-k/cdkd#3208 (`isNameCollisionError` misses some
 *     services' spellings) — an ELBv2 draft died there twice.
 *  3. **The type must not be in `STATEFUL_TYPES`.** An ECR draft died here:
 *     `--recreate-via-cc-api` refuses a stateful type without
 *     `--force-stateful-recreation`, and a property-driven replacement of one
 *     hits a second guard. Forcing past both would make the fixture
 *     unrepresentative of the path under test. IAM roles are in neither guard.
 *
 * It is also the RIGHT discriminator. `RoleName` is OPTIONAL in CloudFormation
 * (AWS auto-generates one), so on a tree without the fix the replay's Cloud
 * Control create succeeds and AWS mints a random name — the resource comes
 * back under a name that is not the one cdkd would have minted, silently. That
 * silent divergence is precisely what #3199 fixes for the 40 table types today;
 * a type whose handler REJECTED a nameless create would instead fail loudly,
 * which is a different (and currently hypothetical) half of the issue.
 *
 * And it is cheap: two resources, no VPC, no NAT, no data.
 *
 * ENV SEAMS
 *
 * - `ROLE_EXPLICIT_NAME` — when set, the role declares that name. Unset
 *   (phases 1-2) it is UNNAMED and cdkd mints `<stack>-<logicalId>`.
 * - `ROLE_DESCRIPTION` — a MUTABLE property, so phase 2's
 *   `--recreate-via-cc-api` has a real change to carry. Without one the differ
 *   classifies the resource NO_CHANGE and the migration never runs
 *   (go-to-k/cdkd#2651).
 * - `REPLAY_CC_NAME_FAIL` — injects a deliberately invalid SQS queue.
 *
 * THE FIXED `Path`
 *
 * Every role this fixture creates sits under `/cdkd-replay-ccname/`. That is
 * what lets phase 4 ENUMERATE the roles this stack owns
 * (`iam list-roles --path-prefix`) instead of matching on a name prefix — and
 * enumeration is the whole point, because the regression produces a role whose
 * name AWS chose. A name-prefix query cannot see it, so the "exactly one, named
 * X" assertion would pass on exactly the broken tree. `Path` is itself
 * create-only, so it is held CONSTANT across every phase.
 *
 * THE FAILURE INJECTION
 *
 * `messageRetentionPeriod: 9999999` is outside SQS's valid [60, 1209600], so
 * AWS rejects CreateQueue. The queue DEPENDS ON the role so the role's
 * replacement is guaranteed COMPLETE before the failure fires — the
 * event-driven DAG dispatches a node only once all its deps finish. A completed
 * replacement is what the rollback then has to reverse; without the dependency
 * the two race and the run is flaky.
 *
 * REMOVAL POLICIES
 *
 * None are set, deliberately. `scripts/check-fixture-removal-policy.ts` scopes
 * its STATEFUL_CONSTRUCTS list to eleven L2 families; `iam.CfnRole` and
 * `sqs.CfnQueue` are L1s whose CloudFormation default is already `Delete`.
 */
export class RollbackReplayCcGeneratedNameStack extends cdk.Stack {
  /** Held constant across phases; phase 4 enumerates by it. */
  public static readonly ROLE_PATH = '/cdkd-replay-ccname/';

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const explicitName = process.env['ROLE_EXPLICIT_NAME'];
    const description = process.env['ROLE_DESCRIPTION'] ?? 'cdkd #3199 replay fixture';

    // UNNAMED unless the seam supplies one. The unnamed case is the point:
    // cdkd fills `<stack>-<logicalId>` on the create, and the state record
    // still holds NO `RoleName` — so the replay has nothing to re-send unless
    // it runs the fill too.
    const role = new iam.CfnRole(this, 'Role', {
      path: RollbackReplayCcGeneratedNameStack.ROLE_PATH,
      description,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      ...(explicitName !== undefined && explicitName !== '' ? { roleName: explicitName } : {}),
    });

    new cdk.CfnOutput(this, 'RoleName', {
      value: role.ref,
      description: 'Role physical id (IAM role physical id IS the name)',
    });

    // --- Failure injection (gated) -----------------------------------------
    if (process.env['REPLAY_CC_NAME_FAIL'] === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        // Outside the valid [60, 1209600] range — AWS rejects CreateQueue.
        messageRetentionPeriod: 9999999,
      });
      // Guarantees the role replacement has COMPLETED before this fires.
      failing.node.addDependency(role);
    }
  }
}
