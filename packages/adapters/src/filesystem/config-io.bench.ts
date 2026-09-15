import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { NodeConfigManager } from "./config.js";

const temporaryParent = await realpath(os.tmpdir());
const roots: string[] = [];
const cases = [
    { name: "scan 64 YAML files", count: 64, suffix: "yml", entries: 128 },
    {
        name: "scan 4 large YAML files",
        count: 4,
        suffix: "yml",
        entries: 12_000,
    },
    {
        name: "hash 16 binary files (8 MiB each)",
        count: 16,
        suffix: "dat",
        entries: 0,
    },
];
const managers = new Map<string, NodeConfigManager>();

beforeAll(async () => {
    for (const scenario of cases) {
        const root = await mkdtemp(
            path.join(temporaryParent, "crafleet-config-bench-"),
        );
        roots.push(root);
        const content =
            scenario.entries === 0
                ? Buffer.alloc(8 * 1024 * 1024, 0x81)
                : Array.from(
                      { length: scenario.entries },
                      (_, index) => `entry_${index}: ${index}\n`,
                  ).join("");
        for (const directory of ["files", "runtime"]) {
            await mkdir(path.join(root, directory));
            for (let index = 0; index < scenario.count; index++)
                await writeFile(
                    path.join(root, directory, `${index}.${scenario.suffix}`),
                    content,
                );
        }
        await writeFile(
            path.join(root, "credential"),
            "benchmark-only-value\n",
        );
        managers.set(
            scenario.name,
            new NodeConfigManager(
                root,
                { AUTH: { file: "credential" } },
                "files",
            ),
        );
    }
}, 60_000);

afterAll(async () => {
    console.info(
        `Configuration I/O benchmark peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`,
    );
    for (const root of roots) {
        assert.equal(path.dirname(root), temporaryParent);
        assert(path.basename(root).startsWith("crafleet-config-bench-"));
        await rm(root, { recursive: true, force: true });
    }
});

describe("managed file inspection", () => {
    for (const scenario of cases)
        bench(
            scenario.name,
            async () => {
                const manager = managers.get(scenario.name);
                assert(manager);
                const files = await manager.diff();
                assert.equal(files.length, scenario.count);
                assert.deepEqual(
                    files.map((file) => file.relative),
                    files.map((file) => file.relative).sort(),
                );
                assert(files.every((file) => file.conflicts.length === 0));
            },
            { iterations: 5, time: 500, warmupIterations: 1, warmupTime: 100 },
        );
});
