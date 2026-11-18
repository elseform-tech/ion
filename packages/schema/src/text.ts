/**
 * Control characters (Unicode Cc, except newline and tab) and invisible formatters (Cf: direction marks and
 * overrides, zero-width characters, soft hyphens, the BOM...). An agent's text shown anywhere (the CLI, the
 * sidebar) must not drive a terminal or hide or reorder what's shown. The one definition for the CLI and the daemon.
 */
const CONTROL = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;

export const stripControl = (s: string): string => s.replace(CONTROL, "");
