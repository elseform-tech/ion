import { randomBytes } from "node:crypto";

/** ion-data markers, opening or closing, in any spelling a model might read as one (spaces, _, -, case). */
const MARKER = /<(?=[\s/]*ion[\s_‐-―-]*data)/gi;

/**
 * Text from history or memory, labelled as data for an agent. The block opens and closes with a fresh random id,
 * so the text can't end it early, and any marker look-alike inside loses its angle bracket.
 */
export function wrapData(source: string, body: string): string {
  const id = randomBytes(8).toString("hex");
  const safe = body.replace(MARKER, "‹");
  return `<ion-data id="${id}" source="${source.replaceAll('"', "'")}">\n${safe}\n</ion-data id="${id}">`;
}
