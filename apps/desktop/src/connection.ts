import type { IonClient } from "@ion/client/browser";

export type DaemonInfo = { port: number; token: string };
export type ConnState = "connecting" | "starting" | "down" | "up";

type Deps = {
  /** Where the daemon is now (it changes when ion restarts), or null when it isn't running. */
  info: () => Promise<DaemonInfo | null>;
  connect: (info: DaemonInfo) => Promise<IonClient>;
  retryMs?: number;
  /**
   * Starts ion when it isn't running (the app: Plan 21), once; false when it can't. Absent (a browser): never.
   */
  start?: () => Promise<boolean>;
  /** How long a start may take before the app says ion isn't running after all. */
  startMs?: number;
};

/**
 * The app's link to the daemon. While ion isn't running it's "down" and tries again every 2 s, re-reading where
 * the daemon is each time; when the connection closes (ion stopped or restarted) it goes down and starts again.
 */
export class IonConnection {
  state: ConnState = "connecting";
  client: IonClient | null = null;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** When ion was started from here (once), while it may still be starting. */
  private startedAt: number | null = null;
  private triedStart = false;

  constructor(private readonly d: Deps) {}

  /** ion isn't running: start it once, where the app can; "starting" until it's up or its time is out. */
  private notRunning(): ConnState {
    if (this.d.start && !this.triedStart) {
      this.triedStart = true;
      this.startedAt = Date.now();
      void this.d.start().then(
        (ok) => {
          if (!ok) this.startedAt = null;
        },
        () => {
          this.startedAt = null;
        },
      );
    }
    const going = this.startedAt !== null && Date.now() - this.startedAt < (this.d.startMs ?? 20_000);
    return going ? "starting" : "down";
  }

  start(): void {
    this.stopped = false;
    void this.attempt();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.client?.close();
  }

  /** For React's useSyncExternalStore. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(state: ConnState, client: IonClient | null): void {
    this.state = state;
    this.client = client;
    for (const fn of this.listeners) fn();
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    try {
      const info = await this.d.info();
      if (!info) throw new Error("ion isn't running");
      const client = await this.d.connect(info);
      if (this.stopped) return client.close();
      client.onClose(() => {
        if (this.client !== client) return;
        this.set("down", null);
        this.retry();
      });
      this.set("up", client);
    } catch {
      this.set(this.notRunning(), null);
      this.retry();
    }
  }

  private retry(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.attempt(), this.d.retryMs ?? 2000);
  }
}
