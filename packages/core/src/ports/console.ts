export interface CommandCompletionRequest {
    line: string;
    cursor: number;
}
export interface CommandSuggestion {
    text: string;
    start: number;
    end: number;
}
export interface ConsoleCapabilities {
    completion: boolean;
    addonVersion?: string;
}
export interface ConsoleController {
    capabilities(): Promise<ConsoleCapabilities>;
    completeCommand(
        request: CommandCompletionRequest,
        signal?: AbortSignal,
    ): Promise<CommandSuggestion[]>;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal controls must never enter command text or suggestions.
const consoleControls = /[\x00-\x1f\x7f-\x9f]/u;
export function validConsoleText(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length <= 8192 &&
        !consoleControls.test(value)
    );
}
export function validCompletionRequest(
    request: CommandCompletionRequest,
): boolean {
    return (
        validConsoleText(request.line) &&
        Number.isInteger(request.cursor) &&
        request.cursor >= 0 &&
        request.cursor <= request.line.length
    );
}
export function validSuggestions(
    value: unknown,
    request: CommandCompletionRequest,
): value is CommandSuggestion[] {
    return (
        Array.isArray(value) &&
        value.length <= 256 &&
        value.every(
            (item) =>
                item !== null &&
                typeof item === "object" &&
                validConsoleText(item.text) &&
                Number.isInteger(item.start) &&
                Number.isInteger(item.end) &&
                item.start >= 0 &&
                item.start <= item.end &&
                item.end <= request.cursor &&
                request.line.length -
                    (item.end - item.start) +
                    item.text.length <=
                    8192,
        )
    );
}
