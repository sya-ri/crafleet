import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crafleetVersion } from "../../scripts/version.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = fileURLToPath(new URL("./", import.meta.url));
const output = path.join(root, "artifacts/console");
const dependencies = JSON.parse(
    await readFile(path.join(source, "dependencies.lock.json"), "utf8"),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(path.join(output, "cache"), { recursive: true });
for (const [name, locked] of Object.entries(dependencies)) {
    const file = path.join(output, "cache", `${name}.jar`);
    let bytes;
    try {
        bytes = await readFile(file);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (!bytes) {
        if (process.argv.includes("--offline"))
            throw new Error(`Missing cached API: ${name}`);
        const response = await fetch(locked.url, {
            signal: AbortSignal.timeout(120000),
        });
        if (!response.ok)
            throw new Error(`Could not download ${name}: ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length !== locked.size || sha256(bytes) !== locked.sha256)
        throw new Error(`API checksum mismatch: ${name}`);
    await writeFile(file, bytes);
}
const javaHome =
    process.env.CRAFLEET_TEST_JAVA_HOME ||
    process.env.JAVA_HOME ||
    execFileSync("mise", ["where", "java"], {
        encoding: "utf8",
        windowsHide: true,
    }).trim();
const tool = (name) =>
    path.join(
        javaHome,
        "bin",
        `${name}${process.platform === "win32" ? ".exe" : ""}`,
    );
const javacVersion = execFileSync(tool("javac"), ["-version"], {
    encoding: "utf8",
    windowsHide: true,
}).trim();
if (javacVersion !== "javac 25.0.3")
    throw new Error(
        `Use the pinned JDK 25.0.3 for reproducible addon builds; found ${javacVersion}`,
    );
const files = async (dir) => {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await files(full)));
        else if (entry.isFile()) found.push(full);
    }
    return found.sort();
};
const manifest = { version: crafleetVersion, artifacts: {} };
for (const kind of ["paper", "velocity"]) {
    const classes = path.join(output, kind, "classes");
    if (!path.resolve(classes).startsWith(`${path.resolve(output)}${path.sep}`))
        throw new Error("Unsafe addon build directory");
    await rm(classes, { recursive: true, force: true });
    await mkdir(classes, { recursive: true });
    const classpath = Object.keys(dependencies)
        .filter((name) =>
            kind === "paper" ? name === "paper" : name !== "paper",
        )
        .map((name) => path.join(output, "cache", `${name}.jar`))
        .join(path.delimiter);
    const sources = [
        ...(await files(path.join(source, "common"))),
        ...(await files(path.join(source, kind))),
    ].filter((file) => file.endsWith(".java"));
    execFileSync(
        tool("javac"),
        [
            "-encoding",
            "UTF-8",
            "--release",
            kind === "paper" ? "8" : "17",
            "-proc:none",
            "-classpath",
            classpath,
            "-d",
            classes,
            ...sources,
        ],
        { stdio: "inherit", windowsHide: true },
    );
    if (kind === "paper")
        await writeFile(
            path.join(classes, "plugin.yml"),
            `name: CrafleetConsole\nversion: '${crafleetVersion}'\nmain: dev.crafleet.console.PaperConsole\napi-version: '1.13'\ndescription: Crafleet console tab completion\n`,
        );
    else
        await writeFile(
            path.join(classes, "velocity-plugin.json"),
            JSON.stringify({
                id: "crafleetconsole",
                name: "Crafleet Console",
                version: crafleetVersion,
                main: "dev.crafleet.console.VelocityConsole",
                authors: ["Crafleet"],
            }),
        );
    await mkdir(path.join(classes, "META-INF"), { recursive: true });
    await writeFile(
        path.join(classes, "META-INF/MANIFEST.MF"),
        `Manifest-Version: 1.0\r\nImplementation-Version: ${crafleetVersion}\r\n\r\n`,
    );
    await writeFile(
        path.join(classes, "META-INF/LICENSE"),
        await readFile(path.join(root, "LICENSE")),
    );
    const jar = path.join(output, `crafleet-console-${kind}.jar`);
    const entries = (await files(classes)).map((file) =>
        path.relative(classes, file).replaceAll(path.sep, "/"),
    );
    execFileSync(
        tool("jar"),
        [
            "--create",
            "--file",
            jar,
            "--no-manifest",
            "--date=2000-01-01T00:00:00Z",
            ...entries,
        ],
        { cwd: classes, stdio: "inherit", windowsHide: true },
    );
    const bytes = await readFile(jar);
    manifest.artifacts[kind] = { sha256: sha256(bytes), size: bytes.length };
}
await writeFile(
    path.join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
    path.join(output, "SHA256SUMS"),
    `${Object.entries(manifest.artifacts)
        .map(
            ([kind, artifact]) =>
                `${artifact.sha256}  crafleet-console-${kind}.jar`,
        )
        .join("\n")}\n`,
);
console.log(
    `Built console addons ${crafleetVersion} (Paper: Java 8; Velocity: Java 17).`,
);
if (process.argv.includes("--verify-reproducible")) {
    execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--offline"],
        { stdio: "inherit", windowsHide: true },
    );
    const rebuilt = JSON.parse(
        await readFile(path.join(output, "manifest.json"), "utf8"),
    );
    if (JSON.stringify(manifest) !== JSON.stringify(rebuilt))
        throw new Error("Console addon builds are not reproducible");
    console.log("Verified identical JARs from two clean builds.");
}
