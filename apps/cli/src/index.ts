#!/usr/bin/env node
import { Command } from "commander";
import { askCommand } from "./commands/ask.js";
import { chatsCommands } from "./commands/chats.js";
import { ionsCommands } from "./commands/ions.js";
import { daemonCommands } from "./commands/daemon.js";
import { agentsCommands } from "./commands/harnesses.js";
import { hooksCommands } from "./commands/hooks.js";
import { mcpCommands } from "./commands/mcp.js";
import { skillsCommands } from "./commands/skills.js";
import { decisionsCommands } from "./commands/decisions.js";
import { memoryCommands } from "./commands/memory.js";
import { todoCommands } from "./commands/todo.js";
import { needsCommands } from "./commands/needs.js";
import { projectCommands } from "./commands/projects.js";
import { routinesCommands } from "./commands/routines.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { suggestionsCommands } from "./commands/suggestions.js";

const program = new Command("ion").option("--json", "Machine-readable output").showHelpAfterError();
const out = () => ({ json: Boolean(program.opts().json) });

daemonCommands(program, out);
statusCommand(program, out);
projectCommands(program, out);
askCommand(program, out);
needsCommands(program, out);
chatsCommands(program, out);
ionsCommands(program, out);
routinesCommands(program, out);
suggestionsCommands(program, out);
memoryCommands(program, out);
todoCommands(program, out);
decisionsCommands(program, out);
agentsCommands(program, out);
mcpCommands(program, out);
skillsCommands(program, out);
hooksCommands(program, out);
// Last: its settings for bare `ion` aren't passed on to the commands above.
startCommand(program, out);

await program.parseAsync();
