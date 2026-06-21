import type { Logger } from "pino";
import type { CtdDefinition } from "../flotiq-ctd-builder.js";

export async function fetchExistingCtd(
  name: string,
  apiKey: string,
  logger?: Logger,
): Promise<(CtdDefinition & { id: string }) | null> {
  const response = await fetch(
    `https://api.flotiq.com/api/v1/internal/contenttype/${name}`,
    {
      method: "GET",
      headers: createFlotiqHeaders(apiKey),
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    await throwRequestError(`fetch CTD for ${name}`, response, logger);
  }

  return (await response.json()) as CtdDefinition & { id: string };
}

export function ctdNeedsUpdate(
  existingCtd: CtdDefinition & { id: string },
  desiredCtd: CtdDefinition,
): boolean {
  return (
    JSON.stringify(existingCtd.schemaDefinition) !==
      JSON.stringify(desiredCtd.schemaDefinition) ||
    JSON.stringify(existingCtd.metaDefinition) !==
      JSON.stringify(desiredCtd.metaDefinition) ||
    existingCtd.label !== desiredCtd.label ||
    existingCtd.name !== desiredCtd.name
  );
}

export async function updateCtd(
  name: string,
  ctd: CtdDefinition,
  apiKey: string,
  logger?: Logger,
): Promise<void> {
  const response = await fetch(
    `https://api.flotiq.com/api/v1/internal/contenttype/${name}`,
    {
      method: "PUT",
      headers: createFlotiqHeaders(apiKey),
      body: JSON.stringify(ctd),
    },
  );

  if (response.status === 200) {
    logger?.info({ ctdName: ctd.name }, "Flotiq CTD updated.");
    return;
  }

  await throwRequestError(`update CTD for ${ctd.name}`, response, logger);
}

export async function createCtd(
  ctd: CtdDefinition,
  apiKey: string,
  logger?: Logger,
): Promise<void> {
  logger?.info({ ctdName: ctd.name }, "Creating Flotiq CTD.");
  const response = await fetch(
    "https://api.flotiq.com/api/v1/internal/contenttype",
    {
      method: "POST",
      headers: createFlotiqHeaders(apiKey),
      body: JSON.stringify(ctd),
    },
  );

  if (response.ok) {
    logger?.info({ ctdName: ctd.name }, "Flotiq CTD created.");
    return;
  }

  await throwRequestError(`create CTD for ${ctd.name}`, response, logger);
}

export function createFlotiqHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-AUTH-TOKEN": apiKey,
  };
}

export async function throwRequestError(
  action: string,
  response: Response,
  logger?: Logger,
): Promise<never> {
  const responseBody = await response.text();
  logger?.error(
    { action, status: response.status, responseBody },
    "Flotiq request failed.",
  );
  throw new Error(
    `Failed to ${action}. HTTP ${response.status}: ${responseBody}`,
  );
}
