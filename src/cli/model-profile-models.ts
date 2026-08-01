import type { AppConfig } from "../config.js";
import {
  discoverAvailableModels,
  type AvailableModel,
  type ModelCatalogClientFactory,
} from "../review/model-catalog.js";
import type { ModelProfileRecord } from "../storage/contract/index.js";
import type { ResolvedModelProfileUpsertInput } from "../storage/model-profile-upsert.js";
import { CliError, type CliOutput, formatTable } from "./output.js";

export interface ModelValidationResult {
  readonly status:
    "validated" | "not_required" | "ignored_missing" | "ignored_unavailable";
  readonly checkedModels: readonly string[];
  readonly missingModels: readonly string[];
}

interface ModelCatalogDependencies {
  readonly output: CliOutput;
  readonly clientFactory?: ModelCatalogClientFactory | undefined;
}

export async function listAvailableModels(
  profile: ModelProfileRecord | null,
  config: AppConfig,
  dependencies: ModelCatalogDependencies,
): Promise<number> {
  if (profile?.providerBaseUrl) {
    throw new CliError(
      "model_catalog_unavailable",
      `Model discovery is unavailable for custom-provider profile "${profile.name}".`,
      { profileName: profile.name },
    );
  }

  let models: AvailableModel[];
  try {
    models = await discoverAvailableModels(
      catalogInput(config, profile?.authToken),
      dependencies.clientFactory,
    );
  } catch {
    throw new CliError(
      "model_catalog_unavailable",
      "The GitHub Copilot model catalog could not be loaded with the selected credentials.",
      profile ? { profileName: profile.name } : undefined,
    );
  }

  dependencies.output.result(
    { source: "github-copilot", models },
    {
      pretty: formatAvailableModelsTable(models, dependencies.output),
      plain: models.map(formatAvailableModelPlain).join("\n"),
    },
  );
  return 0;
}

export async function validateProfileModels(
  profile: ResolvedModelProfileUpsertInput,
  ignoreMissingModel: boolean,
  config: AppConfig,
  dependencies: ModelCatalogDependencies,
): Promise<ModelValidationResult> {
  const checkedModels = [profile.reviewModel, profile.textGenerationModel]
    .filter((model): model is string => model !== null)
    .filter((model, index, models) => models.indexOf(model) === index)
    .toSorted(compareStrings);

  if (checkedModels.length === 0) {
    return {
      status: "not_required",
      checkedModels,
      missingModels: [],
    };
  }

  if (profile.providerBaseUrl) {
    return handleUnavailableModelValidation(
      profile.name,
      checkedModels,
      ignoreMissingModel,
      dependencies.output,
    );
  }

  let availableModels: AvailableModel[];
  try {
    availableModels = await discoverAvailableModels(
      catalogInput(config, profile.authToken),
      dependencies.clientFactory,
    );
  } catch {
    return handleUnavailableModelValidation(
      profile.name,
      checkedModels,
      ignoreMissingModel,
      dependencies.output,
    );
  }

  const availableIds = new Set(availableModels.map((model) => model.id));
  const missingModels = checkedModels.filter(
    (model) => !availableIds.has(model),
  );
  if (missingModels.length === 0) {
    return { status: "validated", checkedModels, missingModels };
  }

  if (!ignoreMissingModel) {
    throw new CliError(
      "model_not_found",
      `Model profile "${profile.name}" uses models that were not found: ${missingModels.join(", ")}.`,
      { profileName: profile.name, missingModels },
    );
  }

  for (const model of missingModels) {
    dependencies.output.diagnostic(
      "warning",
      `Model "${model}" was not found, but --ignore-missing-model was provided, so this result was ignored.`,
    );
  }
  return { status: "ignored_missing", checkedModels, missingModels };
}

function handleUnavailableModelValidation(
  profileName: string,
  checkedModels: readonly string[],
  ignoreMissingModel: boolean,
  output: CliOutput,
): ModelValidationResult {
  if (!ignoreMissingModel) {
    throw new CliError(
      "model_validation_unavailable",
      `Model availability could not be verified for profile "${profileName}".`,
      { profileName },
    );
  }

  for (const model of checkedModels) {
    output.diagnostic(
      "warning",
      `Model "${model}" availability could not be verified, but --ignore-missing-model was provided, so this result was ignored.`,
    );
  }
  return {
    status: "ignored_unavailable",
    checkedModels,
    missingModels: [],
  };
}

function catalogInput(config: AppConfig, authToken: string | null | undefined) {
  return {
    authToken,
    cliPath: config.copilotCliPath,
    logLevel: config.copilotSdkLogLevel,
  };
}

function formatAvailableModelsTable(
  models: readonly AvailableModel[],
  output: CliOutput,
): string {
  return formatTable(
    models,
    [
      { header: "Model", value: (model) => model.id },
      { header: "Name", value: (model) => model.name },
      {
        header: "Reasoning",
        value: (model) => model.supportedReasoningEfforts.join(", ") || null,
      },
      {
        header: "Default effort",
        value: (model) => model.defaultReasoningEffort,
      },
      { header: "Vision", value: (model) => model.supportsVision },
    ],
    output.columns,
    {
      header: (value) => output.style("strong", value),
      separator: (value) => output.style("muted", value),
    },
  );
}

function formatAvailableModelPlain(model: AvailableModel): string {
  return [
    model.id,
    model.name,
    model.supportedReasoningEfforts.join(","),
    model.defaultReasoningEffort ?? "",
    String(model.supportsVision),
  ].join("\t");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
