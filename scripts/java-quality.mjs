import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [mode, ...options] = process.argv.slice(2);
if (
    !["check", "format", "fix"].includes(mode) ||
    options.some((option) => option !== "--offline")
)
    throw new Error(
        "Usage: node scripts/java-quality.mjs <check|format|fix> [--offline]",
    );

// Only authored Java belongs here; never walk generated classes or server data.
async function sourceFiles(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...(await sourceFiles(file)));
        else if (entry.isFile() && entry.name.endsWith(".java"))
            found.push(file);
    }
    return found.sort();
}
const sources = [
    ...(await sourceFiles(path.join(root, "addons"))),
    ...(await sourceFiles(path.join(root, "tests/fixtures/plugins/src"))),
];
if (!sources.length) throw new Error("No authored Java sources found");

const javaHome =
    process.env.CRAFLEET_TEST_JAVA_HOME ||
    process.env.JAVA_HOME ||
    execFileSync("mise", ["where", "java"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
    }).trim();
const java = path.join(
    javaHome,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
);
const locks = JSON.parse(
    await readFile(new URL("./java-tools.lock.json", import.meta.url), "utf8"),
);
const cache = path.join(root, ".tools/java");

async function toolJar(name) {
    const locked = locks[name];
    const file = path.join(
        cache,
        `${name}-${locked.version}-${locked.sha256}.jar`,
    );
    let bytes;
    let downloaded = false;
    try {
        bytes = await readFile(file);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (options.includes("--offline"))
            throw new Error(
                `Missing cached Java tool: ${name} ${locked.version}`,
            );
        const response = await fetch(locked.url, {
            signal: AbortSignal.timeout(120000),
        });
        if (!response.ok)
            throw new Error(`Could not download ${name}: ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        downloaded = true;
    }
    if (
        bytes.length !== locked.size ||
        createHash("sha256").update(bytes).digest("hex") !== locked.sha256
    )
        throw new Error(
            `Java tool checksum mismatch: ${name}; remove ${file} and retry`,
        );
    if (downloaded) {
        await mkdir(cache, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, bytes, { flag: "wx" });
            await rename(temporary, file);
        } finally {
            await rm(temporary, { force: true });
        }
    }
    return file;
}

function run(jar, args) {
    const result = spawnSync(java, ["-jar", jar, ...args], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status === 0;
}

const formatter = await toolJar("google-java-format");
const formatted = run(formatter, [
    "--aosp",
    ...(mode === "check"
        ? ["--dry-run", "--set-exit-if-changed"]
        : ["--replace"]),
    ...sources,
]);
let linted = true;
if (mode !== "format") {
    linted = run(await toolJar("checkstyle"), [
        "-c",
        path.join(root, "scripts/checkstyle.xml"),
        ...sources,
    ]);
}
if (!formatted || !linted) {
    if (!formatted && mode === "check")
        console.error("Run pnpm format:java to fix Java formatting.");
    process.exitCode = 1;
} else {
    console.log(
        `${mode === "format" ? "Formatted" : "Checked"} ${sources.length} Java source files.`,
    );
}
