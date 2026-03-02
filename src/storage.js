import fs from "fs";
import path from "path";
import pg from "pg";

const { Pool } = pg;

const DB_PATH = path.resolve("data/db.json");
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
let dbReady = false;

function getPool() {
    if (!DATABASE_URL) return null;
    if (!pool) {
        pool = new Pool({
            connectionString: DATABASE_URL,
            ssl: DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
        });
    }
    return pool;
}

async function ensurePgSchema() {
    if (dbReady) return;
    const p = getPool();
    if (!p) return;
    await p.query(`
        CREATE TABLE IF NOT EXISTS purchases (
            user_id BIGINT NOT NULL,
            product_id TEXT NOT NULL,
            paid_at TIMESTAMPTZ NOT NULL,
            last_downloaded_at TIMESTAMPTZ,
            telegram_payment_charge_id TEXT,
            payload JSONB,
            PRIMARY KEY (user_id, product_id)
        );
    `);
    await p.query(`
        ALTER TABLE purchases
        ADD COLUMN IF NOT EXISTS last_downloaded_at TIMESTAMPTZ;
    `);
    await p.query(`
        CREATE TABLE IF NOT EXISTS users (
            user_id BIGINT PRIMARY KEY,
            username TEXT,
            language_code TEXT,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            opens_count INTEGER NOT NULL DEFAULT 0,
            can_notify BOOLEAN NOT NULL DEFAULT TRUE,
            last_platform TEXT,
            last_tg_version TEXT,
            start_param TEXT
        );
    `);
    await p.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            page TEXT,
            platform TEXT,
            tg_version TEXT,
            color_scheme TEXT,
            is_tg BOOLEAN NOT NULL DEFAULT TRUE
        );
    `);
    await p.query(`
        CREATE INDEX IF NOT EXISTS idx_sessions_user_started
        ON sessions (user_id, started_at DESC);
    `);
    await p.query(`
        CREATE TABLE IF NOT EXISTS events (
            id BIGSERIAL PRIMARY KEY,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
            event_type TEXT NOT NULL,
            page TEXT,
            product_id TEXT,
            city TEXT,
            payload JSONB
        );
    `);
    await p.query(`
        CREATE INDEX IF NOT EXISTS idx_events_user_ts
        ON events (user_id, ts DESC);
    `);
    await p.query(`
        CREATE INDEX IF NOT EXISTS idx_events_type_ts
        ON events (event_type, ts DESC);
    `);
    await p.query(`
        CREATE INDEX IF NOT EXISTS idx_events_session_ts
        ON events (session_id, ts DESC);
    `);
    await p.query(`
        CREATE TABLE IF NOT EXISTS notification_log (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL,
            campaign_id TEXT,
            channel TEXT NOT NULL DEFAULT 'telegram',
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            status TEXT NOT NULL,
            error_text TEXT
        );
    `);
    await p.query(`
        CREATE INDEX IF NOT EXISTS idx_notification_log_user_sent
        ON notification_log (user_id, sent_at DESC);
    `);
    dbReady = true;
}

function ensureDb() {
    if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(
            DB_PATH,
            JSON.stringify({ users: {}, analytics: { users: {}, sessions: {}, events: [], notificationLog: [] } }, null, 2),
            "utf-8"
        );
    }
}

function readDb() {
    ensureDb();
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDb(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function ensureAnalytics(db) {
    db.analytics ??= {};
    db.analytics.users ??= {};
    db.analytics.sessions ??= {};
    db.analytics.events ??= [];
    db.analytics.notificationLog ??= [];
}

export function hasPurchase(userId, productId) {
    if (!DATABASE_URL) {
        const db = readDb();
        const u = db.users?.[String(userId)];
        return Boolean(u?.purchases?.[productId]?.paidAt);
    }
    return false;
}

export function listPurchases(userId) {
    if (!DATABASE_URL) {
        const db = readDb();
        const u = db.users?.[String(userId)];
        const purchases = u?.purchases || {};
        return Object.entries(purchases).map(([productId, info]) => ({
            productId,
            paidAt: info?.paidAt || null,
            lastDownloadedAt: info?.lastDownloadedAt || null,
        }));
    }
    return [];
}

export function storePurchase({ userId, productId, telegramPaymentChargeId, payload }) {
    if (!DATABASE_URL) {
        const db = readDb();
        const key = String(userId);

        db.users[key] ??= { purchases: {} };
        db.users[key].purchases ??= {};

        db.users[key].purchases[productId] = {
            paidAt: new Date().toISOString(),
            lastDownloadedAt: null,
            telegramPaymentChargeId,
            payload,
        };

        writeDb(db);
    }
}

export function removePurchase({ userId, productId }) {
    if (!DATABASE_URL) {
        const db = readDb();
        const key = String(userId);
        if (!db.users?.[key]?.purchases?.[productId]) return;
        delete db.users[key].purchases[productId];
        writeDb(db);
    }
}

export async function hasPurchaseAsync(userId, productId) {
    const p = getPool();
    if (!p) return hasPurchase(userId, productId);
    await ensurePgSchema();
    const res = await p.query(
        "SELECT 1 FROM purchases WHERE user_id = $1 AND product_id = $2 LIMIT 1",
        [Number(userId), String(productId)]
    );
    return res.rowCount > 0;
}

export async function listPurchasesAsync(userId) {
    const p = getPool();
    if (!p) return listPurchases(userId);
    await ensurePgSchema();
    const res = await p.query(
        "SELECT product_id, paid_at, last_downloaded_at FROM purchases WHERE user_id = $1",
        [Number(userId)]
    );
    return res.rows.map((row) => ({
        productId: row.product_id,
        paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
        lastDownloadedAt: row.last_downloaded_at
            ? new Date(row.last_downloaded_at).toISOString()
            : null,
    }));
}

export async function storePurchaseAsync({ userId, productId, telegramPaymentChargeId, payload }) {
    const p = getPool();
    if (!p) return storePurchase({ userId, productId, telegramPaymentChargeId, payload });
    await ensurePgSchema();
    await p.query(
        `
        INSERT INTO purchases (user_id, product_id, paid_at, telegram_payment_charge_id, payload)
        VALUES ($1, $2, NOW(), $3, $4)
        ON CONFLICT (user_id, product_id)
        DO UPDATE SET
            paid_at = EXCLUDED.paid_at,
            telegram_payment_charge_id = EXCLUDED.telegram_payment_charge_id,
            payload = EXCLUDED.payload
        `,
        [Number(userId), String(productId), telegramPaymentChargeId || null, payload || null]
    );
}

export async function removePurchaseAsync(userId, productId) {
    const p = getPool();
    if (!p) return removePurchase({ userId, productId });
    await ensurePgSchema();
    await p.query(
        "DELETE FROM purchases WHERE user_id = $1 AND product_id = $2",
        [Number(userId), String(productId)]
    );
}

export function markDownload({ userId, productId }) {
    if (!DATABASE_URL) {
        const db = readDb();
        const key = String(userId);
        const record = db.users?.[key]?.purchases?.[productId];
        if (!record) return;
        record.lastDownloadedAt = new Date().toISOString();
        writeDb(db);
    }
}

export async function markDownloadAsync(userId, productId) {
    const p = getPool();
    if (!p) return markDownload({ userId, productId });
    await ensurePgSchema();
    await p.query(
        `
        UPDATE purchases
        SET last_downloaded_at = NOW()
        WHERE user_id = $1 AND product_id = $2
        `,
        [Number(userId), String(productId)]
    );
}

function upsertUserLocal({
    userId,
    username,
    languageCode,
    canNotify = null,
    platform,
    tgVersion,
    startParam,
    incrementOpens = false,
}) {
    const db = readDb();
    ensureAnalytics(db);
    const key = String(userId);
    const now = new Date().toISOString();
    const current = db.analytics.users[key];
    if (!current) {
        db.analytics.users[key] = {
            userId: Number(userId),
            username: username || null,
            languageCode: languageCode || null,
            firstSeenAt: now,
            lastSeenAt: now,
            opensCount: incrementOpens ? 1 : 0,
            canNotify: typeof canNotify === "boolean" ? canNotify : true,
            lastPlatform: platform || null,
            lastTgVersion: tgVersion || null,
            startParam: startParam || null,
        };
    } else {
        if (username) current.username = username;
        if (languageCode) current.languageCode = languageCode;
        if (platform) current.lastPlatform = platform;
        if (tgVersion) current.lastTgVersion = tgVersion;
        if (startParam) current.startParam = startParam;
        if (typeof canNotify === "boolean") current.canNotify = canNotify;
        if (incrementOpens) current.opensCount = Number(current.opensCount || 0) + 1;
        current.lastSeenAt = now;
    }
    writeDb(db);
}

export async function upsertUserAsync({
    userId,
    username,
    languageCode,
    canNotify = null,
    platform,
    tgVersion,
    startParam,
    incrementOpens = false,
}) {
    const p = getPool();
    if (!p) {
        return upsertUserLocal({
            userId,
            username,
            languageCode,
            canNotify,
            platform,
            tgVersion,
            startParam,
            incrementOpens,
        });
    }
    await ensurePgSchema();
    const opensDelta = incrementOpens ? 1 : 0;
    await p.query(
        `
        INSERT INTO users (
            user_id, username, language_code, first_seen_at, last_seen_at,
            opens_count, can_notify, last_platform, last_tg_version, start_param
        )
        VALUES ($1, $2, $3, NOW(), NOW(), $4, COALESCE($5, TRUE), $6, $7, $8)
        ON CONFLICT (user_id)
        DO UPDATE SET
            username = COALESCE(EXCLUDED.username, users.username),
            language_code = COALESCE(EXCLUDED.language_code, users.language_code),
            last_seen_at = NOW(),
            opens_count = users.opens_count + $9,
            can_notify = COALESCE(EXCLUDED.can_notify, users.can_notify),
            last_platform = COALESCE(EXCLUDED.last_platform, users.last_platform),
            last_tg_version = COALESCE(EXCLUDED.last_tg_version, users.last_tg_version),
            start_param = COALESCE(EXCLUDED.start_param, users.start_param)
        `,
        [
            Number(userId),
            username || null,
            languageCode || null,
            opensDelta,
            typeof canNotify === "boolean" ? canNotify : null,
            platform || null,
            tgVersion || null,
            startParam || null,
            opensDelta,
        ]
    );
}

function createSessionLocal({
    sessionId,
    userId,
    page,
    platform,
    tgVersion,
    colorScheme,
    isTg = true,
}) {
    const db = readDb();
    ensureAnalytics(db);
    const now = new Date().toISOString();
    db.analytics.sessions[sessionId] = {
        sessionId,
        userId: Number(userId),
        startedAt: now,
        endedAt: null,
        page: page || null,
        platform: platform || null,
        tgVersion: tgVersion || null,
        colorScheme: colorScheme || null,
        isTg: Boolean(isTg),
    };
    writeDb(db);
}

export async function createSessionAsync({
    sessionId,
    userId,
    page,
    platform,
    tgVersion,
    colorScheme,
    isTg = true,
}) {
    const p = getPool();
    if (!p) {
        return createSessionLocal({
            sessionId,
            userId,
            page,
            platform,
            tgVersion,
            colorScheme,
            isTg,
        });
    }
    await ensurePgSchema();
    await p.query(
        `
        INSERT INTO sessions (
            session_id, user_id, page, platform, tg_version, color_scheme, is_tg
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (session_id) DO NOTHING
        `,
        [
            String(sessionId),
            Number(userId),
            page || null,
            platform || null,
            tgVersion || null,
            colorScheme || null,
            Boolean(isTg),
        ]
    );
}

function touchSessionLocal(sessionId) {
    const db = readDb();
    ensureAnalytics(db);
    const key = String(sessionId || "");
    const current = db.analytics.sessions[key];
    if (current) current.endedAt = new Date().toISOString();
    writeDb(db);
}

export async function touchSessionEndedAsync(sessionId) {
    const p = getPool();
    if (!p) return touchSessionLocal(sessionId);
    await ensurePgSchema();
    await p.query(
        `
        UPDATE sessions
        SET ended_at = NOW()
        WHERE session_id = $1
        `,
        [String(sessionId)]
    );
}

function trackEventLocal({
    userId,
    sessionId = null,
    eventType,
    page = null,
    productId = null,
    city = null,
    payload = null,
}) {
    const db = readDb();
    ensureAnalytics(db);
    db.analytics.events.push({
        id: db.analytics.events.length + 1,
        ts: new Date().toISOString(),
        userId: Number(userId),
        sessionId: sessionId || null,
        eventType: String(eventType || ""),
        page: page || null,
        productId: productId || null,
        city: city || null,
        payload: payload || null,
    });
    writeDb(db);
}

export async function trackEventAsync({
    userId,
    sessionId = null,
    eventType,
    page = null,
    productId = null,
    city = null,
    payload = null,
}) {
    const p = getPool();
    if (!p) {
        return trackEventLocal({
            userId,
            sessionId,
            eventType,
            page,
            productId,
            city,
            payload,
        });
    }
    await ensurePgSchema();
    await p.query(
        `
        INSERT INTO events (user_id, session_id, event_type, page, product_id, city, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
            Number(userId),
            sessionId || null,
            String(eventType || ""),
            page || null,
            productId || null,
            city || null,
            payload || null,
        ]
    );
}

function logNotificationLocal({
    userId,
    campaignId = null,
    channel = "telegram",
    status,
    errorText = null,
}) {
    const db = readDb();
    ensureAnalytics(db);
    db.analytics.notificationLog.push({
        id: db.analytics.notificationLog.length + 1,
        userId: Number(userId),
        campaignId: campaignId || null,
        channel: channel || "telegram",
        sentAt: new Date().toISOString(),
        status: String(status || "unknown"),
        errorText: errorText || null,
    });
    writeDb(db);
}

export async function logNotificationAsync({
    userId,
    campaignId = null,
    channel = "telegram",
    status,
    errorText = null,
}) {
    const p = getPool();
    if (!p) {
        return logNotificationLocal({
            userId,
            campaignId,
            channel,
            status,
            errorText,
        });
    }
    await ensurePgSchema();
    await p.query(
        `
        INSERT INTO notification_log (user_id, campaign_id, channel, status, error_text)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
            Number(userId),
            campaignId || null,
            channel || "telegram",
            String(status || "unknown"),
            errorText || null,
        ]
    );
}
