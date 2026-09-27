import { AsyncLocalStorage } from "node:async_hooks";
import {
    DEFAULT_SETTINGS,
    DEPRECATED_SETTINGS,
    type ResolvedSettings,
    type RuntimeSettings,
    resolveSettings,
    SETTINGS,
    type SettingKey,
    type SettingsOverrides,
    settingEnvironmentName,
    settingLimit,
    validateSetting,
} from "@crafleet/core";

export interface SettingsInputs {
    signal?: AbortSignal;
    environment: SettingsOverrides;
    cli: SettingsOverrides;
    deprecated: string[];
    defaults: SettingsOverrides;
}
interface SettingsScope {
    resolved: ResolvedSettings;
    inputs: SettingsInputs;
    warned: Set<string>;
    warn?: (message: string) => void;
}
const storage = new AsyncLocalStorage<SettingsScope>();
const defaultResolved = resolveSettings([]);
const environmentNames = new Map(
    Object.keys(SETTINGS).map((key) => [
        settingEnvironmentName(key as SettingKey),
        key as SettingKey,
    ]),
);
/** Event emitters may originate outside the operation's asynchronous context. */
export const bindRuntimeSettings = AsyncLocalStorage.bind;
export function runtimeSettings(): RuntimeSettings {
    return storage.getStore()?.resolved.values ?? DEFAULT_SETTINGS;
}
export function runtimeLimit(key: SettingKey): number {
    return settingLimit(runtimeSettings(), key);
}
export function runtimeValue(key: SettingKey): number {
    return runtimeSettings()[key];
}
export function settingsInputs(): SettingsInputs {
    return (
        storage.getStore()?.inputs ?? {
            environment: {},
            cli: {},
            defaults: {},
            deprecated: [],
        }
    );
}
export function runtimeSignal(): AbortSignal | undefined {
    return storage.getStore()?.inputs.signal;
}
export function resolveEnvironmentSettings(
    environment: Readonly<Record<string, string | undefined>>,
    cli: SettingsOverrides = {},
): SettingsInputs {
    const values: SettingsOverrides = {};
    const deprecated: string[] = [];
    const old = environment.PI_TUI_ESC_TIMEOUT;
    if (old !== undefined) {
        deprecated.push("PI_TUI_ESC_TIMEOUT");
        const value = Number(old);
        if (Number.isFinite(value) && value > 0)
            values["console.escapeTimeoutMs"] = validateSetting(
                "console.escapeTimeoutMs",
                Math.ceil(value),
            );
    }
    for (const [name, value] of Object.entries(environment)) {
        if (!name.startsWith("CRAFLEET_SETTINGS_") || value === undefined)
            continue;
        const key = environmentNames.get(name);
        if (!key) validateSetting(name, undefined);
        if (key)
            values[key] = validateSetting(
                key,
                /^-?\d+$/u.test(value) ? Number(value) : undefined,
            );
    }
    return {
        environment: values,
        cli,
        deprecated,
        defaults:
            environment.SSH_CONNECTION || environment.SSH_TTY
                ? { "console.escapeTimeoutMs": 100 }
                : {},
    };
}
export function resolveRuntimeSettings(
    workspace: SettingsOverrides = {},
    project: SettingsOverrides = {},
    deprecated: readonly string[] = [],
    inputs = settingsInputs(),
): ResolvedSettings {
    return resolveSettings(
        [
            { source: "default", values: inputs.defaults },
            { source: "workspace", values: workspace },
            { source: "project", values: project },
            { source: "environment", values: inputs.environment },
            { source: "cli", values: inputs.cli },
        ],
        [...inputs.deprecated, ...deprecated],
    );
}
export function withRuntimeSettings<T>(
    resolved: ResolvedSettings,
    action: () => T,
    inputs = settingsInputs(),
    warn?: (message: string) => void,
): T {
    const parent = storage.getStore();
    if (parent?.resolved === resolved && parent.inputs === inputs && !warn)
        return action();
    const warning = warn ?? parent?.warn;
    const scope: SettingsScope = {
        resolved,
        inputs,
        warned: parent?.warned ?? new Set(),
        ...(warning ? { warn: warning } : {}),
    };
    return storage.run(scope, () => {
        for (const key of resolved.deprecated) {
            if (!scope.warn || scope.warned.has(key)) continue;
            scope.warned.add(key);
            const replacement =
                DEPRECATED_SETTINGS[key as keyof typeof DEPRECATED_SETTINGS];
            scope.warn(
                `Warning: ${key} is deprecated. Use settings.${replacement} or ${settingEnvironmentName(replacement)}. It will be removed in a future release; the removal version is not yet scheduled. 将来のリリースで削除予定。具体的な削除バージョンは未定。\n`,
            );
        }
        return action();
    });
}
/** An explicit operation snapshot isolates concurrent projects and nested asynchronous I/O. */
export function captureRuntimeSettings(): ResolvedSettings {
    return storage.getStore()?.resolved ?? defaultResolved;
}
export function runtimeTimeoutSignal(
    key: SettingKey,
    signal?: AbortSignal,
): AbortSignal {
    const value = runtimeValue(key);
    if (value === -1) return signal ?? new AbortController().signal;
    const timeout = AbortSignal.timeout(value);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export function runtimeTimeout(key: SettingKey): number {
    const value = runtimeValue(key);
    return value === -1 ? 0 : value;
}
export function withSettingsMethods<T extends object>(
    target: T,
    resolved: ResolvedSettings,
): T {
    // Bind each service instance, including inherited methods, to its operation snapshot.
    const inputs = settingsInputs();
    const seen = new Set<PropertyKey>();
    for (
        let prototype = Object.getPrototypeOf(target);
        prototype && prototype !== Object.prototype;
        prototype = Object.getPrototypeOf(prototype)
    ) {
        for (const key of Reflect.ownKeys(prototype)) {
            if (key === "constructor" || seen.has(key)) continue;
            seen.add(key);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
            if (!descriptor || typeof descriptor.value !== "function") continue;
            const method = descriptor.value;
            Object.defineProperty(target, key, {
                ...descriptor,
                value: new Proxy(method, {
                    apply(original, receiver, args) {
                        return withRuntimeSettings(
                            resolved,
                            () => Reflect.apply(original, receiver, args),
                            inputs,
                        );
                    },
                }),
            });
        }
    }
    return target;
}
