import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * AWS AppConfig full chain integ. Every type except Environment is
 * Cloud-Control-provisioned (Environment has an SDK provider, #5875) and several
 * have COMPOUND primary identifiers:
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
 * TYPE CHANGE (CDKD_TEST_PROFILE_TYPE_CHANGE=true, go-to-k/cdkd#7083): a second
 * profile flips `Type` from AWS.Freeform to AWS.AppConfig.FeatureFlags, which
 * AppConfig refuses in place ("This Type change is not supported"), so cdkd
 * must REPLACE it. Its `Name` moves with the type: AppConfig names are unique
 * per application and a replacement creates first, so a kept name collides
 * (CloudFormation fails the same way). An SSM parameter holding its `Ref` is
 * the reader that must follow the new id.
 *
 * covers: AWS::AppConfig::Application
 * covers: AWS::AppConfig::Environment
 * covers: AWS::AppConfig::ConfigurationProfile
 * covers: AWS::AppConfig::Deployment
 * covers: AWS::SSM::ParameterStrategy
 * covers: AWS::AppConfig::HostedConfigurationVersion
 * covers: AWS::AppConfig::Deployment
 * covers: AWS::SSM::Parameter
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

    const flagsType = process.env.CDKD_TEST_PROFILE_TYPE_CHANGE === 'true';
    const flagsProfile = new appconfig.CfnConfigurationProfile(this, 'FlagsProfile', {
      applicationId: app.ref,
      name: `${id}-flags-${flagsType ? 'ff' : 'free'}`,
      locationUri: 'hosted',
      type: flagsType ? 'AWS.AppConfig.FeatureFlags' : 'AWS.Freeform',
    });
    new ssm.CfnParameter(this, 'FlagsProfileIdParam', {
      name: `/${id}/flags-profile-id`,
      type: 'String',
      value: flagsProfile.ref,
    });

    new cdk.CfnOutput(this, 'AppId', { value: app.ref });
    new cdk.CfnOutput(this, 'EnvId', { value: environment.ref });
    new cdk.CfnOutput(this, 'ProfileId', { value: profile.ref });
    new cdk.CfnOutput(this, 'VersionNumber', { value: version.ref });
  }
}
