import { memoryView } from "./memory.js";
import { messagesView } from "./messages.js";
import { chatsView } from "./chats.js";
import { needsView } from "./needs.js";
import { runsView } from "./runs.js";

/** Applied in this order on every append; needs reads the chats table, so chats comes first. */
export const allViews = [runsView, chatsView, needsView, messagesView, memoryView];
