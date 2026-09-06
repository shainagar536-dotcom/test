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

    -- How this source is reached: 'email', 'whatsapp', or empty when nobody
    -- has an address for it. This decides how the message goes out, so the
    -- sender never has to guess from which column happens to be filled.
    channel     TEXT        NOT NULL DEFAULT '',

    -- How many leads this source carried when the list was written. A hint
    -- for ordering the work, not something the sender reads.
    leads       INTEGER     NOT NULL DEFAULT 0,

    active      BOOLEAN     NOT NULL DEFAULT true,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE recipients ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT '';
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS leads INTEGER NOT NULL DEFAULT 0;

-- Referring source id -> name.
--
-- The leads carry `sourceId` as a bare UUID and no name anywhere: unlike
-- every other entity in the CRM, the source arrives without its label. The
-- recipients table is keyed by the name, because the name is what the
-- operator's own file lists, so this table is the bridge between them.
-- Without it every lead skips with "source-id-not-mapped".
--
-- `origin` records where a name came from, because the two sources of truth
-- are not equal: a name discovered in the CRM is authoritative and may be
-- refreshed on every sync, while one entered by hand is the operator's
-- decision and must survive a sync that would otherwise overwrite it.
CREATE TABLE IF NOT EXISTS sources (
    source_id  TEXT PRIMARY KEY,
    name       TEXT        NOT NULL,

    -- 'crm'    — read from a CRM lookup, refreshed automatically
    -- 'manual' — supplied through the API, never overwritten by a sync
    origin     TEXT        NOT NULL DEFAULT 'crm',

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Superseded by `sources` above, and kept only so that a mapping written by
-- the earlier version of this service is not stranded. The copy below folds
-- whatever it holds into `sources`; nothing writes to it any more.
CREATE TABLE IF NOT EXISTS source_names (
    source_id   TEXT PRIMARY KEY,
    source_name TEXT        NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time fold-in, idempotent. A row already in `sources` wins: it may have
-- been corrected by hand since, and a migration must not undo that.
INSERT INTO sources (source_id, name, origin)
SELECT source_id, source_name, 'crm' FROM source_names
    ON CONFLICT (source_id) DO NOTHING;

-- ===========================================================================
-- The status-change log: the record this service exists to keep.
--
-- One row per status change, carrying only what a notification needs — who
-- the lead is, what the status moved from and to, who handles it, and which
-- referring source to tell. Nothing else about the lead is stored: the CRM is
-- the system of record for lead data, and mirroring three thousand rows to
-- answer a question about the dozen that moved was work nobody needed.
--
-- The row is written the moment the event arrives and enriched afterwards.
-- That order is deliberate: resolving the source needs the CRM, and a CRM
-- that is slow or down must never cost us the event itself.
CREATE TABLE IF NOT EXISTS status_events (
    id             BIGSERIAL PRIMARY KEY,

    -- Denormalized on purpose. This row has to stay readable years from now
    -- with no lead table to join against.
    lead_id        TEXT        NOT NULL,
    lead_number    TEXT        NOT NULL DEFAULT '',
    customer_name  TEXT        NOT NULL DEFAULT '',

    status_before  TEXT        NOT NULL DEFAULT '',
    status_after   TEXT        NOT NULL DEFAULT '',

    -- The CRM user handling the lead. Arrives with the lead, needs no lookup.
    assignee_name  TEXT        NOT NULL DEFAULT '',

    -- The "סך הכל" amount, for the two statuses whose wording quotes it.
    -- Captured with the rest of the lookup; empty when the CRM has no such
    -- field, and a message that needs it is then held rather than sent with
    -- the placeholder still in it.
    amount         TEXT        NOT NULL DEFAULT '',

    -- The referring source: the id the lead carries, and the name resolved
    -- for it. `source_state` says which of those is true yet.
    source_id      TEXT        NOT NULL DEFAULT '',
    source_name    TEXT        NOT NULL DEFAULT '',

    -- pending  — recorded, not yet enriched
    -- resolved — the source name is known
    -- absent   — the CRM says this lead has no referring source
    -- failed   — the lookup was tried and did not succeed; see source_error
    source_state   TEXT        NOT NULL DEFAULT 'pending',
    source_error   TEXT        NOT NULL DEFAULT '',
    enrich_attempts INTEGER    NOT NULL DEFAULT 0,

    -- When the change happened, per the event — not when we heard about it.
    occurred_at    TIMESTAMPTZ NOT NULL,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Set once a message has gone out for this change.
    notified_at    TIMESTAMPTZ,
    notified_via   TEXT        NOT NULL DEFAULT '',
    notified_to    TEXT        NOT NULL DEFAULT '',

    -- When a lead moves twice before anything goes out, only the newest
    -- status is worth sending: the source wants to know where the lead IS,
    -- not to receive a transcript. The older ones are closed against the
    -- event that was sent instead, so the history still shows every move and
    -- says plainly which one was reported.
    superseded_by  BIGINT
);

ALTER TABLE status_events ADD COLUMN IF NOT EXISTS superseded_by BIGINT;

ALTER TABLE status_events ADD COLUMN IF NOT EXISTS amount TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS status_events_occurred_idx
    ON status_events (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS status_events_lead_idx ON status_events (lead_id);

CREATE INDEX IF NOT EXISTS status_events_pending_idx
    ON status_events (occurred_at) WHERE notified_at IS NULL;

-- Events still waiting for their source to be looked up.
CREATE INDEX IF NOT EXISTS status_events_enrich_idx
    ON status_events (id) WHERE source_state IN ('pending', 'failed');

-- The same status change delivered twice must not become two rows. Svix
-- retries with the same message id, but a replay from a different path would
-- not carry one, so identity is the change itself: this lead, this move, at
-- this moment.
CREATE UNIQUE INDEX IF NOT EXISTS status_events_identity_idx
    ON status_events (lead_id, status_before, status_after, occurred_at);

-- ---------------------------------------------------------------------------
-- History is append-only, enforced by the database rather than by convention.
--
-- The point is that a future change to this code CANNOT quietly destroy the
-- record: a DELETE or a TRUNCATE against this table raises instead. Updates
-- are still allowed, because enrichment and "notified" both write to a row
-- after it lands.
--
-- The escape hatch is deliberate and loud — a caller must say, in its own
-- transaction, that it means it:
--     BEGIN; SET LOCAL app.allow_history_delete = 'on'; DELETE ...; COMMIT;
CREATE OR REPLACE FUNCTION status_events_no_delete() RETURNS trigger AS $$
BEGIN
    IF coalesce(current_setting('app.allow_history_delete', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
            'status_events is append-only: % is refused', TG_OP
            USING HINT = 'Set app.allow_history_delete to on in this '
                         'transaction if you really mean to.';
    END IF;

    -- A BEFORE DELETE trigger that returns NULL cancels the row silently, so
    -- the permitted path has to hand the row back. TRUNCATE is a statement
    -- trigger and ignores the return value.
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS status_events_no_delete_row ON status_events;
CREATE TRIGGER status_events_no_delete_row
    BEFORE DELETE ON status_events
    FOR EACH ROW EXECUTE FUNCTION status_events_no_delete();

DROP TRIGGER IF EXISTS status_events_no_truncate ON status_events;
CREATE TRIGGER status_events_no_truncate
    BEFORE TRUNCATE ON status_events
    FOR EACH STATEMENT EXECUTE FUNCTION status_events_no_delete();
