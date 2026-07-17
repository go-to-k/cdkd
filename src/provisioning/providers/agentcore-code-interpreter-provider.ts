/**
 * SDK Provider for AWS::BedrockAgentCore::CodeInterpreter (adopt-only
 * singleton).
 *
 * The CloudFormation registry schema declares this type as a READ-ONLY
 * resource "representing the AWS-managed default code interpreter
 * (aws.codeinterpreter.v1)": every schema property (`CodeInterpreterArn` /
 * `CodeInterpreterId` / `Status`) is read-only, the only handlers are
 * read/list, and the `CodeInterpreterId` pattern is hard-locked to
 * `^aws\.codeinterpreter\.v1$`. The registry marks it `NON_PROVISIONABLE`,
 * so Cloud Control cannot deploy it and cdkd's pre-flight used to reject it
 * (issue #1039).
 *
 * cdkd therefore provisions it as an ADOPT operation, not a create — see
 * `agentcore-browser-provider.ts` (the exactly-parallel sibling) for the
 * full rationale. Custom, user-created code interpreters are a DIFFERENT
 * CFn type (`AWS::BedrockAgentCore::CodeInterpreterCustom`, FULLY_MUTABLE)
 * which Cloud Control handles.
 */
import {
  BedrockAgentCoreControlClient,
  GetCodeInterpreterCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/** The only valid code interpreter id for this type per the CFn schema pattern. */
export const DEFAULT_CODE_INTERPRETER_ID = 'aws.codeinterpreter.v1';

/**
 * AWS BedrockAgentCore default-CodeInterpreter Provider (adopt-only).
 */
export class AgentCoreCodeInterpreterProvider implements ResourceProvider {
  private client: BedrockAgentCoreControlClient;
  private logger = getLogger().child('AgentCoreCodeInterpreterProvider');

  // Every CFn schema property on this type is read-only (AWS-managed), so
  // there is nothing to wire into create/update. The explicit empty array
  // literal (not a bare `new Set()`) keeps the declaration parseable by
  // scripts/gen-property-coverage.ts.
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::BedrockAgentCore::CodeInterpreter', new Set<string>([])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.client = awsClients.bedrockAgentCoreControl;
  }

  /**
   * "Create" = adopt the AWS-managed default code interpreter: verify it
   * exists in the deploy region and record its ARN (the CFn
   * primaryIdentifier) as the physical id. Nothing is created in AWS.
   */
  async create(
    logicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Adopting AWS-managed default code interpreter for ${logicalId}`);

    try {
      const response = await this.client.send(
        new GetCodeInterpreterCommand({ codeInterpreterId: DEFAULT_CODE_INTERPRETER_ID })
      );

      const codeInterpreterArn = response.codeInterpreterArn!;
      this.logger.debug(
        `Adopted default code interpreter ${DEFAULT_CODE_INTERPRETER_ID} (${codeInterpreterArn})`
      );

      return {
        physicalId: codeInterpreterArn,
        attributes: {
          CodeInterpreterArn: codeInterpreterArn,
          CodeInterpreterId: response.codeInterpreterId ?? DEFAULT_CODE_INTERPRETER_ID,
          Status: response.status ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to adopt the AWS-managed default code interpreter for ${logicalId}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Bedrock AgentCore may not be available in this region.`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Every property on this type is read-only, so there is nothing to
   * update — keep the existing physical id.
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`No-op update for default code interpreter ${logicalId}`);
    return { physicalId, wasReplaced: false, attributes: {} };
  }

  /**
   * The default code interpreter is AWS-owned; destroying a stack must
   * never delete it. Pure no-op.
   */
  async delete(logicalId: string, _physicalId: string, _resourceType: string): Promise<void> {
    this.logger.debug(`No-op delete for AWS-managed default code interpreter ${logicalId}`);
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution). The CFn read-only
   * attribute set is CodeInterpreterArn / CodeInterpreterId / Status.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'CodeInterpreterArn') {
      return physicalId;
    }
    if (attributeName === 'CodeInterpreterId') {
      return DEFAULT_CODE_INTERPRETER_ID;
    }
    if (attributeName === 'Status') {
      const response = await this.client.send(
        new GetCodeInterpreterCommand({ codeInterpreterId: DEFAULT_CODE_INTERPRETER_ID })
      );
      return response.status;
    }

    throw new Error(
      `Unsupported attribute: ${attributeName} for AWS::BedrockAgentCore::CodeInterpreter`
    );
  }

  /** No managed properties → nothing can drift. */
  async readCurrentState(): Promise<Record<string, unknown>> {
    return {};
  }

  /**
   * Import: the type is a singleton pointing at the AWS-managed default
   * code interpreter, so auto-lookup is trivial — resolve it live via
   * `GetCodeInterpreter` (no `--resource` override needed; a supplied
   * override is ignored in favor of the live ARN, which is the only valid
   * physical id).
   */
  async import(_input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const response = await this.client.send(
      new GetCodeInterpreterCommand({ codeInterpreterId: DEFAULT_CODE_INTERPRETER_ID })
    );
    return {
      physicalId: response.codeInterpreterArn!,
      attributes: {
        CodeInterpreterArn: response.codeInterpreterArn!,
        CodeInterpreterId: response.codeInterpreterId ?? DEFAULT_CODE_INTERPRETER_ID,
        Status: response.status ?? '',
      },
    };
  }
}
