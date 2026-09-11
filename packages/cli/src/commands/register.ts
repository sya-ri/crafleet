import type { Command } from "commander";
import { registerArtifactCommands } from "./artifacts.js";
import { registerBackupCommands } from "./backup.js";
import { registerCompletionCommands } from "./completion.js";
import { registerConfigCommands } from "./config.js";
import type { CommandContext } from "./context.js";
import { registerMaintenanceCommands } from "./maintenance.js";
import { registerProjectCommands } from "./projects.js";
import { registerRuntimeCommands } from "./runtime.js";

export function registerCommands(
    program: Command,
    context: CommandContext,
): void {
    registerProjectCommands(program, context);
    registerCompletionCommands(program, context);
    registerArtifactCommands(program, context);
    registerRuntimeCommands(program, context);
    registerConfigCommands(program, context);
    registerConfigCommands(program, context, "files");
    registerBackupCommands(program, context);
    registerMaintenanceCommands(program, context);
}
