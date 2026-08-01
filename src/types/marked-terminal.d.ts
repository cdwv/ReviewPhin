declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export interface MarkedTerminalOptions {
    readonly width?: number;
    readonly reflowText?: boolean;
    readonly showSectionPrefix?: boolean;
    readonly emoji?: boolean;
    readonly code?: (value: string) => string;
    readonly blockquote?: (value: string) => string;
    readonly html?: (value: string) => string;
    readonly heading?: (value: string) => string;
    readonly firstHeading?: (value: string) => string;
    readonly hr?: (value: string) => string;
    readonly listitem?: (value: string) => string;
    readonly table?: (value: string) => string;
    readonly paragraph?: (value: string) => string;
    readonly strong?: (value: string) => string;
    readonly em?: (value: string) => string;
    readonly codespan?: (value: string) => string;
    readonly del?: (value: string) => string;
    readonly link?: (value: string) => string;
    readonly href?: (value: string) => string;
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
