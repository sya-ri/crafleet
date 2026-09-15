// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal secret-token fixtures.
import assert from "node:assert/strict";
import { bench, describe } from "vitest";
import { FileSecrets } from "./file-content.js";
import { ConfigSecrets } from "./secrets.js";

// Generated fixtures keep private server configuration out of benchmark reports.
const rows = Array.from(
    { length: 12_000 },
    (_, index) => `entry_${index}: ${index}\n`,
).join("");
const secret = "benchmark-credential-value";
const template = `credential: "\${secret:AUTH}"\n${rows}`;
const options = {
    iterations: 5,
    time: 500,
    warmupIterations: 1,
    warmupTime: 100,
};

describe("wide YAML secret handling (12,000 entries)", () => {
    for (const [name, text] of [
        ["public values with a registered secret", rows],
        ["one secret placeholder", template],
    ] as const) {
        bench(
            name,
            () => {
                const files = new FileSecrets(
                    new ConfigSecrets(new Map([["AUTH", secret]])),
                );
                files.assertTemplate("settings.yml", text);
                const raw = files.inject("settings.yml", text);
                const captured = files.tokenize("settings.yml", raw, [
                    text,
                    text,
                ]);
                assert.equal(captured, text);
            },
            options,
        );
    }

    bench(
        "four public files in deployment phase order",
        () => {
            const files = new FileSecrets(
                new ConfigSecrets(new Map([["AUTH", secret]])),
            );
            const paths = ["a.yml", "b.yml", "c.yml", "d.yml"];
            // Deployment validates the bundle, resolves every template, then
            // records each emitted file. Retaining only one AST must also help
            // this ordering, where successive phases revisit different files.
            for (const relative of paths) files.assertTemplate(relative, rows);
            const emitted = paths.map((relative) => ({
                relative,
                raw: files.inject(relative, rows),
            }));
            for (const { relative, raw } of emitted)
                assert.equal(files.tokenize(relative, raw, [rows]), rows);
        },
        options,
    );
});
