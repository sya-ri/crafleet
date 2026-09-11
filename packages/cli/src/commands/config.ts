import path from "node:path";
import {
    discoverConfigCandidates,
    migrateFiles,
    NodeConfigManager,
    NodeFilesManager,
} from "@crafleet/adapters";
import { CrafleetError } from "@crafleet/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "./context.js";

export function registerConfigCommands(
    program: Command,
    context: CommandContext,
    mode: "config" | "files" = "config",
): void {
    const group = program
        .command(mode)
        .description(
            mode === "files"
                ? "Manage text and binary files with stopped runtime captures."
                : "Deprecated: manage legacy config/ until removal in 0.6.0. Migrate with files migrate --from config.",
        );
    const manager = async (command: Command) => {
        const project = await context.one(command);
        if (mode === "config") {
            if (project.manifest.files)
                throw new CrafleetError(
                    "CONFIG_MIGRATED",
                    "This project uses files. Replace crafleet config with crafleet files.",
                    2,
                );
        } else if (!project.manifest.files)
            throw new CrafleetError(
                "FILES_MIGRATION_REQUIRED",
                "Run crafleet files migrate --from config before using files commands.",
                2,
            );
        return {
            project,
            config:
                mode === "files"
                    ? new NodeFilesManager(
                          project.dir,
                          project.manifest.secrets,
                          { home: project.home, lockRoot: project.lockRoot },
                      )
                    : new NodeConfigManager(
                          project.dir,
                          project.manifest.secrets,
                      ),
        };
    };
    context.action(
        group
            .command("list")
            .description(
                `Show managed files; --candidates shows unmanaged files selected by ${mode === "files" ? "files.patterns" : "config.files"} or the built-in defaults.`,
            )
            .option(
                "--candidates",
                "list new configuration candidates, excluding managed files",
            ),
        async (_, command) => {
            const { project, config } = await manager(command);
            const options = command.opts();
            if (!options.candidates) return config.list();
            const candidates = await discoverConfigCandidates(
                path.join(project.dir, "runtime"),
                project.manifest.server.type,
                mode === "files"
                    ? project.manifest.files?.patterns
                    : project.manifest.config?.files,
                mode === "files",
            );
            const tracked = new Set(
                (await config.list()).map((file) => file.relative),
            );
            return candidates.filter(
                (candidate) => !tracked.has(candidate.relative),
            );
        },
    );
    context.action(
        group
            .command("track <paths...>")
            .description(
                "Explicitly begin tracking runtime-relative configuration files.",
            ),
        async ([paths], command) => {
            const { config } = await manager(command);
            if (context.globals(command).dryRun)
                return { action: "track", paths };
            const results = [];
            for (const file of paths as string[])
                results.push(await config.track(file));
            return results;
        },
    );
    context.action(
        group
            .command("untrack <paths...>")
            .description(
                `Remove saved files from ${mode}/ while keeping runtime files.`,
            ),
        async ([paths], command) => {
            const { config } = await manager(command);
            if (!context.globals(command).dryRun) {
                await context.ask(
                    command,
                    `Remove these managed files from ${mode}/? Runtime files are retained.`,
                );
                for (const file of paths as string[])
                    await config.untrack(file);
            }
            return { untracked: paths, runtimeUnchanged: true };
        },
    );
    context.action(
        group
            .command("diff")
            .description(
                "Show the three-way comparison with secret values removed.",
            ),
        async (_, command) => (await manager(command)).config.diff(),
    );
    context.action(
        group
            .command("capture [paths...]")
            .description(
                "Merge runtime changes into templates, refusing conflicts.",
            )
            .option(
                "--initial",
                `include candidates from ${mode === "files" ? "files.patterns" : "config.files"} or the built-in defaults`,
            )
            .option(
                "--include-bans",
                "also select ban lists during initial capture",
            )
            .option(
                "--include <glob>",
                "limit managed and new files to these ordered patterns (repeatable)",
                (value: string, previous: string[]) => [...previous, value],
                [],
            )
            .option(
                "--keep-missing",
                "retain saved files missing from runtime",
            ),
        async ([paths], command) => {
            const { project, config } = await manager(command);
            const selected = paths as string[];
            const result = await config.capture({
                initial: Boolean(command.opts().initial),
                includeBans: Boolean(command.opts().includeBans),
                kind: project.manifest.server.type,
                ...(mode === "files" &&
                project.manifest.files?.patterns !== undefined
                    ? { candidates: project.manifest.files.patterns }
                    : project.manifest.config
                      ? { candidates: project.manifest.config.files }
                      : {}),
                dryRun: context.globals(command).dryRun ?? false,
                ...(command.opts().include.length
                    ? { include: command.opts().include as string[] }
                    : {}),
                keepMissing: Boolean(command.opts().keepMissing),
                ...(selected.length ? { paths: selected } : {}),
            });
            if (result.conflicts.length) process.exitCode = 3;
            return result;
        },
    );
    context.action(
        group
            .command("resolve <path>")
            .description(
                "Explicitly resolve a managed conflict using the base or runtime version.",
            )
            .addOption(
                new Option("--use <side>", "chosen version")
                    .choices(["base", "runtime"])
                    .makeOptionMandatory(),
            ),
        async ([file], command) => {
            const { config } = await manager(command);
            const side = command.opts<{ use: "base" | "runtime" }>().use;
            if (!context.globals(command).dryRun) {
                await context.ask(
                    command,
                    `Resolve ${String(file)} using ${side}?`,
                );
                await config.resolve(String(file), side);
            }
            return { path: file, resolution: side };
        },
    );
    if (mode === "files")
        context.action(
            group
                .command("migrate")
                .description(
                    "Migrate config/ and its observations without changing runtime. Resume an interrupted migration by repeating this command.",
                )
                .addOption(
                    new Option("--from <feature>", "legacy feature")
                        .choices(["config"])
                        .makeOptionMandatory(),
                )
                .option("--rollback", "roll back an interrupted migration"),
            async (_, command) =>
                migrateFiles(await context.one(command), {
                    dryRun: context.globals(command).dryRun ?? false,
                    rollback: Boolean(command.opts().rollback),
                }),
        );
}
