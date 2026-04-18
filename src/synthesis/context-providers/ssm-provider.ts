import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * SSM Parameter context provider
 *
 * Reads SSM parameter values.
 * CDK provider type: "ssm"
 */
export class SSMContextProvider implements ContextProvider {
  private logger = getLogger().child('SSMContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const parameterName = props['parameterName'] as string;

    if (!parameterName) {
      throw new Error('SSM context provider requires parameterName property');
    }

    this.logger.debug(`Reading SSM parameter: ${parameterName} (region: ${region})`);

    const client = new SSMClient({
      ...(region && { region }),
    });

    try {
      const response = await client.send(new GetParameterCommand({ Name: parameterName }));

      if (!response.Parameter || response.Parameter.Value === undefined) {
        // Check if we should suppress this error
        const suppressError = props['ignoreErrorOnMissingContext'] === true;
        if (suppressError && 'dummyValue' in props) {
          this.logger.debug(`SSM parameter not found, returning dummy value`);
          return props['dummyValue'];
        }
        throw new Error(`SSM parameter not found: ${parameterName}`);
      }

      this.logger.debug(`SSM parameter resolved: ${parameterName}`);
      return response.Parameter.Value;
    } finally {
      client.destroy();
    }
  }
}
