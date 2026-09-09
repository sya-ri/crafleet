import type { PostgresProperties } from "../../packages/adapters/src/database/postgres-properties.js";
export function postgresProperties(
    patch: Partial<PostgresProperties> = {},
): PostgresProperties {
    return {
        oid: 16384,
        name: "application",
        owner: "owner",
        ownerOid: 16385,
        encoding: "UTF8",
        provider: "c",
        collate: "C",
        ctype: "C",
        locale: null,
        icuRules: null,
        collationVersion: null,
        tablespace: "pg_default",
        allowConnections: true,
        connectionLimit: -1,
        comment: null,
        acl: [
            {
                grantee: "owner",
                grantor: "owner",
                privilege: "CONNECT",
                grantable: false,
            },
            {
                grantee: null,
                grantor: "owner",
                privilege: "TEMPORARY",
                grantable: false,
            },
        ],
        settings: [],
        ...patch,
    };
}
