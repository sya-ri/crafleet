import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    DEPRECATED_SETTINGS,
    LockSchema,
    ProjectSchema,
    SETTINGS,
    type SettingKey,
    settingEnvironmentName,
    WorkspaceSchema,
} from "@crafleet/core";

const directory = path.resolve("packages/cli/dist/schemas");
await mkdir(directory, { recursive: true });
for (const [name, schema] of [
    ["crafleet", ProjectSchema],
    ["crafleet-workspace", WorkspaceSchema],
    ["crafleet-lock", LockSchema],
] as const) {
    const json = schema.toJsonSchema();
    if (name !== "crafleet-lock") {
        // Generated from the same catalog used by validation and settings list.
        const properties = json.properties as Record<
            string,
            {
                properties: Record<
                    string,
                    { properties: Record<string, object> }
                >;
            }
        >;
        for (const [key, definition] of Object.entries(SETTINGS)) {
            const [group, member] = key.split(".") as [string, string];
            Object.assign(
                properties.settings?.properties[group]?.properties[member] ??
                    {},
                {
                    description: `${definition.description}. Unit: ${definition.unit}. ${definition.unlimited ? "-1 disables this limit." : "A positive finite value is required."} Environment: ${settingEnvironmentName(key as SettingKey)}.`,
                    default: definition.default,
                },
            );
        }
        if (name === "crafleet") {
            for (const field of ["startupTimeout", "stopTimeout"] as const) {
                const java = properties.java?.properties as unknown as Record<
                    string,
                    object
                >;
                Object.assign(java?.[field] ?? {}, {
                    deprecated: true,
                    description: `Deprecated compatibility input in seconds. Use settings.${DEPRECATED_SETTINGS[`java.${field}`]} in milliseconds. Will be removed in a future release; the removal version is not yet scheduled. 将来のリリースで削除予定。具体的な削除バージョンは未定。`,
                });
            }
        }
    }
    await writeFile(
        path.join(directory, `${name}.schema.json`),
        `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: name, ...json }, null, 4)}\n`,
    );
}
const referencePath = path.resolve("docs/settings.md");
const reference = await readFile(referencePath, "utf8");
const rows = Object.entries(SETTINGS)
    .map(
        ([key, definition]) =>
            `| \`${key}\` | ${definition.default} | ${definition.unit} | ${definition.unlimited ? "yes" : "no"} | ${definition.minimum}–${definition.maximum} | ${definition.description} |`,
    )
    .join("\n");
await writeFile(
    referencePath,
    reference.replace(
        /<!-- catalog:start -->[\s\S]*<!-- catalog:end -->/u,
        `<!-- catalog:start -->\n\n| Key | Default | Unit | Supports -1 | Finite range | Applies to |\n| --- | ---: | --- | --- | --- | --- |\n${rows}\n\n<!-- catalog:end -->`,
    ),
);
