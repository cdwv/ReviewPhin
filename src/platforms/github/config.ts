import { z } from "zod";

export const githubConnectionRegistrationSchema = z.object({
  owner: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, {
      message: "owner must be a valid GitHub account or organization login",
    }),
  apiUrl: z
    .string()
    .url()
    .default("https://api.github.com")
    .transform((value) => value.replace(/\/+$/, ""))
    .refine((value) => value === "https://api.github.com", {
      message:
        "GitHub Enterprise Server is not supported yet; apiUrl must be https://api.github.com",
    }),
});

export const previousGitHubAppCleanupSchema = z.object({
  appName: z.string().min(1),
  appSlug: z.string().min(1),
  ownerLogin: z.string().min(1),
  installationId: z.number().int().positive().optional(),
});

export const pendingGitHubConnectionConfigSchema =
  githubConnectionRegistrationSchema.extend({
    setupToken: z.string().min(32),
    setupTokenExpiresAt: z.string().datetime(),
    previousAppCleanup: previousGitHubAppCleanupSchema.optional(),
  });

const registeredGitHubAppFields = {
  appId: z.number().int().positive(),
  appSlug: z.string().min(1),
  appName: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  webhookSecret: z.string().min(1),
  privateKey: z.string().min(1),
  ownerLogin: z.string().min(1),
  ownerId: z.number().int().positive(),
  ownerType: z.string().min(1),
  ownerAvatarUrl: z.string().url().optional(),
  ownerHtmlUrl: z.string().url().optional(),
  appHtmlUrl: z.string().url().optional(),
  permissions: z.record(z.string()),
  events: z.array(z.string()),
};

export const registeredGitHubConnectionConfigSchema =
  pendingGitHubConnectionConfigSchema.extend({
    ...registeredGitHubAppFields,
    setupPhase: z.literal("app_registered"),
  });

export const readyGitHubConnectionConfigSchema =
  githubConnectionRegistrationSchema.extend({
    ...registeredGitHubAppFields,
    previousAppCleanup: previousGitHubAppCleanupSchema.optional(),
    installationId: z.number().int().positive(),
    installationAccountLogin: z.string().min(1),
    installationAccountId: z.number().int().positive(),
    installationAccountType: z.string().min(1),
    repositorySelection: z.enum(["all", "selected"]),
    accessibleRepositoryCount: z.number().int().nonnegative(),
    installationCreatedAt: z.string().datetime().optional(),
    installationUpdatedAt: z.string().datetime().optional(),
    installationSuspendedAt: z.string().datetime().nullable().optional(),
  });

export type RegisteredGitHubConnectionConfig = z.infer<
  typeof registeredGitHubConnectionConfigSchema
>;

export const githubConnectionConfigWithSetupTokenSchema = z.union([
  registeredGitHubConnectionConfigSchema,
  pendingGitHubConnectionConfigSchema,
]);

export type PendingGitHubConnectionConfig = z.infer<
  typeof pendingGitHubConnectionConfigSchema
>;
export type ReadyGitHubConnectionConfig = z.infer<
  typeof readyGitHubConnectionConfigSchema
>;
