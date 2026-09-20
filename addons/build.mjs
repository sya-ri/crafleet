import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crafleetVersion } from "../scripts/version.mjs";
import { loadAddons, root } from "./projects.mjs";

if (
    process.argv
        .slice(2)
        .some((arg) => !["--offline", "--verify-reproducible"].includes(arg))
)
    throw new Error(
        "Usage: node addons/build.mjs [--offline] [--verify-reproducible]",
    );
const projects = await loadAddons();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const javaHome =
    process.env.CRAFLEET_TEST_JAVA_HOME ||
    process.env.JAVA_HOME ||
    execFileSync("mise", ["where", "java"], {
        cwd: root,
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

async function files(directory, optional = false) {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (optional && error.code === "ENOENT") return [];
        throw error;
    }
    const found = [];
    for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...(await files(full)));
        else if (entry.isFile()) found.push(full);
    }
    return found.sort();
}

async function prepareDependencies(project) {
    const cache = path.join(project.output, "cache");
    await mkdir(cache, { recursive: true });
    for (const [name, locked] of Object.entries(project.dependencies)) {
        const file = path.join(cache, `${name}.jar`);
        let bytes;
        try {
            bytes = await readFile(file);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (!bytes) {
            if (process.argv.includes("--offline"))
                throw new Error(`Missing cached API: ${project.id}/${name}`);
            const response = await fetch(locked.url, {
                signal: AbortSignal.timeout(120000),
            });
            if (!response.ok)
                throw new Error(
                    `Could not download ${project.id}/${name}: ${response.status}`,
                );
            bytes = Buffer.from(await response.arrayBuffer());
        }
        if (bytes.length !== locked.size || sha256(bytes) !== locked.sha256)
            throw new Error(`API checksum mismatch: ${project.id}/${name}`);
        await writeFile(file, bytes);
    }
}

async function build(project) {
    await prepareDependencies(project);
    const manifest = { version: crafleetVersion, artifacts: {} };
    for (const [kind, target] of Object.entries(project.targets)) {
        const classes = path.join(project.output, kind, "classes");
        if (
            !path
                .resolve(classes)
                .startsWith(`${path.resolve(project.output)}${path.sep}`)
        )
            throw new Error("Unsafe addon build directory");
        await rm(classes, { recursive: true, force: true });
        await mkdir(classes, { recursive: true });
        const classpath = target.dependencies
            .map((name) => path.join(project.output, "cache", `${name}.jar`))
            .join(path.delimiter);
        const sources = [
            ...(await files(path.join(project.source, "common"), true)),
            ...(await files(path.join(project.source, kind))),
        ].filter((file) => file.endsWith(".java"));
        execFileSync(
            tool("javac"),
            [
                "-encoding",
                "UTF-8",
                "--release",
                String(target.release),
                "-proc:none",
                "-classpath",
                classpath,
                "-d",
                classes,
                ...sources,
            ],
            { stdio: "inherit", windowsHide: true },
        );

        const resources = path.join(project.source, "resources", kind);
        for (const file of await files(resources, true)) {
            const destination = path.join(
                classes,
                path.relative(resources, file),
            );
            let bytes = await readFile(file);
            if (/\.(json|ya?ml)$/.test(file)) {
                bytes = Buffer.from(
                    bytes
                        .toString("utf8")
                        .replaceAll("\r\n", "\n")
                        .replaceAll("@VERSION@", crafleetVersion),
                );
            }
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bytes);
        }
        await mkdir(path.join(classes, "META-INF"), { recursive: true });
        await writeFile(
            path.join(classes, "META-INF/MANIFEST.MF"),
            `Manifest-Version: 1.0\r\nImplementation-Version: ${crafleetVersion}\r\n\r\n`,
        );
        await writeFile(
            path.join(classes, "META-INF/LICENSE"),
            await readFile(path.join(root, "LICENSE")),
        );
        const jar = path.join(
            project.output,
            `crafleet-${project.id}-${kind}.jar`,
        );
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
        manifest.artifacts[kind] = {
            sha256: sha256(bytes),
            size: bytes.length,
        };
    }
    await writeFile(
        path.join(project.output, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeFile(
        path.join(project.output, "SHA256SUMS"),
        `${Object.entries(manifest.artifacts)
            .map(
                ([kind, artifact]) =>
                    `${artifact.sha256}  crafleet-${project.id}-${kind}.jar`,
            )
            .join("\n")}\n`,
    );
    console.log(
        `Built ${project.id} ${crafleetVersion} (${Object.entries(
            project.targets,
        )
            .map(([kind, target]) => `${kind}: Java ${target.release}`)
            .join("; ")}).`,
    );
    return manifest;
}

const manifests = new Map();
for (const project of projects) manifests.set(project.id, await build(project));
if (process.argv.includes("--verify-reproducible")) {
    execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--offline"],
        { stdio: "inherit", windowsHide: true },
    );
    for (const project of projects) {
        const rebuilt = JSON.parse(
            await readFile(path.join(project.output, "manifest.json"), "utf8"),
        );
        if (
            JSON.stringify(manifests.get(project.id)) !==
            JSON.stringify(rebuilt)
        )
            throw new Error(`Addon builds are not reproducible: ${project.id}`);
    }
    console.log(
        `Verified identical JARs from two clean builds for ${projects.length} addon projects.`,
    );
}
