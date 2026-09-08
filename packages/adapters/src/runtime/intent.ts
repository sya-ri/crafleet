import path from "node:path";
import { CrafleetError, type RuntimeIntent } from "@crafleet/core";
import { type } from "arktype";
import {
    assertNoSymlinks,
    readBoundedRegularFile,
    withMutex,
    writeJson,
} from "../filesystem/io.js";
import {
    ensurePrivateDirectory,
    ensurePrivateFile,
} from "../filesystem/private.js";
import { nearestFile } from "../filesystem/projects.js";
import type { NodeServerController } from "./controller.js";

const IntentSchema = type({
    "+": "reject",
    schemaVersion: "1",
    desired: "'running' | 'stopped'",
    attempts: type("number.integer >= 0").array(),
});

export async function readRuntimeIntent(
    projectDir: string,
): Promise<RuntimeIntent | undefined> {
    const file = await assertNoSymlinks(
        projectDir,
        ".crafleet/runtime-intent.json",
    );
    const invalid = (): never => {
        throw new CrafleetError(
            "RUNTIME_INTENT_INVALID",
            "Runtime intent is unsafe or invalid; automatic start is blocked. Inspect the local state before recovery.",
            4,
        );
    };
    const snapshot = await readBoundedRegularFile(file, {
        maxBytes: 4096,
        failure: invalid,
    });
    if (snapshot === null) return undefined;
    try {
        const result = IntentSchema(
            JSON.parse(snapshot.bytes.toString("utf8")),
        );
        if (
            result instanceof type.errors ||
            result.attempts.length > 5 ||
            result.attempts.some((time) => !Number.isSafeInteger(time))
        )
            return invalid();
        return result;
    } catch {
        return invalid();
    }
}

/** Callers hold the shared operation lock; this state is never part of an installation. */
export async function writeRuntimeIntent(
    projectDir: string,
    desired: RuntimeIntent["desired"],
    attempts: number[] = [],
): Promise<void> {
    await ensurePrivateDirectory(
        await assertNoSymlinks(projectDir, ".crafleet"),
    );
    const file = await assertNoSymlinks(
        projectDir,
        ".crafleet/runtime-intent.json",
    );
    await writeJson(file, { schemaVersion: 1, desired, attempts });
    await ensurePrivateFile(file);
}

/** Derive the same mutex as loadProject without parsing possibly broken YAML. */
export async function runtimeOperationRoot(
    projectDir: string,
): Promise<string> {
    const workspace = await nearestFile(projectDir, "crafleet-workspace.yaml");
    return workspace ? path.dirname(workspace) : projectDir;
}

export async function stopWithIntent(
    controller: NodeServerController,
    force = false,
) {
    const root = await runtimeOperationRoot(controller.projectDir);
    return withMutex(path.join(root, ".crafleet/operation.lock"), async () => {
        await writeRuntimeIntent(controller.projectDir, "stopped");
        return force ? controller.stop(true) : controller.stop();
    });
}
