import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type ModelInfo,
} from "@github/copilot-sdk";

export interface AvailableModel {
  readonly id: string;
  readonly name: string;
  readonly supportedReasoningEfforts: readonly string[];
  readonly defaultReasoningEffort: string | null;
  readonly supportsVision: boolean;
}

export interface ModelCatalogClient {
  start(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  stop(): Promise<Error[]>;
}

export type ModelCatalogClientFactory = (
  options: CopilotClientOptions,
) => ModelCatalogClient;

export interface DiscoverAvailableModelsInput {
  readonly authToken?: string | null | undefined;
  readonly cliPath?: string | undefined;
  readonly logLevel?: CopilotClientOptions["logLevel"] | undefined;
}

export async function discoverAvailableModels(
  input: DiscoverAvailableModelsInput,
  createClient: ModelCatalogClientFactory = (options) =>
    new CopilotClient(options),
): Promise<AvailableModel[]> {
  const client = createClient({
    ...(input.authToken ? { gitHubToken: input.authToken } : {}),
    ...(input.cliPath
      ? { connection: RuntimeConnection.forStdio({ path: input.cliPath }) }
      : {}),
    ...(input.logLevel ? { logLevel: input.logLevel } : {}),
  });

  let models: ModelInfo[] = [];
  let operationError: Error | undefined;
  try {
    await client.start();
    models = await client.listModels();
  } catch (error: unknown) {
    operationError = asError(error);
  }

  let cleanupError: Error | undefined;
  try {
    const stopErrors = await client.stop();
    if (stopErrors.length > 0) {
      cleanupError = new AggregateError(
        stopErrors,
        "Copilot model catalog client did not stop cleanly",
      );
    }
  } catch (error: unknown) {
    cleanupError = asError(error);
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }

  return models.map(summarizeModel).toSorted(compareModelsById);
}

function compareModelsById(
  left: AvailableModel,
  right: AvailableModel,
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function summarizeModel(model: ModelInfo): AvailableModel {
  return {
    id: model.id,
    name: model.name,
    supportedReasoningEfforts: [...(model.supportedReasoningEfforts ?? [])],
    defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    supportsVision: model.capabilities.supports.vision,
  };
}
