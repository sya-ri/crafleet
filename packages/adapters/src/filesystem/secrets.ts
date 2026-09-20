import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
    CrafleetError,
    configPointer,
    isConfigRecord,
    type ProjectManifest,
    type SecretReference,
} from "@crafleet/core";
import {
    type ConfigDocument,
    mapConfigStrings,
    parseConfigDocument,
} from "../formats/config.js";
import {
    assertNoSymlinks,
    atomicWrite,
    containedPath,
    readBoundedRegularFile,
} from "./io.js";

import {
    loadManagedServerSecret,
    MANAGEMENT_SECRET_FIELD,
    MANAGEMENT_SECRET_NAME,
    type ManagedServerSecret,
} from "./managed-server-secret.js";

const tokenPattern = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;

interface SecretDocument {
    relative: string;
    document: ConfigDocument;
    locations?: {
        fields: Set<string>;
        tokens: Map<string, Set<string>>;
    };
    validated?: boolean;
}

function secretError(code: string): never {
    const messages: Record<string, string> = {
        SECRET_REFERENCE:
            "A secret reference is invalid; select exactly one environment variable or file.",
        SECRET_UNAVAILABLE:
            "A required secret is unavailable or cannot be read safely.",
        SECRET_AMBIGUOUS:
            "Secret values must be nonempty and distinguishable; ambiguous values cannot be tokenized safely.",
        SECRET_PLAINTEXT:
            "A managed configuration contains a resolved secret. Replace it with a secret token before continuing.",
        SECRET_LOCATION:
            "A secret was changed or moved to an unrecognized location. Resolve the source and runtime configuration manually; no values were captured.",
        SECRET_TOKEN:
            "A secret placeholder is invalid, unresolved, or outside a supported string value.",
    };
    throw new CrafleetError(
        code,
        messages[code] ?? "A secret could not be handled safely.",
        3,
    );
}

/** Resolved values are never part of a pending bundle. */
export class ConfigSecrets {
    private readonly replacements: RegExp | undefined;
    private readonly redactions: RegExp | undefined;
    private readonly namesByValue: Map<string, string>;
    // Keep only the latest document, scoped to this operation's secret values.
    // Runtime reads remain fresh; different bytes or paths must be checked again.
    private parsed: SecretDocument | undefined;

    get hasSecrets(): boolean {
        return this.values.size > 0;
    }

    private managedUsed = false;

    constructor(
        private readonly values: ReadonlyMap<string, string>,
        private readonly managed?: ManagedServerSecret,
    ) {
        this.namesByValue = new Map();
        for (const [name, value] of values) {
            if (!/^[A-Za-z0-9_.-]+$/.test(name))
                secretError("SECRET_REFERENCE");
            if (
                value.length === 0 ||
                value.length > 65_536 ||
                value.includes("\0") ||
                value.includes("${secret:") ||
                this.namesByValue.has(value)
            )
                secretError("SECRET_AMBIGUOUS");
            this.namesByValue.set(value, name);
        }
        if (values.size > 0) {
            const alternatives = [...this.namesByValue.keys()]
                .sort((left, right) => right.length - left.length)
                .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            this.replacements = new RegExp(alternatives.join("|"), "g");
            // Logs may contain partial or JSON-escaped secrets, so redaction is broader than tokenization.
            const fragments = new Set<string>();
            for (const value of values.values()) {
                for (const fragment of [value, ...value.split(/\r\n|\r|\n/)]) {
                    if (!fragment.trim()) continue;
                    fragments.add(fragment);
                    fragments.add(fragment.trim());
                    fragments.add(JSON.stringify(fragment).slice(1, -1));
                    fragments.add(JSON.stringify(fragment.trim()).slice(1, -1));
                }
            }
            this.redactions = fragments.size
                ? new RegExp(
                      [...fragments]
                          .sort((left, right) => right.length - left.length)
                          .map((value) =>
                              value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                          )
                          .join("|"),
                      "g",
                  )
                : undefined;
        }
    }

    async persist(): Promise<void> {
        if (this.managedUsed) await this.managed?.persist();
    }

    private managedLocation(
        relative: string,
        pointer: string,
        name: string,
    ): boolean {
        return (
            this.managed !== undefined &&
            relative === "server.properties" &&
            pointer === `/${MANAGEMENT_SECRET_FIELD}` &&
            name === MANAGEMENT_SECRET_NAME
        );
    }

    redact(value: string): string {
        return this.redactions
            ? value.replace(this.redactions, "[redacted]")
            : value;
    }

    private parse(relative: string, text: string): SecretDocument {
        if (
            this.parsed?.relative === relative &&
            this.parsed.document.text === text
        )
            return this.parsed;
        const entry = {
            relative,
            document: parseConfigDocument(relative, text),
        };
        this.parsed = entry;
        return entry;
    }

    private mask(value: string): string {
        return this.replacements
            ? value.replace(
                  this.replacements,
                  (match) => `\${secret:${this.namesByValue.get(match)}}`,
              )
            : value;
    }

    private withoutTokens(value: string): string {
        return value.replace(tokenPattern, "");
    }

    private names(value: string): string[] {
        const matches = [...value.matchAll(tokenPattern)];
        if (this.withoutTokens(value).includes("${secret:"))
            secretError("SECRET_TOKEN");
        const names = matches.map((match) => match[1] ?? "");
        if (names.some((name) => !this.values.has(name)))
            secretError("SECRET_TOKEN");
        return names;
    }

    private assertKeys(value: unknown): void {
        if (Array.isArray(value)) {
            for (const item of value) this.assertKeys(item);
            return;
        }
        if (!isConfigRecord(value)) return;
        for (const [key, item] of Object.entries(value)) {
            if (key.includes("${secret:") || this.mask(key) !== key)
                secretError("SECRET_LOCATION");
            this.assertKeys(item);
        }
    }

    private assertKnownSecrets(
        relative: string,
        document: ConfigDocument,
    ): void {
        // Known fields from PaperMC's server.properties/global-configuration references;
        // plugin-specific secrets still require explicit registration.
        const normalized = relative.replaceAll("\\", "/").toLowerCase();
        const paths =
            normalized === "server.properties"
                ? [
                      ["rcon.password"],
                      ["management-server-secret"],
                      ["management-server-tls-keystore-password"],
                  ]
                : normalized === "config/paper-global.yml"
                  ? [["proxies", "velocity", "secret"]]
                  : [];
        for (const keys of paths) {
            let value: unknown = document.value;
            for (const key of keys)
                value = isConfigRecord(value) ? value[key] : undefined;
            if (value === undefined || value === null || value === "") continue;
            if (
                typeof value !== "string" ||
                this.withoutTokens(value).trim() !== ""
            )
                secretError("SECRET_PLAINTEXT");
        }
        if (
            normalized === "forwarding.secret" &&
            this.withoutTokens(document.text).trim() !== ""
        )
            secretError("SECRET_PLAINTEXT");
        if (
            /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/.test(
                this.withoutTokens(document.text),
            )
        )
            secretError("SECRET_PLAINTEXT");
    }

    private locations(entry: SecretDocument): {
        fields: Set<string>;
        tokens: Map<string, Set<string>>;
    } {
        if (entry.locations) return entry.locations;
        const { document } = entry;
        const fields = new Set<string>();
        const tokens = new Map<string, Set<string>>();
        let scalarTokens = 0;
        const add = (value: string, pointer: string) => {
            fields.add(pointer);
            const names = this.names(value);
            scalarTokens += names.length;
            if (names.length > 0) tokens.set(pointer, new Set(names));
        };
        if (document.format === "text") {
            for (const [index, line] of document.text
                .split(/\r\n|\r|\n/)
                .entries())
                add(line, `/lines/${index + 1}`);
        } else {
            function recordFields(
                value: unknown,
                parts: (string | number)[] = [],
            ): void {
                const pointer = configPointer(parts);
                fields.add(pointer);
                if (typeof value === "string") add(value, pointer);
                else if (Array.isArray(value))
                    value.forEach((item, index) => {
                        recordFields(item, [...parts, index]);
                    });
                else if (isConfigRecord(value))
                    for (const [key, item] of Object.entries(value))
                        recordFields(item, [...parts, key]);
            }
            recordFields(document.value);
            if (
                [...document.text.matchAll(tokenPattern)].length !==
                scalarTokens
            )
                secretError("SECRET_TOKEN");
        }
        entry.locations = { fields, tokens };
        return entry.locations;
    }

    assertTemplate(relative: string, text: string): void {
        this.assertTemplateDocument(this.parse(relative, text));
    }

    private assertTemplateDocument(entry: SecretDocument): void {
        if (entry.validated) return;
        const { relative, document } = entry;
        this.assertKnownSecrets(relative, document);
        this.assertKeys(document.value);
        mapConfigStrings(document.value, (value) => {
            const publicText = this.withoutTokens(value);
            if (this.mask(publicText) !== publicText)
                secretError("SECRET_PLAINTEXT");
            this.names(value);
            return value;
        });
        const publicText = this.withoutTokens(document.text);
        if (this.mask(publicText) !== publicText)
            secretError("SECRET_PLAINTEXT");
        for (const [pointer, names] of this.locations(entry).tokens) {
            if (names.has(MANAGEMENT_SECRET_NAME) && this.managed) {
                if (
                    !this.managedLocation(
                        relative,
                        pointer,
                        MANAGEMENT_SECRET_NAME,
                    )
                )
                    secretError("SECRET_LOCATION");
                this.managedUsed = true;
            }
        }
        entry.validated = true;
    }

    tokenize(
        relative: string,
        raw: string,
        templates?: readonly string[],
    ): string {
        const entry = this.parse(relative, raw);
        const { document } = entry;
        this.assertKeys(document.value);
        const masked =
            entry.validated && this.locations(entry).tokens.size === 0
                ? raw
                : document.render(
                      mapConfigStrings(document.value, (value) =>
                          this.mask(value),
                      ),
                  );
        const publicText = this.withoutTokens(masked);
        if (this.mask(publicText) !== publicText)
            secretError("SECRET_LOCATION");
        const tokenized = masked === raw ? entry : this.parse(relative, masked);
        this.assertKnownSecrets(relative, tokenized.document);
        const actual = this.locations(tokenized);
        for (const [pointer, names] of actual.tokens) {
            if (names.has(MANAGEMENT_SECRET_NAME) && this.managed) {
                if (
                    !this.managedLocation(
                        relative,
                        pointer,
                        MANAGEMENT_SECRET_NAME,
                    )
                )
                    secretError("SECRET_LOCATION");
                this.managedUsed = true;
            }
        }
        if (templates !== undefined) {
            const expected = new Map<string, Set<string>>();
            for (const template of new Set(templates)) {
                const expectedDocument =
                    template === raw
                        ? entry
                        : template === masked
                          ? tokenized
                          : this.parse(relative, template);
                this.assertTemplateDocument(expectedDocument);
                for (const [pointer, names] of this.locations(expectedDocument)
                    .tokens) {
                    expected.set(
                        pointer,
                        new Set([...(expected.get(pointer) ?? []), ...names]),
                    );
                }
            }
            for (const [pointer, names] of actual.tokens) {
                if (
                    [...names].some(
                        (name) =>
                            !expected.get(pointer)?.has(name) &&
                            !this.managedLocation(relative, pointer, name),
                    )
                )
                    secretError("SECRET_LOCATION");
            }
            for (const [pointer, names] of expected) {
                if (
                    actual.fields.has(pointer) &&
                    [...names].some(
                        (name) => !actual.tokens.get(pointer)?.has(name),
                    )
                )
                    secretError("SECRET_LOCATION");
            }
        }
        return masked;
    }

    inject(relative: string, template: string): string {
        const entry = this.parse(relative, template);
        this.assertTemplateDocument(entry);
        const { document } = entry;
        let value = document.value;
        if (
            this.managed &&
            relative === "server.properties" &&
            isConfigRecord(value) &&
            Object.keys(value).some((key) =>
                key.startsWith("management-server-"),
            ) &&
            (value[MANAGEMENT_SECRET_FIELD] === undefined ||
                value[MANAGEMENT_SECRET_FIELD] === "")
        ) {
            this.managedUsed = true;
            value = {
                ...value,
                [MANAGEMENT_SECRET_FIELD]: `\${secret:${MANAGEMENT_SECRET_NAME}}`,
            };
        } else if (this.locations(entry).tokens.size === 0) return template;
        return document.render(
            mapConfigStrings(value, (value) =>
                value.replace(
                    tokenPattern,
                    (_match, name: string) =>
                        this.values.get(name) ??
                        secretError("SECRET_UNAVAILABLE"),
                ),
            ),
        );
    }
}

export async function loadConfigSecrets(
    projectDir: string,
    references: Readonly<Record<string, SecretReference>> = {},
    environment: NodeJS.ProcessEnv = process.env,
): Promise<ConfigSecrets> {
    const values = new Map<string, string>();
    for (const [name, reference] of Object.entries(references)) {
        if (
            !reference ||
            (reference.env === undefined) === (reference.file === undefined) ||
            Object.keys(reference).some(
                (key) => key !== "env" && key !== "file",
            )
        )
            secretError("SECRET_REFERENCE");
        if (reference.env !== undefined) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.env))
                secretError("SECRET_REFERENCE");
            const value = environment[reference.env];
            if (value === undefined) secretError("SECRET_UNAVAILABLE");
            values.set(name, value);
        } else {
            try {
                if (!reference.file) secretError("SECRET_REFERENCE");
                const file = path.isAbsolute(reference.file)
                    ? reference.file
                    : containedPath(projectDir, reference.file);
                await assertNoSymlinks(path.dirname(file), path.basename(file));
                const stat = await lstat(file);
                if (!stat.isFile() || stat.size > 65_536)
                    secretError("SECRET_UNAVAILABLE");
                const raw = new TextDecoder("utf-8", { fatal: true }).decode(
                    await readFile(file),
                );
                values.set(name, raw.replace(/\r?\n$/, ""));
            } catch {
                secretError("SECRET_UNAVAILABLE");
            }
        }
    }
    const managed = await loadManagedServerSecret(projectDir, values);
    values.set(MANAGEMENT_SECRET_NAME, managed.value);
    return new ConfigSecrets(values, managed);
}

/** Called with the lifecycle lock held and the JVM confirmed stopped. */
export async function prepareManagementServerSecret(
    projectDir: string,
    server: ProjectManifest["server"],
    references: Readonly<Record<string, SecretReference>> = {},
): Promise<void> {
    if (server.type !== "paper") return;
    const file = path.join(projectDir, "runtime/server.properties");
    const failure = (): never => {
        throw new CrafleetError(
            "MANAGED_SECRET_INVALID",
            "Server properties cannot be prepared safely; no secret values were exposed.",
            3,
        );
    };
    const snapshot = await readBoundedRegularFile(file, {
        maxBytes: 4 * 1024 * 1024,
        failure,
    });
    const text = snapshot?.bytes.toString("utf8") ?? "";
    const document = parseConfigDocument("server.properties", text);
    if (!isConfigRecord(document.value)) return;
    const value = document.value[MANAGEMENT_SECRET_FIELD];
    // Preserve explicit credentials and Paper-generated credentials already in runtime.
    if (
        typeof value === "string" &&
        value !== "" &&
        !value.includes("${secret:")
    ) {
        const secrets = await loadConfigSecrets(projectDir, references);
        if (/^[A-Za-z0-9]{40}$/.test(value)) {
            secrets.tokenize(
                "server.properties",
                `${MANAGEMENT_SECRET_FIELD}=${value}\n`,
            );
        }
        await secrets.persist();
        return;
    }
    // The property was introduced in Minecraft 1.21.9. Unknown versions are left alone
    // unless their properties already declare management-server settings.
    const version = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(server.version);
    const supported =
        version &&
        (Number(version[1]) >= 26 ||
            (Number(version[1]) === 1 &&
                (Number(version[2]) > 21 ||
                    (Number(version[2]) === 21 &&
                        Number(version[3] ?? 0) >= 9))));
    if (
        !supported &&
        !Object.keys(document.value).some((key) =>
            key.startsWith("management-server-"),
        )
    )
        return;
    const secrets = await loadConfigSecrets(projectDir, references);
    // Only change this property; unrelated runtime credentials are not capture inputs.
    const template = `${MANAGEMENT_SECRET_FIELD}=${value || `\${secret:${MANAGEMENT_SECRET_NAME}}`}\n`;
    const injected = parseConfigDocument(
        "server.properties",
        secrets.inject("server.properties", template),
    ).value;
    if (!isConfigRecord(injected)) return failure();
    const raw = document.render({
        ...document.value,
        [MANAGEMENT_SECRET_FIELD]: injected[MANAGEMENT_SECRET_FIELD],
    });
    await secrets.persist();
    const current = await readBoundedRegularFile(file, {
        maxBytes: 4 * 1024 * 1024,
        failure,
    });
    if ((current?.bytes.toString("utf8") ?? "") !== text) failure();
    if (raw !== text) await atomicWrite(file, raw);
}
