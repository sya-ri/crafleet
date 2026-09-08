import { CrafleetError } from "@crafleet/core";
import { isMap, parseDocument } from "yaml";

/** SnakeYAML accepts unindented continuation lines in a quoted root description. */
function normalizeDescription(content: string): string | undefined {
    const opening = /^description:[\t ]*"/m.exec(content);
    if (!opening) return undefined;
    const prefix = parseDocument(content.slice(0, opening.index), {
        uniqueKeys: true,
    });
    if (
        prefix.errors.length ||
        prefix.warnings.length ||
        !isMap(prefix.contents)
    )
        return undefined;
    const start = opening.index + opening[0].length;
    let end = start;
    for (; end < content.length; end++) {
        if (content[end] === "\\") end++;
        else if (content[end] === '"') break;
    }
    if (end >= content.length) return undefined;
    const scalar = content.slice(start, end);
    if (
        !scalar.includes("\n") ||
        /^(?:---|\.\.\.)(?=[\t \r\n]|$)/m.test(scalar)
    )
        return undefined;
    const tail = content.slice(end + 1).split("\n", 1)[0] ?? "";
    if (!/^(?:[\t ]+(?:#[^\r\n]*)?)?\r?$/.test(tail)) return undefined;
    // Only an in-memory parse view changes. The original descriptor/JAR is never written.
    return (
        content.slice(0, start) +
        scalar.replaceAll("\n", "\n ") +
        content.slice(end)
    );
}

export function parsePluginDescriptorYaml(content: string): unknown {
    let document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length) {
        const normalized = normalizeDescription(content);
        if (normalized !== undefined)
            document = parseDocument(normalized, { uniqueKeys: true });
    }
    if (document.errors.length || document.warnings.length)
        throw new CrafleetError(
            "INVALID_PLUGIN_DESCRIPTOR",
            "The plugin descriptor is not valid YAML.",
            3,
        );
    try {
        return document.toJS({ maxAliasCount: 0 });
    } catch {
        throw new CrafleetError(
            "INVALID_PLUGIN_DESCRIPTOR",
            "YAML aliases are not accepted in plugin descriptors.",
            3,
        );
    }
}
