import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';

/**
 * go-to-k/cdkd#5875: `DeletionProtectionCheck` is a write-only property that
 * AppConfig takes on the `DeleteEnvironment` call itself, so the destroy has
 * to forward the template's value. The environment declares `BYPASS`;
 * `verify.sh` reads the configuration through `appconfigdata` right before the
 * destroy, then asserts that an `APPLY` delete is refused, which proves the
 * protection window is open whatever the account default is. No account-level
 * setting is touched.
 *
 * covers: AWS::AppConfig::Application
 * covers: AWS::AppConfig::Environment
 * covers: AWS::AppConfig::ConfigurationProfile
 * covers: AWS::AppConfig::DeploymentStrategy
 * covers: AWS::AppConfig::HostedConfigurationVersion
 * covers: AWS::AppConfig::Deployment
 */
export class AppConfigEnvironmentDeleteProtectionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const app = new appconfig.CfnApplication(this, 'App', { name: `${id}-app` });

    const environment = new appconfig.CfnEnvironment(this, 'Env', {
      applicationId: app.ref,
      name: `${id}-env`,
      deletionProtectionCheck: 'BYPASS',
    });

    const profile = new appconfig.CfnConfigurationProfile(this, 'Profile', {
      applicationId: app.ref,
      name: `${id}-profile`,
      locationUri: 'hosted',
      type: 'AWS.Freeform',
    });

    const strategy = new appconfig.CfnDeploymentStrategy(this, 'Strategy', {
      name: `${id}-strategy`,
      deploymentDurationInMinutes: 0,
      growthFactor: 100,
      finalBakeTimeInMinutes: 0,
      replicateTo: 'NONE',
    });

    const version = new appconfig.CfnHostedConfigurationVersion(this, 'Version', {
      applicationId: app.ref,
      configurationProfileId: profile.ref,
      contentType: 'application/json',
      content: JSON.stringify({ feature: 'v1', enabled: true }),
    });

    const deployment = new appconfig.CfnDeployment(this, 'Deployment', {
      applicationId: app.ref,
      environmentId: environment.ref,
      configurationProfileId: profile.ref,
      configurationVersion: version.ref,
      deploymentStrategyId: strategy.ref,
    });
    deployment.addDependency(version);

    new cdk.CfnOutput(this, 'AppId', { value: app.ref });
    new cdk.CfnOutput(this, 'EnvId', { value: environment.ref });
    new cdk.CfnOutput(this, 'ProfileId', { value: profile.ref });
  }
}
