import type { ProjectContext } from "@crafleet/adapters";
import { CrafleetError } from "@crafleet/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mayOfferConsoleAddon, offerConsoleAddon } from "./addons.js";
import type { CommandContext } from "./context.js";

const mocks = vi.hoisted(() => ({
    inspect: vi.fn(),
    dismissed: vi.fn(),
    dismiss: vi.fn(),
    manage: vi.fn(),
    select: vi.fn(),
}));
vi.mock("@clack/prompts", async (original) => ({
    ...(await original<object>()),
    select: mocks.select,
    isCancel: (value: unknown) => typeof value === "symbol",
}));
vi.mock("@crafleet/adapters", async (original) => ({
    ...(await original<object>()),
    inspectAddon: mocks.inspect,
    consolePromptDismissed: mocks.dismissed,
    dismissConsolePrompt: mocks.dismiss,
    manageAddons: mocks.manage,
}));
const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const project = { dir: "/test/server" } as ProjectContext;
const context = {
    home: "/test/home",
    store: {},
    abort: new AbortController(),
    globals: () => ({}),
    installOptions: () => ({}),
    interaction: async (action: () => Promise<unknown>) => action(),
} as unknown as CommandContext;
const inventory = () => ({
    declared: null,
    active: null,
    pending: null,
    compatibility: { status: "supported" },
});
beforeEach(() => {
    vi.stubEnv("CI", "false");
    Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: true,
    });
    mocks.inspect.mockResolvedValue(inventory());
    mocks.dismissed.mockResolvedValue(false);
    mocks.dismiss.mockResolvedValue(undefined);
    mocks.manage.mockResolvedValue({ noEligibleTargets: false });
    mocks.select.mockResolvedValue("skip");
});
afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
    else Reflect.deleteProperty(process.stderr, "isTTY");
});

describe("console addon invitation", () => {
    it("defaults to Not now without saving or installing", async () => {
        expect(
            await offerConsoleAddon(project, context, new Command()),
        ).toBeUndefined();
        expect(mocks.select).toHaveBeenCalledWith(
            expect.objectContaining({
                initialValue: "skip",
                options: [
                    { value: "install", label: "Install addon" },
                    { value: "skip", label: "Not now" },
                    {
                        value: "dismiss",
                        label: "Don't ask again for this server",
                    },
                ],
            }),
        );
        expect(mocks.dismiss).not.toHaveBeenCalled();
        expect(mocks.manage).not.toHaveBeenCalled();
    });
    it("stores dismissal only for this server and permits a one-time override", async () => {
        mocks.select.mockResolvedValue("dismiss");
        await offerConsoleAddon(project, context, new Command());
        expect(mocks.dismiss).toHaveBeenCalledWith(context.home, project.dir);
        mocks.select.mockClear();
        mocks.dismissed.mockResolvedValue(true);
        await offerConsoleAddon(project, context, new Command());
        expect(mocks.select).not.toHaveBeenCalled();
        await offerConsoleAddon(
            project,
            context,
            new Command().setOptionValue("askAddon", true),
        );
        expect(mocks.select).toHaveBeenCalledOnce();
    });
    it("prepares the same install as the explicit command, without starting a server", async () => {
        mocks.select.mockResolvedValue("install");
        expect(
            await offerConsoleAddon(project, context, new Command()),
        ).toContain("restart");
        expect(mocks.manage).toHaveBeenCalledWith(
            [project],
            context.store,
            "add",
            ["console"],
            {},
        );
        expect(mocks.dismiss).not.toHaveBeenCalled();
    });
    it("continues console attachment after install or preference-save failures", async () => {
        mocks.select.mockResolvedValue("install");
        mocks.manage.mockRejectedValue(new Error("checksum mismatch"));
        expect(
            await offerConsoleAddon(project, context, new Command()),
        ).toContain("checksum mismatch");
        mocks.select.mockResolvedValue("dismiss");
        mocks.dismiss.mockRejectedValue(new Error("read-only home"));
        expect(
            await offerConsoleAddon(project, context, new Command()),
        ).toContain("Could not save");
    });
    it("cancels the console without modifying preferences or installing", async () => {
        mocks.select.mockResolvedValue(Symbol("cancel"));
        await expect(
            offerConsoleAddon(project, context, new Command()),
        ).rejects.toMatchObject({ code: "CANCELLED", exitCode: 130 });
        expect(mocks.dismiss).not.toHaveBeenCalled();
        expect(mocks.manage).not.toHaveBeenCalled();
        mocks.select.mockResolvedValue("install");
        mocks.manage.mockRejectedValue(
            new CrafleetError("CANCELLED", "cancel", 130),
        );
        await expect(
            offerConsoleAddon(project, context, new Command()),
        ).rejects.toMatchObject({ code: "CANCELLED" });
    });
    it.each([
        { declared: "0.1.0" },
        { active: "0.1.0" },
        { pending: "0.1.0" },
        { compatibility: { status: "unsupported" } },
        { compatibility: { status: "unknown" } },
    ])("does not ask when ineligible: %j", async (state) => {
        mocks.inspect.mockResolvedValue({ ...inventory(), ...state });
        await offerConsoleAddon(
            project,
            context,
            new Command().setOptionValue("askAddon", true),
        );
        expect(mocks.select).not.toHaveBeenCalled();
    });
    it("does not ask if local state or preferences cannot be read", async () => {
        mocks.inspect.mockRejectedValueOnce(new Error("damaged state"));
        await offerConsoleAddon(project, context, new Command());
        mocks.dismissed.mockRejectedValueOnce(new Error("damaged preferences"));
        await offerConsoleAddon(project, context, new Command());
        expect(mocks.select).not.toHaveBeenCalled();
    });
    it("suppresses CI, yes, dry-run, JSON, and non-TTY invitations", async () => {
        for (const options of [{ yes: true }, { dryRun: true }, { json: true }])
            expect(mayOfferConsoleAddon(options, "false")).toBe(false);
        expect(mayOfferConsoleAddon({}, "true")).toBe(false);
        expect(mayOfferConsoleAddon({}, "0")).toBe(true);
        Object.defineProperty(process.stderr, "isTTY", {
            configurable: true,
            value: false,
        });
        await offerConsoleAddon(project, context, new Command());
        expect(mocks.select).not.toHaveBeenCalled();
    });
});
