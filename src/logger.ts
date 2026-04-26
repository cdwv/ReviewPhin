import pino, { type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        "*.apiToken",
        "*.webhookSecret",
        "apiToken",
        "webhookSecret",
        "headers.authorization",
        "headers.private-token"
      ],
      censor: "[redacted]"
    }
  });
}
