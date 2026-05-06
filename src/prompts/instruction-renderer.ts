import { renderRegisteredPrompt } from "./instruction-helpers.js";
import { instructionTemplates } from "./instruction-registry.js";
import type { TemplateId, TemplateParams } from "./instruction-types.js";

export type PromptTemplateId = TemplateId<typeof instructionTemplates>;
export type PromptTemplateParams<K extends PromptTemplateId> = TemplateParams<
  typeof instructionTemplates,
  K
>;

export function renderPrompt<K extends PromptTemplateId>(
  id: K,
  params: PromptTemplateParams<K>,
): string {
  return renderRegisteredPrompt(instructionTemplates, id, params);
}
