import picomatch from "picomatch";
import { CrafleetError } from "./errors.js";

export interface ConfigCandidateRule {
    include: boolean;
    root: string;
    maxDirectoryDepth: number;
    matches: (relative: string) => boolean;
}

function invalidPattern(): never {
    throw new CrafleetError(
        "CONFIG_PATTERNS",
        "Configuration candidate rules must be runtime-relative file globs using *, **, ?, or character classes, with optional ! exclusions. Absolute paths, parent traversal, braces and regular expressions are not supported.",
        2,
    );
}

/** Compile ordered rules without allowing discovery outside the runtime tree. */
export function configCandidateRules(
    patterns: readonly string[],
): ConfigCandidateRule[] {
    if (patterns.length > 512) invalidPattern();
    return patterns.map((value) => {
        if (!value || value.length > 4096 || value.startsWith("!!"))
            invalidPattern();
        const include = !value.startsWith("!");
        const pattern = (include ? value : value.slice(1))
            .replaceAll("\\", "/")
            .replace(/^\.\//u, "");
        const segments = pattern.split("/");
        if (
            /[:{}()|]/u.test(pattern) ||
            [...pattern].some(
                (character) =>
                    character.charCodeAt(0) < 32 ||
                    character.charCodeAt(0) === 127,
            ) ||
            segments.some((segment) => ["", ".", ".."].includes(segment))
        )
            invalidPattern();
        const magic = segments.findIndex((segment) => /[*?[]/u.test(segment));
        const root = segments
            .slice(0, magic === -1 ? segments.length - 1 : magic)
            .join("/");
        try {
            return {
                include,
                root,
                maxDirectoryDepth: segments.includes("**")
                    ? Number.POSITIVE_INFINITY
                    : segments.length - 1,
                matches: picomatch(pattern, {
                    dot: true,
                    nocase: false,
                    nonegate: true,
                    noextglob: true,
                    nobrace: true,
                    strictBrackets: true,
                    maxLength: 4096,
                }),
            };
        } catch {
            return invalidPattern();
        }
    });
}

export function selectConfigCandidate(
    relative: string,
    rules: readonly ConfigCandidateRule[],
    included = false,
): boolean {
    for (const rule of rules)
        if (rule.matches(relative)) included = rule.include;
    return included;
}
