// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal secret-token fixtures.
import { describe, expect, it, vi } from "vitest";
import { parseConfigDocument } from "../formats/config.js";
import { FileSecrets } from "./file-content.js";
import { ConfigSecrets, loadConfigSecrets } from "./secrets.js";

const password = 'fixture:p@ss\\word"\nnext';

describe("configuration secret handling", () => {
    it("reuses public-file validation across files without bypassing protected locations", () => {
        const secrets = new ConfigSecrets(new Map([["AUTH", "fixture-value"]]));
        const files = new FileSecrets(secrets);
        const tokenize = vi.spyOn(secrets, "tokenize");
        const inject = vi.spyOn(secrets, "inject");
        const publicText = '# authored\r\nvalue: "public"\r\n';
        for (const name of ["a.yml", "b.yml", "c.yml"])
            files.assertTemplate(name, publicText);
        expect(files.inject("a.yml", publicText)).toBe(publicText);
        expect(files.tokenize("a.yml", publicText, [publicText])).toBe(
            publicText,
        );
        expect(inject).not.toHaveBeenCalled();
        expect(tokenize).not.toHaveBeenCalled();
        expect(() =>
            files.tokenize("a.yml", publicText, ['value: "${secret:AUTH}"\n']),
        ).toThrow("unrecognized location");
        expect(
            files.tokenize("a.yml", publicText, [
                'removed: "${secret:AUTH}"\n',
            ]),
        ).toBe(publicText);
        expect(() =>
            files.tokenize("a.yml", publicText, ["value: [invalid\n"]),
        ).toThrow();
        expect(() =>
            files.tokenize("a.yml", 'value: "fixture-value"\n', [publicText]),
        ).toThrow("unrecognized location");
    });

    it("validates encoded placeholders, credentials and fresh bytes before public injection", () => {
        const files = new FileSecrets(
            new ConfigSecrets(new Map([["AUTH", "fixture-value"]])),
        );
        const publicText = '{"value":"public"}';
        files.assertTemplate("a.json", publicText);
        expect(files.inject("a.json", publicText)).toBe(publicText);
        for (const text of [
            String.raw`{"value":"\u0024{secret:AUTH}"}`,
            String.raw`{"value":"fixture-\u0076alue"}`,
            '{"value":1,"value":2}',
        ])
            expect(() => files.inject("a.json", text)).toThrow();
        expect(files.inject("a.json", '{"value":"${secret:AUTH}"}')).toContain(
            "fixture-value",
        );
        files.assertTemplate("plugin.txt", "value: [invalid\n");
        expect(() => files.inject("plugin.yml", "value: [invalid\n")).toThrow();
        for (const value of ["null", "false", "42", "{}", "[]", '"public"']) {
            const raw = `{"password":${value}}`;
            files.assertTemplate("a.json", raw);
            expect(() =>
                files.tokenize("a.json", raw, [
                    '{"password":"${secret:AUTH}"}',
                ]),
            ).toThrow("unrecognized location");
        }
    });
    it("checks fresh bytes, format and path after successful validation", () => {
        const secrets = new ConfigSecrets(new Map([["AUTH", "fixture-value"]]));
        const publicText = '{"value":"public"}';
        secrets.assertTemplate("settings.json", publicText);
        expect(secrets.inject("settings.json", publicText)).toBe(publicText);
        expect(() =>
            secrets.inject("settings.json", '{"value":"fixture-\\u0076alue"}'),
        ).toThrow("resolved secret");
        expect(() =>
            secrets.inject("settings.json", '{"value":1,"value":2}'),
        ).toThrow("cannot be parsed safely");

        const property = "rcon.password=unregistered\n";
        secrets.assertTemplate("plugin.properties", property);
        expect(() => secrets.inject("server.properties", property)).toThrow(
            "resolved secret",
        );
        secrets.assertTemplate("plugin.txt", "value: [\n");
        expect(() => secrets.inject("plugin.yml", "value: [\n")).toThrow(
            "cannot be parsed safely",
        );
    });

    it("does not remember failed validation or share results across secret sets", () => {
        const missing = new ConfigSecrets(new Map());
        const template = 'value: "${secret:AUTH}"\n';
        for (let attempt = 0; attempt < 2; attempt++)
            expect(() => missing.inject("a.yml", template)).toThrow(
                "placeholder",
            );
        for (const value of ["first-value", "second-value"]) {
            const secrets = new ConfigSecrets(new Map([["AUTH", value]]));
            secrets.assertTemplate("a.yml", template);
            const raw = secrets.inject("a.yml", template);
            expect(raw).toContain(value);
            expect(secrets.inject("a.yml", template)).toBe(raw);
            expect(secrets.tokenize("a.yml", raw, [template, template])).toBe(
                template,
            );
            expect(() => secrets.tokenize("a.yml", raw, [])).toThrow(
                "unrecognized location",
            );
            expect(secrets.tokenize("a.yml", raw, [template])).toBe(template);
        }
    });

    it.each(["false", "null", "42", "{}", "[]", '"public"'])(
        "rejects a protected field replaced with %s after warming public validation",
        (replacement) => {
            const secrets = new ConfigSecrets(
                new Map([["AUTH", "fixture-value"]]),
            );
            const raw = `{"password":${replacement}}`;
            secrets.assertTemplate("a.json", raw);
            expect(secrets.inject("a.json", raw)).toBe(raw);
            expect(() =>
                secrets.tokenize("a.json", raw, [
                    '{"password":"${secret:AUTH}"}',
                ]),
            ).toThrow("unrecognized location");
        },
    );

    it("keeps YAML rendering isolated when cached documents are reused", () => {
        const secrets = new ConfigSecrets(new Map([["AUTH", "fixture-value"]]));
        const template = '# preserve\r\nvalue: "${secret:AUTH}" # note\r\n';
        secrets.assertTemplate("a.yml", template);
        const raw = secrets.inject("a.yml", template);
        expect(raw).toBe('# preserve\r\nvalue: "fixture-value" # note\r\n');
        expect(secrets.inject("a.yml", template)).toBe(raw);
        expect(secrets.tokenize("a.yml", raw, [template])).toBe(template);
        expect(secrets.inject("a.yml", template)).toBe(raw);
    });

    it("reuses only successful tokenization with identical allowed locations", () => {
        const secrets = new ConfigSecrets(new Map([["AUTH", "fixture-value"]]));
        const spy = vi.spyOn(secrets, "tokenize");
        const files = new FileSecrets(secrets);
        const text = '{"password":"fixture-value"}';
        const template = '{"password":"${secret:AUTH}"}';
        expect(files.tokenize("a.json", text, [template])).toContain(
            "${secret:AUTH}",
        );
        files.tokenize("a.json", text, [template]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(() => files.tokenize("a.json", text, [])).toThrow(
            "unrecognized location",
        );
        expect(() => files.tokenize("a.json", text, [])).toThrow(
            "unrecognized location",
        );
        expect(spy).toHaveBeenCalledTimes(3);
        expect(() =>
            files.tokenize("a.json", '{"password":"changed"}', [template]),
        ).toThrow("unrecognized location");
        files.tokenize("b.json", text, [template]);
        expect(spy).toHaveBeenCalledTimes(5);
        const independent = new FileSecrets(
            new ConfigSecrets(new Map([["AUTH", "another-value"]])),
        );
        expect(() => independent.tokenize("a.json", text, [template])).toThrow(
            "unrecognized location",
        );
    });
    it.each([
        ["settings.json", '{"password":"${secret:AUTH}","public":"ok"}\n'],
        ["settings.yml", 'password: "${secret:AUTH}" # keep\npublic: ok\n'],
        ["settings.toml", 'password = "${secret:AUTH}"\npublic = "ok"\n'],
        ["server.properties", "password=${secret:AUTH}\npublic=ok\n"],
    ])(
        "round-trips secrets through format-aware escaping in %s",
        (relative, template) => {
            const secrets = new ConfigSecrets(new Map([["AUTH", password]]));
            const injected = secrets.inject(relative, template);
            expect(parseConfigDocument(relative, injected).value).toMatchObject(
                { password, public: "ok" },
            );
            const tokenized = secrets.tokenize(relative, injected, [template]);
            expect(
                parseConfigDocument(relative, tokenized).value,
            ).toMatchObject({ password: "${secret:AUTH}", public: "ok" });
            expect(tokenized).not.toContain(password);
            expect(() =>
                secrets.assertTemplate(relative, tokenized),
            ).not.toThrow();
        },
    );

    it("blocks moved secrets and changed values at protected fields", () => {
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "fixture-password"]]),
        );
        const template = '{"database":{"password":"${secret:AUTH}"}}';
        expect(() =>
            secrets.tokenize("a.json", '{"elsewhere":"fixture-password"}', [
                template,
            ]),
        ).toThrow("unrecognized location");
        expect(() =>
            secrets.tokenize(
                "a.json",
                '{"database":{"password":"an-unknown-value"}}',
                [template],
            ),
        ).toThrow("unrecognized location");
        expect(() =>
            secrets.tokenize("a.json", '{"database":{"password":false}}', [
                template,
            ]),
        ).toThrow("unrecognized location");
        expect(secrets.tokenize("a.json", "{}", [template])).toBe("{}");
        expect(
            secrets.tokenize("a.json", '{"elsewhere":"fixture-password"}', [
                template,
                '{"elsewhere":"${secret:AUTH}"}',
            ]),
        ).toContain("${secret:AUTH}");
    });

    it("allows initial capture of known values and protects inline references", () => {
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "fixture-password"]]),
        );
        const captured = secrets.tokenize(
            "a.json",
            '{"url":"prefix:fixture-password:suffix"}',
        );
        expect(captured).toContain("prefix:${secret:AUTH}:suffix");
        expect(secrets.inject("a.json", captured)).toContain(
            "prefix:fixture-password:suffix",
        );
        expect(() =>
            secrets.tokenize("a.json", '{"url":"fixture-password"}', []),
        ).toThrow();
    });

    it("refuses cleartext in authored templates, keys, and comments", () => {
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "fixture-password"]]),
        );
        expect(() =>
            secrets.assertTemplate("a.json", '{"password":"fixture-password"}'),
        ).toThrow("resolved secret");
        expect(() =>
            secrets.assertTemplate(
                "a.json",
                '{"password":"fixture-\\u0070assword"}',
            ),
        ).toThrow("resolved secret");
        expect(() =>
            secrets.tokenize("a.json", '{"fixture-password":"public"}'),
        ).toThrow("unrecognized location");
        expect(() =>
            secrets.tokenize("a.yml", "# fixture-password\npublic: ok\n"),
        ).toThrow("unrecognized location");
        expect(() =>
            secrets.assertTemplate("a.yml", "# ${secret:AUTH}\npublic: ok\n"),
        ).toThrow("outside a supported string value");
    });

    it("blocks known server secrets even when no secret reference was declared", () => {
        const empty = new ConfigSecrets(new Map());
        for (const key of [
            "rcon.password",
            "management-server-secret",
            "management-server-tls-keystore-password",
        ]) {
            expect(() =>
                empty.tokenize(
                    "server.properties",
                    `${key}=unregistered-credential\n`,
                ),
            ).toThrow("resolved secret");
            expect(empty.tokenize("server.properties", `${key}=\n`)).toBe(
                `${key}=\n`,
            );
        }
        expect(() =>
            empty.tokenize(
                "config/paper-global.yml",
                "proxies:\n  velocity:\n    secret: unregistered-credential\n",
            ),
        ).toThrow("resolved secret");
        expect(() =>
            empty.tokenize("forwarding.secret", "unregistered-credential"),
        ).toThrow("resolved secret");
        expect(() =>
            empty.tokenize(
                "custom.txt",
                "-----BEGIN RSA PRIVATE KEY-----\nexample",
            ),
        ).toThrow("resolved secret");
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "registered-credential"]]),
        );
        expect(
            secrets.tokenize(
                "server.properties",
                "rcon.password=registered-credential\n",
            ),
        ).toContain("${secret:AUTH}");
        expect(secrets.inject("forwarding.secret", "${secret:AUTH}\n")).toBe(
            "registered-credential\n",
        );
    });

    it("fails closed for unfamiliar text when a secret moves to another line", () => {
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "fixture-password"]]),
        );
        const template = "key=${secret:AUTH}\nother=public\n";
        expect(secrets.inject("a.conf", template)).toBe(
            "key=fixture-password\nother=public\n",
        );
        expect(
            secrets.tokenize(
                "a.conf",
                "key=fixture-password\nother=changed\n",
                [template],
            ),
        ).toBe("key=${secret:AUTH}\nother=changed\n");
        expect(() =>
            secrets.tokenize("a.conf", "other=public\nkey=fixture-password\n", [
                template,
            ]),
        ).toThrow();
    });

    it("rejects unresolved or malformed tokens without printing the input", () => {
        const secrets = new ConfigSecrets(new Map());
        for (const text of [
            '{"password":"${secret:MISSING}"}',
            '{"password":"${secret:bad name}"}',
        ]) {
            expect(() => secrets.assertTemplate("a.json", text)).toThrow(
                "placeholder",
            );
        }
        expect(secrets.redact("ordinary text")).toBe("ordinary text");
        expect(secrets.tokenize("a.txt", "ordinary text")).toBe(
            "ordinary text",
        );
        expect(
            new ConfigSecrets(new Map([["AUTH", "fixture-password"]])).redact(
                "error fixture-password",
            ),
        ).toBe("error [redacted]");
    });

    it("replaces overlapping values once without interpreting regex metacharacters", () => {
        const secrets = new ConfigSecrets(
            new Map([
                ["LONG", "fixture[a]+long"],
                ["SHORT", "fixture[a]+"],
            ]),
        );
        expect(secrets.tokenize("a.conf", "fixture[a]+long fixture[a]+")).toBe(
            "${secret:LONG} ${secret:SHORT}",
        );
    });

    it("rejects ambiguous and invalid secret definitions", () => {
        expect(
            () =>
                new ConfigSecrets(
                    new Map([
                        ["A", ""],
                        ["B", "x"],
                    ]),
                ),
        ).toThrow("nonempty");
        expect(
            () =>
                new ConfigSecrets(
                    new Map([
                        ["A", "same"],
                        ["B", "same"],
                    ]),
                ),
        ).toThrow("distinguishable");
        expect(
            () => new ConfigSecrets(new Map([["A", "${secret:B}"]])),
        ).toThrow();
        expect(
            () =>
                new ConfigSecrets(new Map([["bad name", "fixture-password"]])),
        ).toThrow();
        expect(
            () => new ConfigSecrets(new Map([["A", "x".repeat(65_537)]])),
        ).toThrow();
    });

    it("redacts multiline and escaped log fragments without treating partial lines as tokens", () => {
        const value = 'header[a]+\\key\r\n\r\n  secret-body"  \nfooter';
        const secrets = new ConfigSecrets(new Map([["KEY", value]]));
        for (const fragment of [
            "header[a]+\\key",
            'secret-body"',
            "footer",
            JSON.stringify(value).slice(1, -1),
        ]) {
            expect(secrets.redact(`log: ${fragment}`)).toBe("log: [redacted]");
        }
        expect(secrets.redact("public\n\ntext")).toBe("public\n\ntext");
        expect(secrets.tokenize("config.txt", "footer\n")).toBe("footer\n");
        const template = '{"key":"${secret:KEY}"}';
        expect(
            parseConfigDocument(
                "config.json",
                secrets.tokenize(
                    "config.json",
                    secrets.inject("config.json", template),
                    [template],
                ),
            ).value,
        ).toEqual({ key: "${secret:KEY}" });
    });

    it("loads explicit environment references and rejects missing or invalid ones", async () => {
        const secrets = await loadConfigSecrets(
            "unused",
            { AUTH: { env: "CRAFLEET_TEST" } },
            { CRAFLEET_TEST: "fixture-password" },
        );
        expect(secrets.inject("a.txt", "${secret:AUTH}")).toBe(
            "fixture-password",
        );
        await expect(
            loadConfigSecrets("unused", { AUTH: { env: "MISSING" } }, {}),
        ).rejects.toThrow("unavailable");
        await expect(
            loadConfigSecrets("unused", { AUTH: {} }, {}),
        ).rejects.toThrow("exactly one");
        await expect(
            loadConfigSecrets(
                "unused",
                { AUTH: { env: "VALUE", file: "file" } },
                {},
            ),
        ).rejects.toThrow("exactly one");
        await expect(
            loadConfigSecrets("unused", { AUTH: { env: "bad name" } }, {}),
        ).rejects.toThrow("exactly one");
    });
});
