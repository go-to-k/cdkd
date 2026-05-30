import {
  LambdaClient,
  AddPermissionCommand,
  GetPolicyCommand,
  RemovePermissionCommand,
  ResourceNotFoundException,
  type FunctionUrlAuthType,
} from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS Lambda Permission Provider
 *
 * Implements resource provisioning for AWS::Lambda::Permission using the Lambda SDK.
 * WHY: AddPermission is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LambdaPermissionProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private logger = getLogger().child('LambdaPermissionProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::Permission',
      new Set([
        'FunctionName',
        'Action',
        'Principal',
        'SourceArn',
        'SourceAccount',
        'PrincipalOrgID',
        'EventSourceToken',
        'FunctionUrlAuthType',
        'InvokedViaFunctionUrl',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * Create a Lambda permission
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Lambda permission ${logicalId}`);

    const functionName = properties['FunctionName'] as string;
    if (!functionName) {
      throw new ProvisioningError(
        `FunctionName is required for Lambda permission ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const action = properties['Action'] as string;
    if (!action) {
      throw new ProvisioningError(
        `Action is required for Lambda permission ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const principal = properties['Principal'] as string;
    if (!principal) {
      throw new ProvisioningError(
        `Principal is required for Lambda permission ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Generate a unique StatementId from the logicalId (max 100 chars)
    let statementId = logicalId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (statementId.length > 100) {
      // Simple hash: sum char codes and convert to hex
      let hashNum = 0;
      for (let i = 0; i < logicalId.length; i++) {
        hashNum = ((hashNum << 5) - hashNum + logicalId.charCodeAt(i)) | 0;
      }
      const hash = Math.abs(hashNum).toString(16).padStart(8, '0').substring(0, 8);
      statementId = `${statementId.substring(0, 91)}-${hash}`;
    }

    try {
      const addParams: import('@aws-sdk/client-lambda').AddPermissionCommandInput = {
        FunctionName: functionName,
        StatementId: statementId,
        Action: action,
        Principal: principal,
      };
      if (properties['SourceArn']) addParams.SourceArn = properties['SourceArn'] as string;
      if (properties['SourceAccount'])
        addParams.SourceAccount = properties['SourceAccount'] as string;
      if (properties['PrincipalOrgID'])
        addParams.PrincipalOrgID = properties['PrincipalOrgID'] as string;
      if (properties['EventSourceToken'])
        addParams.EventSourceToken = properties['EventSourceToken'] as string;
      if (properties['FunctionUrlAuthType'])
        addParams.FunctionUrlAuthType = properties['FunctionUrlAuthType'] as FunctionUrlAuthType;
      if (properties['InvokedViaFunctionUrl'] !== undefined)
        addParams.InvokedViaFunctionUrl = properties['InvokedViaFunctionUrl'] as boolean;

      await this.lambdaClient.send(new AddPermissionCommand(addParams));

      this.logger.debug(`Successfully created Lambda permission ${logicalId}: ${statementId}`);

      return {
        physicalId: statementId,
        attributes: {
          Id: statementId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Lambda permission ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        statementId,
        cause
      );
    }
  }

  /**
   * Update a Lambda permission
   *
   * Lambda permissions cannot be updated in-place. Remove old and add new.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Lambda permission ${logicalId}: ${physicalId}`);

    try {
      // Remove old permission
      const oldFunctionName =
        (previousProperties['FunctionName'] as string) || (properties['FunctionName'] as string);

      // physicalId may be in "functionArn|statementId" format (from CC API)
      const oldStatementId = physicalId.includes('|') ? physicalId.split('|').pop()! : physicalId;

      try {
        await this.lambdaClient.send(
          new RemovePermissionCommand({
            FunctionName: oldFunctionName,
            StatementId: oldStatementId,
          })
        );
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) {
          throw error;
        }
        this.logger.debug(`Old permission ${oldStatementId} not found, continuing with add`);
      }

      // Add new permission
      const createResult = await this.create(logicalId, resourceType, properties);

      return {
        physicalId: createResult.physicalId,
        wasReplaced: false,
        attributes: createResult.attributes ?? {},
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Lambda permission ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Lambda permission
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Lambda permission ${logicalId}: ${physicalId}`);

    const functionName = properties?.['FunctionName'] as string | undefined;
    if (!functionName) {
      this.logger.warn(
        `FunctionName not available for Lambda permission ${logicalId}, skipping deletion`
      );
      return;
    }

    // physicalId may be in "functionArn|statementId" format (from CC API)
    // Extract just the statementId part
    let statementId = physicalId;
    if (physicalId.includes('|')) {
      statementId = physicalId.split('|').pop()!;
    }

    try {
      await this.lambdaClient.send(
        new RemovePermissionCommand({
          FunctionName: functionName,
          StatementId: statementId,
        })
      );
      this.logger.debug(`Successfully deleted Lambda permission ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Lambda permission ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda permission ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current Lambda permission in CFn-property shape.
   *
   * `AWS::Lambda::Permission` has no per-statement Get API — `GetPolicy` on
   * the parent function returns the entire resource-based policy as a JSON
   * string, and we have to scan its `Statement` array for the one with our
   * `Sid` (cdkd's physicalId).
   *
   * Returns `undefined` when:
   *   - `properties.FunctionName` is missing (sub-resource needs the parent).
   *   - The function has no policy at all (`ResourceNotFoundException`) or
   *     the matching `Sid` isn't present.
   *
   * The reverse-mapping from policy statement back to CFn shape:
   *   - `Action` → `Sid`'s `Action` (string or first element if array).
   *   - `Principal` → `Service` / `AWS` / `*` (CFn flat string form).
   *   - `Condition.ArnLike.AWS:SourceArn` → `SourceArn`.
   *   - `Condition.StringEquals.AWS:SourceAccount` → `SourceAccount`.
   *   - `Condition.StringEquals.aws:PrincipalOrgID` → `PrincipalOrgID`.
   *   - `Condition.Bool.lambda:InvokedViaFunctionUrl == "true"` →
   *     `InvokedViaFunctionUrl: true` (AWS encodes the CFn boolean by
   *     injecting a `Bool` condition keyed on the `lambda:InvokedViaFunctionUrl`
   *     IAM context key; the value comes back as the IAM-canonical string
   *     `"true"`, not a JSON boolean — verified empirically against the live
   *     us-east-1 endpoint, 2026-05-29). Explicit `false` is a no-op at AWS:
   *     no Condition is injected and readback omits the key, which round-trips
   *     to "absent" matching CFn's default.
   *   - `Condition.ArnLike.AWS:SourceAccount` is left alone — drift on the
   *     condition operator key would be confusing here.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const functionName = properties?.['FunctionName'] as string | undefined;
    if (!functionName) return undefined;

    // physicalId may be in legacy "functionArn|statementId" format
    const statementId = physicalId.includes('|') ? physicalId.split('|').pop()! : physicalId;

    let policyDoc;
    try {
      const resp = await this.lambdaClient.send(
        new GetPolicyCommand({ FunctionName: functionName })
      );
      policyDoc = resp.Policy;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }

    if (!policyDoc) return undefined;

    interface PolicyStatement {
      Sid?: string;
      Action?: string | string[];
      Principal?: string | Record<string, string | string[]>;
      Condition?: Record<string, Record<string, string | string[]>>;
    }
    let parsed: { Statement?: PolicyStatement[] };
    try {
      parsed = JSON.parse(policyDoc) as { Statement?: PolicyStatement[] };
    } catch {
      return undefined;
    }

    const statement = parsed.Statement?.find((s) => s.Sid === statementId);
    if (!statement) return undefined;

    const result: Record<string, unknown> = { FunctionName: functionName };

    if (statement.Action !== undefined) {
      result['Action'] = Array.isArray(statement.Action) ? statement.Action[0] : statement.Action;
    }

    // Principal: CFn shape is a flat string ("lambda.amazonaws.com",
    // "123456789012", "*"). IAM normalizes it as { Service: "lambda.amazonaws.com" }
    // or { AWS: "..." } etc. — flatten for comparability.
    if (statement.Principal !== undefined) {
      const p = statement.Principal;
      if (typeof p === 'string') {
        result['Principal'] = p;
      } else if (typeof p === 'object') {
        const value = p['Service'] ?? p['AWS'] ?? p['Federated'] ?? undefined;
        if (value !== undefined) {
          result['Principal'] = Array.isArray(value) ? value[0] : value;
        }
      }
    }

    const condition = statement.Condition;
    if (condition) {
      const sourceArn =
        condition['ArnLike']?.['AWS:SourceArn'] ?? condition['StringEquals']?.['AWS:SourceArn'];
      if (sourceArn !== undefined) {
        result['SourceArn'] = Array.isArray(sourceArn) ? sourceArn[0] : sourceArn;
      }
      const sourceAccount = condition['StringEquals']?.['AWS:SourceAccount'];
      if (sourceAccount !== undefined) {
        result['SourceAccount'] = Array.isArray(sourceAccount) ? sourceAccount[0] : sourceAccount;
      }
      const orgId = condition['StringEquals']?.['aws:PrincipalOrgID'];
      if (orgId !== undefined) {
        result['PrincipalOrgID'] = Array.isArray(orgId) ? orgId[0] : orgId;
      }
      // AWS encodes `InvokedViaFunctionUrl: true` by injecting a
      // `Bool` condition keyed on `lambda:InvokedViaFunctionUrl` into the
      // statement (verified empirically against the live us-east-1 endpoint,
      // 2026-05-29). The value comes back as the string "true" / "false".
      const invokedViaUrl = condition['Bool']?.['lambda:InvokedViaFunctionUrl'];
      if (invokedViaUrl === 'true') {
        result['InvokedViaFunctionUrl'] = true;
      }
    }

    return result;
  }

  /**
   * Adopt an existing Lambda permission into cdkd state.
   *
   * **Explicit override only.** A `Lambda::Permission` is a single statement
   * within a function's resource-based policy added via `AddPermission`. It
   * has no independent ARN, no taggable identity, and the only way to find
   * it is to call `GetPolicy` on the parent function and parse the JSON
   * statements — which the user knows by `StatementId` already.
   *
   * Users adopting an existing permission should pass
   * `--resource <logicalId>=<statementId>` (matching the physical id
   * format returned by `create()`).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: { Id: input.knownPhysicalId } };
    }
    return null;
  }
}
