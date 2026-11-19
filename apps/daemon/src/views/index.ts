import { decisionsView } from "./decisions.js";
import { memoryView } from "./memory.js";
import { messagesView } from "./messages.js";
import { chatsView } from "./chats.js";
import { ionsView } from "./ions.js";
import { needsView } from "./needs.js";
import { routinesView } from "./routines.js";
import { runsView } from "./runs.js";

/** Applied in this order on every append; needs reads the chats table, so chats comes first. */
export const allViews = [
  runsView,
  chatsView,
  needsView,
  messagesView,
  memoryView,
  decisionsView,
  ionsView,
  routinesView,
];
