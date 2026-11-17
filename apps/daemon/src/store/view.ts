import type { IonEvent } from "@ion/schema";
import type { Db } from "./db.js";

/** A table kept up to date as each event is appended, inside the same transaction. */
export interface View {
  name: string;
  migrate(db: Db): void;
  apply(db: Db, e: IonEvent): void;
  reset(db: Db): void;
}
