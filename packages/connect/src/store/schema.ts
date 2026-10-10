/**
 * The Connect database: one schema, `aaply_connect`, in PostgreSQL 14 or
 * later. Every tenant's rows sit behind forced row-level security keyed on
 * the transaction setting `aaply_connect.tenant`; the app role
 * (`aaply_connect_app`) owns nothing and cannot bypass it. Hot-path reads go
 * through SQL functions that set the tenant and read everything a call
 * needs in one round trip.
 *
 * Pre-1.0 there is one starting schema and no migrations: a database made by
 * another build is refused at start (`SCHEMA_VERSION`).
 */

/** The schema this build writes and reads. A database with another is refused. */
export const SCHEMA_VERSION = 1;

/** The role the service's login role is a member of. */
export const APP_ROLE = "aaply_connect_app";

const TENANT = "current_setting('aaply_connect.tenant', true)";

const TENANT_TABLES = ["data_keys", "policy", "installations", "connections", "secrets", "replay_claims"] as const;

export const SCHEMA_SQL = `
CREATE SCHEMA aaply_connect;

CREATE TABLE aaply_connect.meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL
);
INSERT INTO aaply_connect.meta (schema_version) VALUES (${SCHEMA_VERSION});

-- The global kill switch: one row, read with every call.
CREATE TABLE aaply_connect.global_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  disabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1
);
INSERT INTO aaply_connect.global_policy DEFAULT VALUES;

CREATE TABLE aaply_connect.data_keys (
  tenant_id text NOT NULL,
  data_key_id text NOT NULL,
  wrapping_key_id text NOT NULL,
  wrapped bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, data_key_id)
);

-- Per scope: the kill switch and denied actions. version moves on every change.
CREATE TABLE aaply_connect.policy (
  tenant_id text NOT NULL,
  app_id text NOT NULL,
  environment_id text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  denied text[] NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, app_id, environment_id)
);

-- Connectors a scope may use. A code connector is one of this build's; a sql one is a definition (data) pinned by digest.
CREATE TABLE aaply_connect.installations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  app_id text NOT NULL,
  environment_id text NOT NULL,
  connector_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('code', 'sql')),
  definition jsonb,
  digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app_id, environment_id, connector_id),
  CHECK ((kind = 'code') = (definition IS NULL))
);

CREATE TABLE aaply_connect.connections (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  app_id text NOT NULL,
  environment_id text NOT NULL,
  connector_id text NOT NULL,
  -- The person whose account it is (domain:id), or null for the business's own.
  owner_subject text,
  -- The flow role a business connection serves; null for a person's.
  role text,
  environment_kind text NOT NULL CHECK (environment_kind IN ('production', 'preview', 'test')),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  account jsonb NOT NULL DEFAULT '{}',
  config jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth', 'revoked')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_subject IS NULL) <> (role IS NULL))
);
-- What resolve() reads on every call (it also sees revoked rows, which the partial unique indexes leave out).
CREATE INDEX connections_resolve ON aaply_connect.connections (tenant_id, app_id, environment_id, connector_id, environment_kind);
CREATE UNIQUE INDEX connections_business ON aaply_connect.connections (tenant_id, app_id, environment_id, connector_id, role, environment_kind) WHERE owner_subject IS NULL AND status <> 'revoked';
CREATE UNIQUE INDEX connections_person ON aaply_connect.connections (tenant_id, app_id, environment_id, connector_id, owner_subject, environment_kind) WHERE role IS NULL AND status <> 'revoked';

-- One sealed secret per connection (the vault's AES-256-GCM), bound to its version.
CREATE TABLE aaply_connect.secrets (
  connection_id text PRIMARY KEY REFERENCES aaply_connect.connections (id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  data_key_id text NOT NULL,
  -- The secret version the sealed value is bound to; moves only when the secret is replaced.
  sealed_version integer NOT NULL,
  iv bytea NOT NULL,
  sealed bytea NOT NULL,
  FOREIGN KEY (tenant_id, data_key_id) REFERENCES aaply_connect.data_keys (tenant_id, data_key_id)
);

-- Attempts of writes that do not de-duplicate, claimed once until their deadline.
CREATE TABLE aaply_connect.replay_claims (
  tenant_id text NOT NULL,
  claim_key text NOT NULL,
  until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, claim_key)
);
CREATE INDEX replay_claims_until ON aaply_connect.replay_claims (until);

${TENANT_TABLES.map(
  (t) => `ALTER TABLE aaply_connect.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE aaply_connect.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON aaply_connect.${t} USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});`,
).join("\n")}

-- Everything one call needs, in one round trip: the kill switches, the scope's policy, the installation, the connection, its sealed secret and the data key it is sealed under.
CREATE FUNCTION aaply_connect.resolve(p_tenant text, p_app text, p_env text, p_connector text, p_acting text, p_role text, p_subject text, p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM set_config('aaply_connect.tenant', p_tenant, true);
  SELECT jsonb_build_object(
    'global', (SELECT jsonb_build_object('disabled', g.disabled) FROM aaply_connect.global_policy g),
    'policy', (SELECT jsonb_build_object('disabled', p.disabled, 'denied', to_jsonb(p.denied)) FROM aaply_connect.policy p
               WHERE p.tenant_id = p_tenant AND p.app_id = p_app AND p.environment_id = p_env),
    'installation', (SELECT jsonb_build_object('id', i.id, 'kind', i.kind, 'definition', i.definition, 'digest', i.digest) FROM aaply_connect.installations i
               WHERE i.tenant_id = p_tenant AND i.app_id = p_app AND i.environment_id = p_env AND i.connector_id = p_connector),
    'connection', (SELECT jsonb_build_object(
                     'id', c.id, 'ownerSubject', c.owner_subject, 'role', c.role, 'environmentKind', c.environment_kind,
                     'grantedScopes', to_jsonb(c.granted_scopes), 'account', c.account, 'config', c.config, 'status', c.status, 'version', c.version,
                     'secret', (SELECT jsonb_build_object('dataKeyId', s.data_key_id, 'version', s.sealed_version, 'iv', encode(s.iv, 'base64'), 'sealed', encode(s.sealed, 'base64'),
                                  'wrapped', encode(k.wrapped, 'base64'), 'wrappingKeyId', k.wrapping_key_id)
                                FROM aaply_connect.secrets s JOIN aaply_connect.data_keys k ON k.tenant_id = s.tenant_id AND k.data_key_id = s.data_key_id
                                WHERE s.connection_id = c.id))
                   FROM aaply_connect.connections c
                   WHERE c.tenant_id = p_tenant AND c.app_id = p_app AND c.environment_id = p_env AND c.connector_id = p_connector
                     AND c.environment_kind = p_kind
                     AND CASE WHEN p_acting = 'endUser' THEN c.owner_subject = p_subject ELSE c.owner_subject IS NULL AND c.role = p_role END
                   ORDER BY (c.status <> 'revoked') DESC, c.created_at DESC
                   LIMIT 1)
  ) INTO result;
  RETURN result;
END
$$;

-- Claims one attempt of a write; true the first time, false while the claim holds.
CREATE FUNCTION aaply_connect.claim(p_tenant text, p_key text, p_until timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  claimed boolean;
BEGIN
  PERFORM set_config('aaply_connect.tenant', p_tenant, true);
  INSERT INTO aaply_connect.replay_claims (tenant_id, claim_key, until) VALUES (p_tenant, p_key, p_until)
  ON CONFLICT (tenant_id, claim_key) DO UPDATE SET until = EXCLUDED.until WHERE aaply_connect.replay_claims.until < now()
  RETURNING true INTO claimed;
  RETURN coalesce(claimed, false);
END
$$;

-- The owner (and so purge_expired, which runs as the owner) sees every tenant's claims; the app role never does.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY purge_read ON aaply_connect.replay_claims FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY purge ON aaply_connect.replay_claims FOR DELETE TO %I USING (true)', current_user);
END $$;

-- Deletes expired claims across tenants, in batches. Runs as the owner (SECURITY DEFINER): row security would hide other tenants' rows.
CREATE FUNCTION aaply_connect.purge_expired(p_limit integer)
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH gone AS (
    DELETE FROM aaply_connect.replay_claims WHERE ctid IN (SELECT ctid FROM aaply_connect.replay_claims WHERE until < now() LIMIT p_limit) RETURNING 1
  ) SELECT count(*)::integer FROM gone
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA aaply_connect TO ${APP_ROLE};
GRANT SELECT ON aaply_connect.meta TO ${APP_ROLE};
GRANT SELECT, UPDATE ON aaply_connect.global_policy TO ${APP_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ${TENANT_TABLES.map((t) => `aaply_connect.${t}`).join(", ")} TO ${APP_ROLE};
REVOKE ALL ON FUNCTION aaply_connect.resolve, aaply_connect.claim, aaply_connect.purge_expired FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aaply_connect.resolve, aaply_connect.claim, aaply_connect.purge_expired TO ${APP_ROLE};
`;
