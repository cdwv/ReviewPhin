import type { Logger } from "pino";

import { generateCtdFromFieldsDescriptor } from "../flotiq-ctd-builder.js";
import {
  createCtd,
  ctdNeedsUpdate,
  fetchExistingCtd,
  updateCtd,
} from "./migration-helpers.js";

export const V004_CTDS = [
  generateCtdFromFieldsDescriptor("project_memory", "Code Review/Memory", {
    tenantId: {
      type: "datasource",
      label: "Tenant ID",
      required: true,
      unique: true,
      relationContentType: "tenant",
      readonly: true,
      helpText: "Tenant that owns this project memory record.",
    },
    entriesJson: {
      type: "string",
      label: "Entries JSON",
      required: true,
      inputType: "textarea",
      helpText: "Serialized project memory entries.",
    },
  }),
] as const;

export default async function ensureV004CtdsExist(
  apiKey: string,
  logger?: Logger,
): Promise<void> {
  if (!apiKey) {
    throw new Error(
      "FLOTIQ_API_KEY is not set. Cannot ensure CTDs exist without API key.",
    );
  }

  for (const ctd of V004_CTDS) {
    logger?.info({ ctdName: ctd.name }, "Ensuring Flotiq CTD exists.");
    const existingCtd = await fetchExistingCtd(ctd.name, apiKey, logger);

    if (!existingCtd) {
      await createCtd(ctd, apiKey, logger);
      continue;
    }

    if (!ctdNeedsUpdate(existingCtd, ctd)) {
      logger?.info({ ctdName: ctd.name }, "Flotiq CTD already exists.");
      continue;
    }

    await updateCtd(ctd.name, ctd, apiKey, logger);
    logger?.info({ ctdName: ctd.name }, "Flotiq v004 CTD updated.");
  }
}
