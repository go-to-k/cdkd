import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';

/**
 * AWS AppConfig full chain integ. All resources are Cloud-Control-provisioned
 * (no SDK providers) and several have COMPOUND CC primary identifiers:
 *   - Environment            `<appId>|<envId>`
 *   - ConfigurationProfile   `<appId>|<profileId>`
 *   - HostedConfigurationVersion `<appId>|<profileId>|<versionNumber>` (3-segment)
 *   - Deployment             `<appId>|<envId>|<deploymentNumber>` (3-segment)
 *
 * CFn `Ref` of each returns only the trailing id, but cdkd records the compound
 * physical id. Regression for the bug where `Ref` of a ConfigurationProfile
 * returned the compound `<appId>|<profileId>` into the HostedConfigurationVersion's
 * `ConfigurationProfileId`, so the Version CREATE failed with "Configuration
 * Profile ... could not be found". The Version + Deployment also exercise the
 * 3-segment (after-LAST-pipe) extraction.
 *
 * UPDATE: bump the hosted config version content (new HostedConfigurationVersion
 * + Deployment referencing it).
 *
 * covers: AWS::AppConfig::Application
 * covers: AWS::AppConfig::Environment
 * covers: AWS::AppConfig::ConfigurationProfile
 * covers: AWS::AppConfig::DeploymentStrategy
 * covers: AWS::AppConfig::HostedConfigurationVersion
 * covers: AWS::AppConfig::Deployment
 */
export class AppConfigStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const updating = process.env.CDKD_TEST_UPDATE === 'true';

    const app = new appconfig.CfnApplication(this, 'App', { name: `${id}-app` });

    const environment = new appconfig.CfnEnvironment(this, 'Env', {
      applicationId: app.ref,
      name: `${id}-env`,
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
      content: JSON.stringify({ feature: updating ? 'v2' : 'v1', enabled: true }),
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
    new cdk.CfnOutput(this, 'VersionNumber', { value: version.ref });
  }
}
