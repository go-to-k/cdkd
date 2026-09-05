import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';

// cdkd LogGroupClass update-guard integ probe.
//
// Modes (CDKD_TEST_UPDATE, comma-separated). Every combination listed below is
// one that verify.sh actually passes, and nothing else is accepted — an alias
// no phase drives would be an untested arm:
//   <unset>            LogGroupClass STANDARD, deletion protection OFF (P1).
//   true               LogGroupClass INFREQUENT_ACCESS (P2, P3). "true" is the
//                      spelling this fixture shipped with, kept so the mode
//                      list stays a superset of the original.
//   true,protect       INFREQUENT_ACCESS + DeletionProtectionEnabled (P4).
//   protect            STANDARD + DeletionProtectionEnabled (P5, P6, P7) — the
//                      class change that reaches the issue #2579 arm.
//
// CloudFormation documents LogGroupClass as "Update requires: Updates are not
// supported" — there is no CloudWatch Logs API to change a log group's class
// after creation, and a CFn stack update carrying the change FAILS. cdkd
// previously silently DROPPED the change (deploy reported success while AWS
// kept the old class, and state recorded the new one so the next diff saw no
// change and it could never self-heal). The fix throws the typed
// ResourceUpdateNotSupportedError with an actionable message; `--replace`
// (plus `--force-stateful-recreation`, since a log group retains data)
// recreates the group under the new class.
//
// Issue #2579 gave that refusal a SECOND arm: on a log group cdkd's recorded
// properties show as carrying `DeletionProtectionEnabled`, those two flags are
// not enough — the replacement's DELETE runs from the deploy engine, which
// never sets `DeleteContext.removeProtection` (`cdkd deploy` has no
// `--remove-protection` flag at all), so AWS refuses the DeleteLogGroup and the
// advised command dies on a second wall. `protect` is what reaches that arm.
// verify.sh exercises BOTH arms, and the out-of-band remedy the protected
// arm's message hands the reader.
//
// The log group is EXPLICITLY named rather than left to cdkd's generated
// `/cdkd/<logicalId>` name: `verify.sh`'s teardown has to be able to clear
// deletion protection and delete the group from a fixture-owned PREFIX even
// when the cdkd state record is gone (a crashed run leaves a PROTECTED log
// group, which nothing else in the account can be swept for safely — `/cdkd/`
// is shared with every other fixture).
export class LoggroupClassGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env.CDKD_TEST_UPDATE ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    const toInfrequentAccess = modes.includes('true');
    const deletionProtection = modes.includes('protect');

    const lg = new logs.LogGroup(this, 'ClassLg', {
      // Keep in sync with `LG_NAME` in verify.sh, which asserts the two agree.
      logGroupName: '/cdkd-integ/loggroup-class-guard/class',
      retention: logs.RetentionDays.ONE_DAY,
      logGroupClass: toInfrequentAccess
        ? logs.LogGroupClass.INFREQUENT_ACCESS
        : logs.LogGroupClass.STANDARD,
      // Declared on BOTH polarities, never omitted: the guard reads the
      // RECORDED bag, and an ABSENT key and an explicit `false` are different
      // inputs to `isTruthyCfnBoolean`. Spelling the unprotected phases as an
      // explicit `false` is what makes them a real negative case for the
      // protected arm rather than a test of absence.
      deletionProtectionEnabled: deletionProtection,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'LgName', { value: lg.logGroupName });
  }
}
