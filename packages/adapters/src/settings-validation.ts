import * as core from "@crafleet/core";
import { runtimeSettings } from "./settings.js";
export function portablePluginJarName(id: string) {
    return core.portablePluginJarName(id, runtimeSettings());
}
export function validatePluginIdentities(
    plugins: Parameters<typeof core.validatePluginIdentities>[0],
    kind: Parameters<typeof core.validatePluginIdentities>[1],
    reservedIds?: readonly string[],
) {
    return core.validatePluginIdentities(
        plugins,
        kind,
        reservedIds,
        runtimeSettings(),
    );
}
export function validatePluginSet(
    plugins: Parameters<typeof core.validatePluginSet>[0],
    kind: Parameters<typeof core.validatePluginSet>[1],
) {
    return core.validatePluginSet(plugins, kind, runtimeSettings());
}
export function validateProject(
    input: Parameters<typeof core.validateProject>[0],
) {
    return core.validateProject(input, runtimeSettings());
}
export function validateConfigState(
    input: Parameters<typeof core.validateConfigState>[0],
) {
    return core.validateConfigState(input, runtimeSettings());
}
export function validateConfigBundle(
    input: Parameters<typeof core.validateConfigBundle>[0],
) {
    return core.validateConfigBundle(input, runtimeSettings());
}
export function configCandidateRules(
    patterns: Parameters<typeof core.configCandidateRules>[0],
) {
    return core.configCandidateRules(patterns, runtimeSettings());
}
export function parseBackupRules(
    patterns: Parameters<typeof core.parseBackupRules>[0],
) {
    return core.parseBackupRules(patterns, runtimeSettings());
}
export function createBackupSelector(
    patterns: Parameters<typeof core.createBackupSelector>[0],
) {
    return core.createBackupSelector(patterns, runtimeSettings());
}
export function mergeConfigText(
    observed: Parameters<typeof core.mergeConfigText>[0],
    base: Parameters<typeof core.mergeConfigText>[1],
    runtime: Parameters<typeof core.mergeConfigText>[2],
) {
    return core.mergeConfigText(observed, base, runtime, runtimeSettings());
}
export function validConsoleText(
    value: Parameters<typeof core.validConsoleText>[0],
) {
    return core.validConsoleText(value, runtimeSettings());
}
export function validCompletionRequest(
    request: Parameters<typeof core.validCompletionRequest>[0],
) {
    return core.validCompletionRequest(request, runtimeSettings());
}
export function validSuggestions(
    value: Parameters<typeof core.validSuggestions>[0],
    request: Parameters<typeof core.validSuggestions>[1],
) {
    return core.validSuggestions(value, request, runtimeSettings());
}
export function reserveAutomaticStart(
    intent: Parameters<typeof core.reserveAutomaticStart>[0],
    now: Parameters<typeof core.reserveAutomaticStart>[1],
) {
    return core.reserveAutomaticStart(intent, now, runtimeSettings());
}
