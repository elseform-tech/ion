/** Any ion-data marker, opening or closing, whatever its case. */
const MARKER = /<(\/?)(ion-data)/gi;

/**
 * Text from history or memory, labelled as data for an agent: the markers can't be faked from inside
 * (each `<ion-data` / `</ion-data` in the text loses its angle bracket).
 */
export function wrapData(source: string, body: string): string {
  const safe = body.replace(MARKER, "‹$1$2");
  return `<ion-data source="${source.replaceAll('"', "'")}">\n${safe}\n</ion-data>`;
}
