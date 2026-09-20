export function isCiEnvironment(value: string | undefined): boolean {
    if (value === undefined) return false;
    const normalized = value.trim().toLowerCase();
    return !["", "0", "false", "no", "off"].includes(normalized);
}

/** Preserve layout while preventing untrusted text from controlling a terminal. */
export function sanitizeTerminalOutput(value: string): string {
    return value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, (character) =>
        character === "\n" || character === "\t" ? character : "?",
    );
}

/** Sanitize untrusted text for a bounded, single-line diagnostic field. */
export function sanitizeInlineTerminalOutput(value: string): string {
    const sanitized = sanitizeTerminalOutput(value).replace(
        /[\n\t\u2028\u2029]/gu,
        "?",
    );
    const characters = [...sanitized];
    return characters.length > 240
        ? `${characters.slice(0, 237).join("")}...`
        : sanitized;
}
