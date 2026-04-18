import { KMSClient, ListAliasesCommand } from '@aws-sdk/client-kms';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * KMS Key context provider
 *
 * Looks up KMS key by alias name.
 * CDK provider type: "key-provider"
 */
export class KeyContextProvider implements ContextProvider {
  private logger = getLogger().child('KeyContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const aliasName = props['aliasName'] as string;

    if (!aliasName) {
      throw new Error('Key context provider requires aliasName property');
    }

    this.logger.debug(`Looking up KMS key by alias: ${aliasName} (region: ${region})`);

    const client = new KMSClient({
      ...(region && { region }),
    });

    try {
      // Normalize alias name
      const normalizedAlias = aliasName.startsWith('alias/') ? aliasName : `alias/${aliasName}`;

      let nextMarker: string | undefined;
      do {
        const response = await client.send(
          new ListAliasesCommand({
            ...(nextMarker && { Marker: nextMarker }),
          })
        );

        const match = (response.Aliases ?? []).find((a) => a.AliasName === normalizedAlias);
        if (match) {
          if (!match.TargetKeyId) {
            throw new Error(`KMS alias '${aliasName}' found but has no target key`);
          }
          this.logger.debug(`Resolved KMS key: ${match.TargetKeyId} (alias: ${aliasName})`);
          return { keyId: match.TargetKeyId };
        }

        nextMarker = response.NextMarker;
      } while (nextMarker);

      throw new Error(`No KMS key found with alias: ${aliasName}`);
    } finally {
      client.destroy();
    }
  }
}
