import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "addons");
const safeName = /^[a-z][a-z0-9-]*$/;

export async function loadAddons() {
    const projects = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = path.join(directory, entry.name);
        const config = JSON.parse(
            await readFile(path.join(source, "addon.json"), "utf8"),
        );
        if (
            !safeName.test(entry.name) ||
            !Object.keys(config.targets ?? {}).length
        )
            throw new Error(`Invalid addon configuration: ${entry.name}`);
        const dependencies = JSON.parse(
            await readFile(path.join(source, "dependencies.lock.json"), "utf8"),
        );
        if (Object.keys(dependencies).some((name) => !safeName.test(name)))
            throw new Error(`Invalid dependency name: ${entry.name}`);
        for (const [kind, target] of Object.entries(config.targets)) {
            if (
                !safeName.test(kind) ||
                !Number.isInteger(target.release) ||
                target.release < 8 ||
                !Array.isArray(target.dependencies) ||
                target.dependencies.some(
                    (name) => !Object.hasOwn(dependencies, name),
                )
            )
                throw new Error(`Invalid build target: ${entry.name}/${kind}`);
        }
        projects.push({
            id: entry.name,
            source,
            output: path.join(root, "artifacts", entry.name),
            targets: config.targets,
            dependencies,
        });
    }
    if (!projects.length) throw new Error("No addon projects found");
    return projects.sort((left, right) => left.id.localeCompare(right.id));
}
