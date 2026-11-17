import eventTypesFromSchema from "./event-types-from-schema.js";
import noChildProcess from "./no-child-process.js";
import noDirectDb from "./no-direct-db.js";
import walls from "./walls.js";

export default {
  meta: { name: "ion" },
  rules: {
    "event-types-from-schema": eventTypesFromSchema,
    "no-direct-db": noDirectDb,
    "no-child-process": noChildProcess,
    walls,
  },
};
