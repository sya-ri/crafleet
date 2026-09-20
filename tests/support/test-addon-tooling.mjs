import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    cp,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const parent = path.join(repository, ".test-tmp");
await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(path.join(parent, "addon-tooling-"));
const javaHome =
    process.env.CRAFLEET_TEST_JAVA_HOME ||
    process.env.JAVA_HOME ||
    execFileSync("mise", ["where", "java"], {
        cwd: repository,
        encoding: "utf8",
        windowsHide: true,
    }).trim();

async function write(file, content) {
    const target = path.join(workspace, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
}
function run(script, args = [], success = true) {
    const result = spawnSync(
        process.execPath,
        [path.join(workspace, script), ...args],
        {
            cwd: workspace,
            env: { ...process.env, CRAFLEET_TEST_JAVA_HOME: javaHome },
            encoding: "utf8",
            windowsHide: true,
            timeout: 120000,
        },
    );
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (success) assert.equal(result.status, 0, output);
    else
        assert.notEqual(
            result.status,
            0,
            "Expected the tool to reject invalid input",
        );
    return output;
}

try {
    for (const file of [
        "addons/build.mjs",
        "addons/projects.mjs",
        "addons/test-servers.mjs",
        "scripts/version.mjs",
        "scripts/java-quality.mjs",
        "scripts/java-tools.lock.json",
        "scripts/checkstyle.xml",
    ]) {
        await write(file, await readFile(path.join(repository, file)));
    }
    await write("packages/cli/package.json", '{"version":"1.2.3"}');
    await write("LICENSE", "Tooling test fixture\n");
    for (const [id, release] of [
        ["alpha", 8],
        ["beta", 17],
    ]) {
        await write(
            `addons/${id}/addon.json`,
            JSON.stringify({
                targets: { test: { release, dependencies: [] } },
            }),
        );
        await write(`addons/${id}/dependencies.lock.json`, "{}");
        await write(
            `addons/${id}/test/Example.java`,
            "public final class Example {}\n",
        );
        await write(
            `addons/${id}/resources/test/descriptor.json`,
            '{\r\n  "version": "@VERSION@"\r\n}\r\n',
        );
        await write(
            `addons/${id}/resources/test/icon.bin`,
            Buffer.from([0, 255, 13, 10]),
        );
        await write(
            `addons/${id}/test-servers.mjs`,
            `import { writeFileSync } from "node:fs"; writeFileSync("${id}.ran", process.argv.slice(2).join(" "));`,
        );
    }
    run("addons/build.mjs", ["--offline", "--verify-reproducible"]);
    for (const [id, major] of [
        ["alpha", 52],
        ["beta", 61],
    ]) {
        const directory = `artifacts/${id}`;
        const manifest = JSON.parse(
            await readFile(
                path.join(workspace, directory, "manifest.json"),
                "utf8",
            ),
        );
        assert.equal(manifest.version, "1.2.3");
        assert.ok(manifest.artifacts.test.size > 0);
        const classes = path.join(workspace, directory, "test/classes");
        assert.equal(
            (await readFile(path.join(classes, "Example.class"))).readUInt16BE(
                6,
            ),
            major,
        );
        assert.equal(
            await readFile(path.join(classes, "descriptor.json"), "utf8"),
            '{\n  "version": "1.2.3"\n}\n',
        );
        assert.deepEqual(
            await readFile(path.join(classes, "icon.bin")),
            Buffer.from([0, 255, 13, 10]),
        );
    }
    run("addons/test-servers.mjs", ["--prepare"]);
    for (const id of ["alpha", "beta"])
        assert.equal(
            await readFile(path.join(workspace, `${id}.ran`), "utf8"),
            "--prepare",
        );
    await write("addons/alpha/test-servers.mjs", "process.exit(2);");
    run("addons/test-servers.mjs", [], false);

    await write(
        "tests/fixtures/plugins/src/Fixture.java",
        "public final class Fixture {}\n",
    );
    assert.match(
        run("scripts/java-quality.mjs", ["check", "--offline"], false),
        /Missing cached Java tool/,
    );
    await cp(
        path.join(repository, ".tools/java"),
        path.join(workspace, ".tools/java"),
        { recursive: true },
    );
    const bad =
        "import java.util.*;\npublic class Example { int a, b; void run() { if (true) a++; a++; } }\n";
    await write("addons/alpha/test/Example.java", bad);
    const rejected = run(
        "scripts/java-quality.mjs",
        ["check", "--offline"],
        false,
    );
    for (const rule of [
        "AvoidStarImport",
        "NeedBraces",
        "MultipleVariableDeclarations",
        "OneStatementPerLine",
    ])
        assert.ok(rejected.includes(rule), `Missing lint diagnostic: ${rule}`);
    assert.equal(
        await readFile(
            path.join(workspace, "addons/alpha/test/Example.java"),
            "utf8",
        ),
        bad,
    );
    run("scripts/java-quality.mjs", ["fix", "--offline"], false);
    await write(
        "addons/alpha/test/Example.java",
        "public final class Example {\n  public void run() {}\n}\n",
    );
    run("scripts/java-quality.mjs", ["format", "--offline"]);
    run("scripts/java-quality.mjs", ["check", "--offline"]);
    const locks = JSON.parse(
        await readFile(
            path.join(workspace, "scripts/java-tools.lock.json"),
            "utf8",
        ),
    );
    const formatter = locks["google-java-format"];
    await write(
        `.tools/java/google-java-format-${formatter.version}-${formatter.sha256}.jar`,
        "corrupted",
    );
    assert.match(
        run("scripts/java-quality.mjs", ["check", "--offline"], false),
        /Java tool checksum mismatch/,
    );
    await write(
        "addons/alpha/addon.json",
        JSON.stringify({
            targets: { "../escape": { release: 8, dependencies: [] } },
        }),
    );
    assert.match(
        run("addons/build.mjs", ["--offline"], false),
        /Invalid build target/,
    );
    console.log(
        "Verified multiple addon builds, bytecode targets, resources, runtime dispatch, Java lint failures, offline tools, and checksum rejection.",
    );
} finally {
    if (path.dirname(await realpath(workspace)) !== (await realpath(parent))) {
        console.error(
            "Refusing to clean up an unexpected tooling test directory",
        );
        process.exitCode = 1;
    } else {
        await rm(workspace, { recursive: true, force: true });
    }
}
