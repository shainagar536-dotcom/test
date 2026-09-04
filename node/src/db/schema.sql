-- Schema for the lead mirror and its change feed.
--
-- Two tables carry the whole model:
--   leads    the current state, one row per CRM lead
--   changes  the history, one row per field that moved
--
-- The CRM's own fields live in a JSONB column rather than as real columns,
-- because the field schema is read from the CRM at runtime and a field added
-- in Surense must not require a migration here.

CREATE TABLE IF NOT EXISTS leads (
    id            TEXT PRIMARY KEY,

    -- Every CRM field, as returned, flattened to scalars.
    fields        JSONB       NOT NULL,

    -- Fingerprint of the CRM fields, used to detect a change without
    -- comparing every value on every run.
    hash          TEXT        NOT NULL,

    -- When this row last really changed, not when the sync last ran.
    changed_at    TIMESTAMPTZ NOT NULL,
    change_type   TEXT        NOT NULL,

    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The change feed is read by "everything since <timestamp>", which is the
-- only access pattern the notifier needs.
CREATE TABLE IF NOT EXISTS changes (
    id           BIGSERIAL PRIMARY KEY,
    lead_id      TEXT        NOT NULL,
    change_type  TEXT        NOT NULL,
    column_name  TEXT        NOT NULL DEFAULT '',
    before_value TEXT        NOT NULL DEFAULT '',
    after_value  TEXT        NOT NULL DEFAULT '',
    occurred_at  TIMESTAMPTZ NOT NULL,

    -- Set once a message has actually gone out for this change. This is what
    -- stops a reader that crashes mid-run from sending the same notification
    -- twice on its next pass.
    notified_at  TIMESTAMPTZ,
    notified_via TEXT
);

CREATE INDEX IF NOT EXISTS changes_occurred_idx ON changes (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS changes_lead_idx     ON changes (lead_id);

-- Partial index: the notifier asks only for the unsent ones, and once a
-- change is sent it never comes back, so indexing the sent ones is waste.
CREATE INDEX IF NOT EXISTS changes_pending_idx
    ON changes (occurred_at) WHERE notified_at IS NULL;

CREATE INDEX IF NOT EXISTS leads_changed_idx ON leads (changed_at DESC);

-- One row per sync attempt, so a silent failure is still visible afterwards.
CREATE TABLE IF NOT EXISTS sync_runs (
    id            BIGSERIAL PRIMARY KEY,
    started_at    TIMESTAMPTZ NOT NULL,
    finished_at   TIMESTAMPTZ,
    trigger       TEXT        NOT NULL,
    ok            BOOLEAN     NOT NULL DEFAULT false,
    leads_in_crm  INTEGER     NOT NULL DEFAULT 0,
    added         INTEGER     NOT NULL DEFAULT 0,
    updated       INTEGER     NOT NULL DEFAULT 0,
    unchanged     INTEGER     NOT NULL DEFAULT 0,
    missing       INTEGER     NOT NULL DEFAULT 0,
    error         TEXT
);

CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at DESC);

-- Raw webhook deliveries, stored before any interpretation.
--
-- Surense has no webhooks today; this exists so that a push from Surense or
-- anything else is captured the moment it starts arriving, rather than being
-- dropped while support for it is written.
CREATE TABLE IF NOT EXISTS webhook_events (
    id           BIGSERIAL PRIMARY KEY,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source       TEXT        NOT NULL,

    -- The sender's own message id. Svix retries a failed delivery with the
    -- SAME id, so without this a retry would record the status change twice
    -- and the referring source would be told twice.
    external_id  TEXT,

    payload      JSONB       NOT NULL,
    processed_at TIMESTAMPTZ,
    result       TEXT
);

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS result TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_external_idx
    ON webhook_events (external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_pending_idx
    ON webhook_events (received_at) WHERE processed_at IS NULL;

-- Named read positions, saved by whoever consumes the change feed.
--
-- A consumer that pulls changes needs to remember where it stopped, and
-- keeping that here rather than on the client means it survives the client
-- restarting, moving machine, or being a different process each time.
CREATE TABLE IF NOT EXISTS cursors (
    name       TEXT PRIMARY KEY,
    last_id    BIGINT      NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    note       TEXT        NOT NULL DEFAULT ''
);

-- Status -> message. This is the whole policy surface for what gets sent.
--
-- It lives in the database, not in code, so wording can be corrected and new
-- statuses added without a deploy. A status with no row here sends nothing:
-- the allowlist is closed by design, which is what keeps the statuses that
-- have not been given wording yet silent instead of sending something wrong.
CREATE TABLE IF NOT EXISTS templates (
    status     TEXT PRIMARY KEY,
    message    TEXT        NOT NULL,
    channel    TEXT        NOT NULL DEFAULT 'email',
    active     BOOLEAN     NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who a lead's referring source actually is, and how to reach them.
--
-- source_key is the normalized form of source_name. Matching on the raw CRM
-- string is the number one failure mode: a doubled space or a typographic
-- quote and the row is never found.
CREATE TABLE IF NOT EXISTS recipients (
    source_key  TEXT PRIMARY KEY,
    source_name TEXT        NOT NULL,
    email       TEXT        NOT NULL DEFAULT '',
    whatsapp    TEXT        NOT NULL DEFAULT '',
    active      BOOLEAN     NOT NULL DEFAULT true,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
