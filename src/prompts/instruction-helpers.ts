import { loadPromptContent } from "./prompt-loader.js";
import type {
  FragmentFile,
  FragmentParams,
  FragmentRegistry,
  NoPromptParams,
  ParamlessFragmentFile,
  PromptFragmentDefinition,
  PromptTemplateDefinition,
  TemplateId,
  TemplateParams,
  TemplateRegistry
} from "./instruction-types.js";

const NO_PROMPT_PARAMS: NoPromptParams = {};

export function definePromptFragment<Params extends object = NoPromptParams>(
  definition: PromptFragmentDefinition<Params> = {}
): PromptFragmentDefinition<Params> {
  return definition;
}

export function definePromptTemplate<Params extends object = NoPromptParams>(
  render: (params: Params) => string
): PromptTemplateDefinition<Params> {
  return { render };
}

export function buildStaticPromptTemplate<
  Registry extends FragmentRegistry,
  const Files extends readonly ParamlessFragmentFile<Registry>[]
>(
  fragments: Registry,
  files: Files
): PromptTemplateDefinition {
  return definePromptTemplate(() => renderPromptSections(fragments, files).join("\n\n"));
}

export function renderPromptFragment<
  Registry extends FragmentRegistry,
  K extends FragmentFile<Registry>
>(
  fragments: Registry,
  file: K,
  params: FragmentParams<Registry, K>
): string {
  const definition = fragments[file] as PromptFragmentDefinition<FragmentParams<Registry, K>>;
  const content = loadPromptContent(file);
  return definition.render ? definition.render(content, params) : content;
}

export function renderRegisteredPrompt<
  Registry extends TemplateRegistry,
  K extends TemplateId<Registry>
>(
  templates: Registry,
  id: K,
  params: TemplateParams<Registry, K>
): string {
  const definition = templates[id] as PromptTemplateDefinition<TemplateParams<Registry, K>>;
  return definition.render(params);
}

function renderPromptSections<
  Registry extends FragmentRegistry,
  const Files extends readonly ParamlessFragmentFile<Registry>[]
>(
  fragments: Registry,
  files: Files
): string[] {
  return files.map((file) => renderStaticPromptFragment(fragments, file));
}

function renderStaticPromptFragment<
  Registry extends FragmentRegistry,
  K extends ParamlessFragmentFile<Registry>
>(
  fragments: Registry,
  file: K
): string {
  return renderPromptFragment(fragments, file, NO_PROMPT_PARAMS as FragmentParams<Registry, K>);
}