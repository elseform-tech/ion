import type { IonEvent } from "@ion/schema";
import type { Db } from "./db.js";

/** A table kept up to date as each event is appended, inside the same transaction. */
export interface View {
  name: string;
  /** Bump when the tables change: an existing database then drops and rebuilds them from the log. */
  version?: number;
  /** The tables this view owns (dropped when its version changes). */
  tables?: string[];
  migrate(db: Db): void;
  apply(db: Db, e: IonEvent): void;
  reset(db: Db): void;
}
