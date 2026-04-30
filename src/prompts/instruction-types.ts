export type NoPromptParams = Record<never, never>;

export type PromptFragmentDefinition<Params extends object = NoPromptParams> = {
  render?: (content: string, params: Params) => string;
};

export type PromptTemplateDefinition<Params extends object = NoPromptParams> = {
  render: (params: Params) => string;
};

export type FragmentRegistry = Record<string, PromptFragmentDefinition<any>>;
export type TemplateRegistry = Record<string, PromptTemplateDefinition<any>>;

export type FragmentFile<Registry extends FragmentRegistry> = keyof Registry & string;
export type TemplateId<Registry extends TemplateRegistry> = keyof Registry & string;

export type FragmentParams<
  Registry extends FragmentRegistry,
  K extends FragmentFile<Registry>
> = Registry[K] extends PromptFragmentDefinition<infer Params> ? Params : never;

export type TemplateParams<
  Registry extends TemplateRegistry,
  K extends TemplateId<Registry>
> = Registry[K] extends PromptTemplateDefinition<infer Params> ? Params : never;

export type ParamlessFragmentFile<Registry extends FragmentRegistry> = {
  [K in FragmentFile<Registry>]: keyof FragmentParams<Registry, K> extends never ? K : never;
}[FragmentFile<Registry>];