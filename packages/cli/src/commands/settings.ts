import {
    captureRuntimeSettings,
    readRuntimeSettings,
    selectProjects,
} from "@crafleet/adapters";
import {
    DEPRECATED_SETTINGS,
    SETTINGS,
    type SettingKey,
    settingEnvironmentName,
} from "@crafleet/core";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";

export function registerSettingsCommands(
    program: Command,
    context: CommandContext,
): void {
    const settings = program
        .command("settings")
        .description(
            "List runtime settings and inspect effective limits. -1 means unlimited where supported.",
        );
    context.action(
        settings
            .command("list")
            .description(
                "List keys, defaults, units, supported ranges and environment variables.",
            ),
        async () =>
            Object.entries(SETTINGS).map(([key, definition]) => ({
                key,
                ...definition,
                environment: settingEnvironmentName(key as SettingKey),
                deprecatedInputs: Object.entries(DEPRECATED_SETTINGS)
                    .filter(([, replacement]) => replacement === key)
                    .map(([old]) => old),
            })),
    );
    context.action(
        settings
            .command("show")
            .description(
                "Show effective settings and their sources for the selected projects.",
            ),
        async (_, command) => {
            const globals = context.globals(command);
            const targets =
                globals.recursive || globals.filter?.length
                    ? await selectProjects(context.cwd(command), context.home, {
                          recursive: globals.recursive ?? false,
                          filters: globals.filter ?? [],
                      })
                    : [];
            const display = (
                resolved: ReturnType<typeof captureRuntimeSettings>,
                project?: string,
            ) => ({
                ...(project ? { project } : {}),
                settings: Object.entries(resolved.values).map(
                    ([key, value]) => ({
                        key,
                        value,
                        unit: SETTINGS[key as SettingKey].unit,
                        source: resolved.sources[key as SettingKey],
                    }),
                ),
                deprecated: resolved.deprecated,
            });
            return targets.length
                ? Promise.all(
                      targets.map(async (project) =>
                          display(
                              (await readRuntimeSettings(project.dir)).resolved,
                              project.manifest.name,
                          ),
                      ),
                  )
                : display(captureRuntimeSettings());
        },
    );
}
