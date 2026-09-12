import { createHash } from "node:crypto";
import path from "node:path";
import { CrafleetError, type Diagnostic } from "@crafleet/core";
import type { CompletionTarget } from "./completion-host.js";
import {
    atomicCreate,
    atomicWrite,
    type BoundedFileSnapshot,
    readBoundedRegularFile,
} from "./io.js";

const start = "# >>> crafleet completion >>>";
const end = "# <<< crafleet completion <<<";
const scriptHeader = "# crafleet managed completion sha256:";
const maxBytes = 1024 * 1024;
const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
const canonical = (value: string) => value.replaceAll("\r\n", "\n");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface CompletionSetupPlan {
    shell: CompletionTarget["shell"];
    files: {
        path: string;
        action: "create" | "update" | "unchanged" | "blocked";
        content: string;
    }[];
    diagnostic: Diagnostic;
    canApply: boolean;
    reload: string;
}

interface PlannedFile {
    path: string;
    before: BoundedFileSnapshot | null;
    after: Buffer;
}
// Profile snapshots never enter a JSON result or a confirmation preview.
const pending = new WeakMap<CompletionSetupPlan, PlannedFile[]>();

function problem(message: string): never {
    throw new CrafleetError(
        "COMPLETION_CONFIG",
        message,
        3,
        "Review the completion settings manually, then retry crafleet completion install. Existing custom settings are not replaced.",
    );
}

async function snapshot(file: string): Promise<BoundedFileSnapshot | null> {
    return readBoundedRegularFile(file, {
        maxBytes,
        failure: () =>
            problem(
                "A completion settings file is unreadable, unsafe, or too large.",
            ),
    });
}

function decode(bytes: Buffer): {
    text: string;
    encode: (value: string) => Buffer;
} {
    const le = bytes[0] === 0xff && bytes[1] === 0xfe;
    const be = bytes[0] === 0xfe && bytes[1] === 0xff;
    const utf8Bom = bytes
        .subarray(0, 3)
        .equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const bom = bytes.subarray(0, le || be ? 2 : utf8Bom ? 3 : 0);
    const payload = Buffer.from(bytes.subarray(bom.length));
    if ((le || be) && payload.length % 2)
        problem("A completion settings file has an unsupported encoding.");
    if (be) payload.swap16();
    const text = payload.toString(le || be ? "utf16le" : "utf8");
    const encode = (value: string) => {
        const encoded = Buffer.from(value, le || be ? "utf16le" : "utf8");
        return Buffer.concat([bom, be ? encoded.swap16() : encoded]);
    };
    if (!encode(text).equals(bytes) || text.includes("\0"))
        problem("A completion settings file has an unsupported encoding.");
    return { text, encode };
}

function loadingBody(target: CompletionTarget): string {
    const file = quote(target.scriptPath);
    if (target.shell === "powershell") {
        // An ASCII loader preserves Windows PowerShell's BOM-less ANSI profiles.
        const literal = [...target.scriptPath].some(
            (character) => character.charCodeAt(0) > 127,
        )
            ? `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(target.scriptPath).toString("base64")}')))`
            : psQuote(target.scriptPath);
        return `if (Test-Path -LiteralPath ${literal}) {\n    . ${literal}\n}`;
    }
    if (target.shell === "zsh")
        return `if [[ -o interactive && -r ${file} ]]; then\n    if (( ! $+functions[compdef] )); then\n        autoload -Uz compinit\n        compinit\n    fi\n    if (( $+functions[compdef] )); then\n        source ${file}\n    fi\nfi`;
    return `if [ -n "\${BASH_VERSION-}" ]; then\n    case $- in\n        *i*) [ ! -r ${file} ] || . ${file} ;;\n    esac\nfi`;
}

function profileContent(
    text: string,
    body: string,
): { text: string; preview: string } {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const block =
        `${start}\n# sha256:${digest(body)}\n${body}\n${end}`.replaceAll(
            "\n",
            newline,
        );
    const begins = [...text.matchAll(/^# >>> crafleet completion >>>\r?$/gmu)];
    const ends = [...text.matchAll(/^# <<< crafleet completion <<<\r?$/gmu)];
    if (begins.length > 1 || ends.length > 1 || begins.length !== ends.length)
        problem("The managed completion block is damaged or duplicated.");
    const begin = begins[0]?.index;
    const finish = ends[0]?.index;
    let outside = text;
    if (begin !== undefined && finish !== undefined) {
        if (finish < begin) problem("The managed completion block is damaged.");
        const old = canonical(text.slice(begin, finish + end.length));
        const match =
            /^# >>> crafleet completion >>>\n# sha256:([a-f0-9]{64})\n([\s\S]*)\n# <<< crafleet completion <<<$/.exec(
                old,
            );
        if (!match || digest(match[2] ?? "") !== match[1])
            problem("The managed completion block was edited manually.");
        outside = text.slice(0, begin) + text.slice(finish + end.length);
    } else if (
        text.includes("crafleet completion >>>") ||
        text.includes("crafleet completion <<<")
    )
        problem("The managed completion block is damaged.");
    // Do not evaluate arbitrary startup code to determine whether it is active.
    if (
        outside
            .split(/\r?\n/u)
            .some(
                (line) =>
                    !/^\s*#/u.test(line) &&
                    /crafleet.*(?:completion|__complete)|(?:source|\.|complete|Register-ArgumentCompleter).*crafleet|_crafleet_complete/iu.test(
                        line,
                    ),
            )
    )
        problem(
            "Manual completion settings were found; their loading behavior could not be verified.",
        );
    return {
        text:
            begin !== undefined && finish !== undefined
                ? text.slice(0, begin) + block + text.slice(finish + end.length)
                : text +
                  (text && !text.endsWith("\n") ? newline : "") +
                  block +
                  newline,
        preview: block,
    };
}

export async function planCompletionSetup(
    target: CompletionTarget,
    script: string,
): Promise<CompletionSetupPlan> {
    const plan: CompletionSetupPlan = {
        shell: target.shell,
        files: [],
        canApply: true,
        diagnostic: {
            id: `completion.${target.shell}`,
            status: "pass",
            message: `${target.shell} completion is configured for future shell sessions.`,
        },
        reload:
            target.shell === "powershell"
                ? `. ${psQuote(target.scriptPath)}`
                : target.shell === "zsh"
                  ? `autoload -Uz compinit; compinit; source ${quote(target.scriptPath)}`
                  : `source ${quote(target.scriptPath)}`,
    };
    const files: PlannedFile[] = [];
    const desiredScript = `${canonical(script).trimEnd()}\n`;
    const managedScript = `${scriptHeader}${digest(desiredScript)}\n${desiredScript}`;
    for (const file of [target.scriptPath, ...target.profiles]) {
        try {
            if (
                !path.isAbsolute(file) ||
                [...file].some(
                    (character) =>
                        character.charCodeAt(0) < 32 ||
                        character.charCodeAt(0) === 127,
                )
            )
                problem("A completion settings path is invalid.");
            const before = await snapshot(file);
            const decoded = decode(before?.bytes ?? Buffer.alloc(0));
            let after: string;
            let preview: string;
            if (file === target.scriptPath) {
                const old = canonical(decoded.text);
                const match =
                    /^# crafleet managed completion sha256:([a-f0-9]{64})\n([\s\S]*)$/u.exec(
                        old,
                    );
                if (before && (!match || digest(match[2] ?? "") !== match[1]))
                    problem(
                        "An existing completion script is not managed by this installer or was edited manually.",
                    );
                after = managedScript.replaceAll(
                    "\n",
                    decoded.text.includes("\r\n") ? "\r\n" : "\n",
                );
                preview = after;
            } else {
                const next = profileContent(decoded.text, loadingBody(target));
                after = next.text;
                preview = next.preview;
            }
            const bytes = decoded.encode(after);
            if (bytes.length > maxBytes)
                problem(
                    "A completion settings file would exceed the supported size.",
                );
            const action = before?.bytes.equals(bytes)
                ? "unchanged"
                : before
                  ? "update"
                  : "create";
            plan.files.push({
                path: file,
                action,
                content: action === "unchanged" ? "" : preview,
            });
            files.push({ path: file, before, after: bytes });
        } catch (error) {
            plan.canApply = false;
            plan.files.push({ path: file, action: "blocked", content: "" });
            plan.diagnostic = {
                id: `completion.${target.shell}`,
                status: "unknown",
                message:
                    error instanceof CrafleetError
                        ? error.message
                        : "Completion settings could not be inspected.",
                hint: "Review the listed settings files manually. No custom settings will be overwritten.",
            };
        }
    }
    if (plan.canApply && plan.files.some((file) => file.action !== "unchanged"))
        plan.diagnostic = {
            id: `completion.${target.shell}`,
            status: "warn",
            message: `${target.shell} completion is missing, incomplete, or needs an update.`,
            hint: `Run crafleet completion install ${target.shell} to review and apply the setup.`,
        };
    if (plan.diagnostic.status === "pass")
        plan.diagnostic.hint = `Open a new shell, or load it in this terminal: ${plan.reload}. The current shell's loaded state was not inspected.`;
    pending.set(plan, files);
    return plan;
}

async function assertUnchanged(file: PlannedFile): Promise<void> {
    const current = await snapshot(file.path);
    const expected = file.before;
    if (current === null && expected === null) return;
    if (
        !current ||
        !expected ||
        !current.bytes.equals(expected.bytes) ||
        current.stats.ino !== expected.stats.ino ||
        current.stats.dev !== expected.stats.dev ||
        current.stats.mtimeNs !== expected.stats.mtimeNs ||
        current.stats.ctimeNs !== expected.stats.ctimeNs
    )
        throw new CrafleetError(
            "COMPLETION_CHANGED",
            "Completion settings changed after the preview; remaining files were not written.",
            3,
            "Run crafleet completion install again to review a fresh plan.",
        );
}

export async function applyCompletionSetup(
    plan: CompletionSetupPlan,
    signal?: AbortSignal,
): Promise<void> {
    const files = pending.get(plan);
    if (!files || !plan.canApply)
        problem("The completion setup plan cannot be applied.");
    signal?.throwIfAborted();
    // Check every file before making the first change, then check again at each write.
    for (const file of files) await assertUnchanged(file);
    for (const file of files) {
        if (file.before?.bytes.equals(file.after)) continue;
        signal?.throwIfAborted();
        await assertUnchanged(file);
        try {
            if (file.before)
                await atomicWrite(
                    file.path,
                    file.after,
                    Number(file.before.stats.mode & 0o777n),
                );
            else await atomicCreate(file.path, file.after);
        } catch (error) {
            if (error instanceof CrafleetError) throw error;
            throw new CrafleetError(
                "COMPLETION_WRITE",
                "Completion setup could not write a settings file; some earlier files may already be configured.",
                3,
                "Check file permissions and run crafleet completion install again to inspect the remaining changes.",
            );
        }
    }
    pending.delete(plan);
}
