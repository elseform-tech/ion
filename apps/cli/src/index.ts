#!/usr/bin/env node
import { Command } from "commander";
import { askCommand } from "./commands/ask.js";
import { chatsCommands } from "./commands/chats.js";
import { daemonCommands } from "./commands/daemon.js";
import { memoryCommands } from "./commands/memory.js";
import { needsCommands } from "./commands/needs.js";
import { projectCommands } from "./commands/projects.js";
import { statusCommand } from "./commands/status.js";

const program = new Command("ion").option("--json", "Machine-readable output").showHelpAfterError();
const out = () => ({ json: Boolean(program.opts().json) });

daemonCommands(program, out);
statusCommand(program, out);
projectCommands(program, out);
askCommand(program, out);
needsCommands(program, out);
chatsCommands(program, out);
memoryCommands(program, out);

await program.parseAsync();
