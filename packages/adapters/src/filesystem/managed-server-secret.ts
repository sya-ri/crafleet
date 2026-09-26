import { randomInt } from "node:crypto";
import path from "node:path";
import { CrafleetError, isConfigRecord } from "@crafleet/core";
import { parseConfigDocument } from "../formats/config.js";
import { runtimeLimit } from "../settings.js";
import { atomicCreate, readBoundedRegularFile } from "./io.js";
import {
    assertPrivateFile,
    ensurePrivateDirectory,
    ensurePrivateFile,
} from "./private.js";

export const MANAGEMENT_SECRET_NAME = "crafleet.management-server";
export const MANAGEMENT_SECRET_FIELD = "management-server-secret";
export const MANAGEMENT_SECRET_FILE = ".crafleet/secrets/management-server.txt";
const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function invalid(): never {
    throw new CrafleetError(
        "MANAGED_SECRET_INVALID",
        "The managed server secret is unsafe, invalid, or changed. No secret values were exposed or replaced.",
        3,
        "Preserve the existing secret and inspect its private file and runtime property locally.",
    );
}

export interface ManagedServerSecret {
    value: string;
    persist(): Promise<void>;
}

async function readStored(file: string): Promise<string | undefined> {
    const snapshot = await readBoundedRegularFile(file, {
        maxBytes: 128,
        failure: invalid,
    });
    if (!snapshot) return undefined;
    await assertPrivateFile(file);
    const value = snapshot.bytes.toString("utf8").replace(/\r?\n$/, "");
    if (!/^[A-Za-z0-9]{40}$/.test(value)) invalid();
    return value;
}

/** Reads and previews never create files. Publication happens before a managed write. */
export async function loadManagedServerSecret(
    projectDir: string,
    explicitValues: ReadonlyMap<string, string>,
): Promise<ManagedServerSecret> {
    if (explicitValues.has(MANAGEMENT_SECRET_NAME)) invalid();
    const file = path.join(projectDir, MANAGEMENT_SECRET_FILE);
    const stored = await readStored(file);
    const snapshot = await readBoundedRegularFile(
        path.join(projectDir, "runtime/server.properties"),
        {
            maxBytes: runtimeLimit("files.maxTextBytes"),
            failure: invalid,
        },
    );
    const document = snapshot
        ? parseConfigDocument(
              "server.properties",
              snapshot.bytes.toString("utf8"),
          )
        : undefined;
    const raw =
        document && isConfigRecord(document.value)
            ? document.value[MANAGEMENT_SECRET_FIELD]
            : undefined;
    const registered =
        typeof raw === "string" && [...explicitValues.values()].includes(raw);
    const runtime =
        typeof raw === "string" && /^[A-Za-z0-9]{40}$/.test(raw) && !registered
            ? raw
            : undefined;
    if (stored !== undefined && runtime !== undefined && stored !== runtime)
        invalid();
    const value =
        stored ??
        runtime ??
        Array.from(
            { length: 40 },
            () => alphabet[randomInt(alphabet.length)],
        ).join("");
    return {
        value,
        async persist() {
            const current = await readStored(file);
            if (current !== undefined) {
                if (current !== value) invalid();
                return;
            }
            // The directory protects the new file before its own ACL is finalized.
            await ensurePrivateDirectory(path.dirname(file));
            try {
                await atomicCreate(file, `${value}\n`, 0o600);
                await ensurePrivateFile(file);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                    throw error;
            }
            if ((await readStored(file)) !== value) invalid();
        },
    };
}
