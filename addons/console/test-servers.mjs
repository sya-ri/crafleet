import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "artifacts/console");
const targets = JSON.parse(
    await readFile(new URL("servers.lock.json", import.meta.url), "utf8"),
);
const selected = process.env.CRAFLEET_ADDON_TARGET;
const manifest = JSON.parse(
    await readFile(path.join(output, "manifest.json"), "utf8"),
);
const results = selected
    ? await readFile(path.join(output, "runtime-verification.json"), "utf8")
          .then(JSON.parse)
          .catch((error) => {
              if (error.code === "ENOENT") return [];
              throw error;
          })
    : [];
await mkdir(path.join(output, "servers"), { recursive: true });
await mkdir(path.join(root, ".test-tmp"), { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function serverJar(target) {
    const name = `${target.kind}-${target.version}-${target.build}.jar`;
    const file = path.join(output, "servers", name);
    let bytes;
    try {
        bytes = await readFile(file);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (!bytes) {
        try {
            bytes = await readFile(
                path.join(
                    root,
                    "artifacts/fixtures/cache",
                    target.sha256,
                    "artifact.jar",
                ),
            );
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    if (!bytes) {
        const response = await fetch(
            `https://fill-data.papermc.io/v1/objects/${target.sha256}/${name}`,
            { signal: AbortSignal.timeout(120000) },
        );
        if (!response.ok)
            throw new Error(`Download failed: ${name} (${response.status})`);
        bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(bytes.length, target.size);
    assert.equal(sha256(bytes), target.sha256);
    await writeFile(file, bytes);
    return file;
}
async function check(target, jar) {
    if (target.kind === "paper" && process.env.CRAFLEET_E2E_EULA !== "true")
        throw new Error(
            "Accept the Minecraft EULA explicitly before setting CRAFLEET_E2E_EULA=true for these disposable tests.",
        );
    const javaHome = process.env[`CRAFLEET_JAVA${target.java}`];
    if (!javaHome)
        throw new Error(
            `Set CRAFLEET_JAVA${target.java} to the corresponding JDK/JRE home`,
        );
    const java = path.join(
        javaHome,
        "bin",
        process.platform === "win32" ? "java.exe" : "java",
    );
    const directory = await mkdtemp(
        path.join(
            root,
            ".test-tmp",
            `addon-console-${target.kind}-${target.build}-`,
        ),
    );
    const token = randomUUID();
    const sockets = new Set();
    let connected;
    let received = "";
    let logs = "";
    let processError;
    const replies = new Map();
    const bridge = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            for (;;) {
                const end = buffer.indexOf("\n");
                if (end < 0) break;
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                if (line.startsWith("HELLO\t")) {
                    if (
                        line !==
                        `HELLO\t1\t${token}\t${manifest.version}\t${target.kind}`
                    ) {
                        processError = new Error("Invalid addon handshake");
                        socket.destroy();
                        return;
                    }
                    connected = socket;
                    socket.write("READY\t1\n");
                } else {
                    received += `${line}\n`;
                    const fields = line.split("\t");
                    replies.set(fields[1], fields);
                }
            }
        });
    });
    await new Promise((resolve, reject) => {
        bridge.once("error", reject);
        bridge.listen(0, "127.0.0.1", resolve);
    });
    await mkdir(path.join(directory, "plugins"));
    await copyFile(jar, path.join(directory, "server.jar"));
    await copyFile(
        path.join(output, `crafleet-console-${target.kind}.jar`),
        path.join(directory, "plugins", "console.jar"),
    );
    if (target.kind === "paper") {
        if (target.version === "1.8.8") {
            // Paper 443's embedded S3 URL is gone. Its patch.json pins these exact bytes.
            const original = path.join(output, "servers", "vanilla-1.8.8.jar");
            let bytes;
            try {
                bytes = await readFile(original);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            if (!bytes) {
                const response = await fetch(
                    "https://launcher.mojang.com/v1/objects/5fafba3f58c40dc51b5c3ca72a98f62dfdae1db7/server.jar",
                );
                if (!response.ok)
                    throw new Error(
                        "Could not fetch the original Mojang 1.8.8 JAR",
                    );
                bytes = Buffer.from(await response.arrayBuffer());
            }
            assert.equal(
                sha256(bytes),
                "39aef720dc5309476f56f2e96a516f3dd3041bbbf442cbfd47d63acbd06af31e",
            );
            await writeFile(original, bytes);
            await mkdir(path.join(directory, "cache"));
            await copyFile(
                original,
                path.join(directory, "cache/original.jar"),
            );
        }
        await writeFile(path.join(directory, "eula.txt"), "eula=true\n");
        await writeFile(
            path.join(directory, "server.properties"),
            "server-ip=127.0.0.1\nserver-port=0\nonline-mode=true\nlevel-type=FLAT\ngenerate-structures=false\nview-distance=2\nspawn-protection=0\n",
        );
        await writeFile(
            path.join(directory, "bukkit.yml"),
            "settings:\n  allow-end: false\n",
        );
    } else
        await writeFile(
            path.join(directory, "velocity.toml"),
            'config-version = "2.7"\nbind = "127.0.0.1:0"\nonline-mode = true\nplayer-info-forwarding-mode = "NONE"\n[servers]\nlobby = "127.0.0.1:9"\ntry = ["lobby"]\n[forced-hosts]\n[query]\nenabled = false\n',
        );
    if (target.kind === "velocity")
        await writeFile(
            path.join(directory, "forwarding.secret"),
            `${randomUUID()}\n`,
        );
    const child = spawn(
        java,
        [
            "-Xms128M",
            "-Xmx1024M",
            "-Dterminal.jline=false",
            "-Dterminal.ansi=false",
            "-Dlog4j.skipJansi=true",
            "-jar",
            "server.jar",
            ...(target.kind === "paper"
                ? [
                      /^1\.(?:8|9|10|11|12|13)(?:\.|$)/u.test(target.version)
                          ? "nogui"
                          : "--nogui",
                  ]
                : []),
        ],
        {
            cwd: directory,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                CRAFLEET_CONSOLE_PORT: String(bridge.address().port),
                CRAFLEET_CONSOLE_TOKEN: token,
            },
        },
    );
    child.on("error", (error) => {
        processError = error;
    });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
        logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
        logs += chunk;
    });
    const exit = new Promise((resolve) =>
        child.once("exit", (code) => resolve(code)),
    );
    async function until(predicate, timeout = 180000) {
        const deadline = Date.now() + timeout;
        while (!predicate()) {
            if (processError) throw processError;
            if (child.exitCode !== null || Date.now() > deadline)
                throw new Error(
                    `Server did not reach the expected state: ${directory}\n${logs.slice(-5000)}`,
                );
            await delay(50);
        }
    }
    try {
        await until(() => /Done \([\d.,]+s\)!/u.test(logs));
        if (target.unsupported) {
            await delay(2000);
            assert.equal(
                connected,
                undefined,
                "Unsupported API must not enable completion",
            );
        } else {
            await until(() => connected, 10000);
            for (const prefix of target.kind === "paper"
                ? ["st", "ver"]
                : ["vel", "velocity "]) {
                const id = randomUUID();
                const line = `${prefix} suffix`;
                connected.write(
                    `COMPLETE\t${id}\t${prefix.length}\t${Buffer.from(line).toString("base64")}\n`,
                );
                await until(() => replies.has(id), 5000);
                const fields = replies.get(id);
                assert.equal(fields[0], "RESULT");
                assert.ok(fields.length > 2, `No candidates: ${prefix}`);
                for (const field of fields.slice(2)) {
                    const [start, end, text] = field.split(":");
                    assert.ok(
                        Number(start) >= 0 &&
                            Number(start) <= Number(end) &&
                            Number(end) <= prefix.length,
                    );
                    assert.ok(Buffer.from(text, "base64").length > 0);
                }
                assert.equal(
                    child.exitCode,
                    null,
                    "Completion must never execute stop/shutdown",
                );
            }
            connected.destroy();
            connected = undefined;
            await until(() => connected, 5000);
        }
        child.stdin.write(
            target.kind === "paper" ? "version\n" : "velocity version\n",
        );
        await delay(300);
        assert.equal(
            child.exitCode,
            null,
            "Ordinary command input must remain usable",
        );
        return {
            ...target,
            status: "passed",
            directory,
            addon: manifest.version,
        };
    } finally {
        if (child.exitCode === null)
            child.stdin.write(
                target.kind === "paper" ? "stop\n" : "shutdown\n",
            );
        const ended = await Promise.race([
            exit.then(() => true),
            delay(30000).then(() => false),
        ]);
        if (!ended) {
            child.kill("SIGKILL");
            await exit;
        }
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => bridge.close(resolve));
        await writeFile(path.join(directory, "addon-test.log"), logs);
        await writeFile(path.join(directory, "addon-responses.log"), received);
    }
}
for (const target of targets) {
    if (
        selected &&
        !`${target.kind}-${target.version}-${target.build}`.includes(selected)
    )
        continue;
    const jar = await serverJar(target);
    if (process.argv.includes("--prepare")) continue;
    console.log(
        `Testing ${target.kind} ${target.version} build ${target.build} on Java ${target.java}...`,
    );
    const result = await check(target, jar);
    const previous = results.findIndex(
        (entry) =>
            entry.kind === target.kind &&
            entry.version === target.version &&
            entry.build === target.build,
    );
    if (previous >= 0) results.splice(previous, 1);
    results.push(result);
    await writeFile(
        path.join(output, "runtime-verification.json"),
        `${JSON.stringify(results, null, 2)}\n`,
    );
    console.log(
        `Passed ${target.kind} ${target.version} build ${target.build}.`,
    );
}
