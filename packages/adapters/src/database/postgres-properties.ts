import {
    CrafleetError,
    type PostgresBackupConfig,
    stableStringify,
} from "@crafleet/core";
import { type } from "arktype";
import {
    pgIdentifier as ident,
    pgLiteral as literal,
    type PostgresClient,
} from "./postgres-client.js";

const Name = type("string > 0");
export const PostgresPropertiesSchema = type({
    "+": "reject",
    oid: "0 < number.integer <= 4294967295",
    name: Name,
    owner: Name,
    ownerOid: "0 < number.integer <= 4294967295",
    encoding: Name,
    provider: "'b' | 'c' | 'i'",
    collate: "string",
    ctype: "string",
    locale: "string | null",
    icuRules: "string | null",
    collationVersion: "string | null",
    tablespace: Name,
    allowConnections: "boolean",
    connectionLimit: "number.integer >= -1",
    comment: "string | null",
    acl: type({
        "+": "reject",
        grantee: "string | null",
        grantor: Name,
        privilege: "'CREATE' | 'CONNECT' | 'TEMPORARY'",
        grantable: "boolean",
    }).array(),
    settings: type({
        "+": "reject",
        role: "string | null",
        values: "string[]",
    }).array(),
});
export type PostgresProperties = typeof PostgresPropertiesSchema.infer;

export async function readPostgresProperties(
    client: PostgresClient,
    config: PostgresBackupConfig,
    name: string,
    signal?: AbortSignal,
): Promise<PostgresProperties | undefined> {
    const result = await client.query(
        config,
        `SELECT json_build_object(
        'oid', d.oid::bigint, 'name', d.datname, 'owner', pg_get_userbyid(d.datdba), 'ownerOid', d.datdba::bigint,
        'encoding', pg_encoding_to_char(d.encoding), 'provider', d.datlocprovider, 'collate', d.datcollate, 'ctype', d.datctype,
        'locale', d.datlocale, 'icuRules', d.daticurules, 'collationVersion', d.datcollversion,
        'tablespace', t.spcname, 'allowConnections', d.datallowconn, 'connectionLimit', d.datconnlimit,
        'comment', shobj_description(d.oid, 'pg_database'),
        'acl', (SELECT COALESCE(json_agg(json_build_object('grantee', CASE WHEN a.grantee=0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, 'grantor', pg_get_userbyid(a.grantor), 'privilege', a.privilege_type, 'grantable', a.is_grantable) ORDER BY a.grantor, a.grantee, a.privilege_type), '[]') FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a),
        'settings', (SELECT COALESCE(json_agg(json_build_object('role', CASE WHEN s.setrole=0 THEN NULL ELSE pg_get_userbyid(s.setrole) END, 'values', s.setconfig) ORDER BY s.setrole), '[]') FROM pg_db_role_setting s WHERE s.setdatabase=d.oid)
    ) FROM pg_database d JOIN pg_tablespace t ON t.oid=d.dattablespace WHERE d.datname=${literal(name)};`,
        signal,
    );
    if (!result) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(result);
    } catch {
        throw new CrafleetError(
            "DATABASE_METADATA",
            "Invalid PostgreSQL catalog response.",
            3,
        );
    }
    const parsed = PostgresPropertiesSchema(value);
    if (parsed instanceof type.errors)
        throw new CrafleetError(
            "DATABASE_METADATA",
            "Unsupported PostgreSQL database metadata.",
            3,
        );
    return parsed;
}

export function createPostgresDatabase(
    name: string,
    p: PostgresProperties,
): string {
    const provider = { b: "builtin", c: "libc", i: "icu" }[p.provider];
    return `CREATE DATABASE ${ident(name)} WITH TEMPLATE template0 ENCODING ${literal(p.encoding)} LOCALE_PROVIDER ${provider} LC_COLLATE ${literal(p.collate)} LC_CTYPE ${literal(p.ctype)}${p.locale ? ` ${p.provider === "b" ? "BUILTIN_LOCALE" : "ICU_LOCALE"} ${literal(p.locale)}` : ""}${p.icuRules ? ` ICU_RULES ${literal(p.icuRules)}` : ""}${p.collationVersion ? ` COLLATION_VERSION ${literal(p.collationVersion)}` : ""} TABLESPACE ${ident(p.tablespace)};`;
}

/** Retain effective database grants, their grantors, and database/role defaults. */
export function postgresPropertyStatements(
    name: string,
    p: PostgresProperties,
): string {
    const db = ident(name);
    const statements = [
        `ALTER DATABASE ${db} OWNER TO ${ident(p.owner)};`,
        `ALTER DATABASE ${db} CONNECTION LIMIT ${p.connectionLimit};`,
        `COMMENT ON DATABASE ${db} IS ${p.comment === null ? "NULL" : literal(p.comment)};`,
        `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
        `REVOKE ALL ON DATABASE ${db} FROM ${ident(p.owner)};`,
    ];
    const remaining = [...p.acl];
    const canGrant = new Map<string, Set<string>>([
        [p.owner, new Set(["CREATE", "CONNECT", "TEMPORARY"])],
    ]);
    while (remaining.length) {
        const index = remaining.findIndex((grant) =>
            canGrant.get(grant.grantor)?.has(grant.privilege),
        );
        if (index < 0)
            throw new CrafleetError(
                "DATABASE_ACL",
                "Database grants cannot be reconstructed with their original grantors.",
                3,
            );
        const grant = remaining.splice(index, 1)[0];
        if (!grant) throw new Error("Missing grant");
        statements.push(
            `SET ROLE ${ident(grant.grantor)}; GRANT ${grant.privilege} ON DATABASE ${db} TO ${grant.grantee === null ? "PUBLIC" : ident(grant.grantee)}${grant.grantable ? " WITH GRANT OPTION" : ""}; RESET ROLE;`,
        );
        if (grant.grantable && grant.grantee) {
            const values = canGrant.get(grant.grantee) ?? new Set<string>();
            values.add(grant.privilege);
            canGrant.set(grant.grantee, values);
        }
    }
    for (const setting of p.settings)
        for (const entry of setting.values) {
            const split = entry.indexOf("=");
            if (split < 1)
                throw new CrafleetError(
                    "DATABASE_METADATA",
                    "Invalid database setting.",
                    3,
                );
            const parameter = entry.slice(0, split);
            if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/u.test(parameter))
                throw new CrafleetError(
                    "DATABASE_METADATA",
                    "Unsupported database setting name.",
                    3,
                );
            statements.push(
                `${setting.role === null ? `ALTER DATABASE ${db}` : `ALTER ROLE ${ident(setting.role)} IN DATABASE ${db}`} SET ${parameter} TO ${literal(entry.slice(split + 1))};`,
            );
        }
    return statements.join("\n");
}

export function samePostgresProperties(
    actual: PostgresProperties,
    expected: PostgresProperties,
): boolean {
    const normalized = (p: PostgresProperties) => ({
        ...p,
        oid: 0,
        name: "",
        allowConnections: false,
        acl: p.acl.map((v) => stableStringify(v)).sort(),
        settings: p.settings
            .map((v) => stableStringify({ ...v, values: [...v.values].sort() }))
            .sort(),
    });
    return (
        stableStringify(normalized(actual)) ===
        stableStringify(normalized(expected))
    );
}
