import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadAddons, root } from "./projects.mjs";

for (const project of await loadAddons()) {
    console.log(`Testing addon: ${project.id}`);
    execFileSync(
        process.execPath,
        [
            path.join(project.source, "test-servers.mjs"),
            ...process.argv.slice(2),
        ],
        { cwd: root, stdio: "inherit", windowsHide: true },
    );
}
