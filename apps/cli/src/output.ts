export const NOT_RUNNING = "ion isn't running. Start it with: ion daemon start";

export type Out = { json: boolean };

export function print(o: Out, human: string, data: unknown): void {
  console.log(o.json ? JSON.stringify(data) : human);
}

export function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}
