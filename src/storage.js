import fs from "fs";
import path from "path";
import pg from "pg";

const { Pool } = pg;

const DB_PATH = path.resolve("data/db.json");
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
let dbReady = false;
const MOSCOW_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});
const ANALYTICS_EVENTS_RETENTION_DAYS = clampConfigInt(
    process.env.ANALYTICS_EVENTS_RETENTION_DAYS,
    7,
    3650,
    90
);
const ANALYTICS_ROLLUP_DAYS = clampConfigInt(
    process.env.ANALYTICS_ROLLUP_DAYS,
    7,
    3650,
    180
);
const ANALYTICS_MAINTENANCE_INTERVAL_MS =
    clampConfigInt(process.env.ANALYTICS_MAINTENANCE_INTERVAL_SECONDS, 30, 86400, 300) *
    1000;
const ANALYTICS_EXCLUDE_USER_IDS = parseAnalyticsExcludeUserIds(
    process.env.ANALYTICS_EXCLUDE_USER_IDS
);
const ANALYTICS_EXCLUDE_USER_IDS_SET = new Set(ANALYTICS_EXCLUDE_USER_IDS);

let analyticsMaintenancePromise = null;
let analyticsMaintenanceLastAt = 0;
let catalogProductCityMapCache = null;
let catalogProductCityMapMtimeMs = null;

function clampConfigInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return Math.min(max, Math.max(min, i));
}

function parseAnalyticsExcludeUserIds(raw) {
    if (!raw) return [];
    const set = new Set();
    for (const chunk of String(raw).split(",")) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        const n = Number(trimmed);
        if (!Number.isFinite(n)) continue;
        set.add(Math.trunc(n));
    }
    return Array.from(set.values());
}

function isAnalyticsUserExcluded(userId) {
    if (!ANALYTICS_EXCLUDE_USER_IDS_SET.size) return false;
    const n = Number(userId);
    if (!Number.isFinite(n)) return false;
    return ANALYTICS_EXCLUDE_USER_IDS_SET.has(Math.trunc(n));
}

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
        CREATE TABLE IF NOT EXISTS daily_metrics (
            day DATE PRIMARY KEY,
            dau INTEGER NOT NULL DEFAULT 0,
            app_opens INTEGER NOT NULL DEFAULT 0,
            buy_card_clicks INTEGER NOT NULL DEFAULT 0,
            buy_usdt_clicks INTEGER NOT NULL DEFAULT 0,
            buy_stars_clicks INTEGER NOT NULL DEFAULT 0,
            usdt_requests INTEGER NOT NULL DEFAULT 0,
            free_download_clicks INTEGER NOT NULL DEFAULT 0,
            paid_purchases INTEGER NOT NULL DEFAULT 0,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
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
    await p.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value JSONB,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
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

function readCatalogProductCityMap() {
    const file = path.resolve(process.env.CATALOG_PATH || "./docs/products.json");
    try {
        const stat = fs.statSync(file);
        if (catalogProductCityMapCache && catalogProductCityMapMtimeMs === stat.mtimeMs) {
            return catalogProductCityMapCache;
        }
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        const map = new Map();
        for (const product of Array.isArray(data?.products) ? data.products : []) {
            const productId = String(product?.id || "").trim();
            const cityId = String(product?.cityId || "").trim();
            if (!productId || !cityId) continue;
            map.set(productId, cityId);
        }
        catalogProductCityMapCache = map;
        catalogProductCityMapMtimeMs = stat.mtimeMs;
        return map;
    } catch {
        return catalogProductCityMapCache || new Map();
    }
}

function resolveAnalyticsCity(event, productCityMap = readCatalogProductCityMap()) {
    const directCity = String(event?.city || "").trim();
    if (directCity && directCity.toLowerCase() !== "unknown") return directCity;
    const productId = String(event?.productId || event?.product_id || "").trim();
    if (!productId) return "";
    const fallbackCity = String(productCityMap.get(productId) || "").trim();
    if (!fallbackCity || fallbackCity.toLowerCase() === "unknown") return "";
    return fallbackCity;
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
    db.appSettings ??= {};
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
    void ensureAnalyticsMaintenanceAsync().catch(() => {});
}

export async function removePurchaseAsync(userId, productId) {
    const p = getPool();
    if (!p) return removePurchase({ userId, productId });
    await ensurePgSchema();
    await p.query(
        "DELETE FROM purchases WHERE user_id = $1 AND product_id = $2",
        [Number(userId), String(productId)]
    );
    void ensureAnalyticsMaintenanceAsync().catch(() => {});
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
    if (isAnalyticsUserExcluded(userId)) return;
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
    if (isAnalyticsUserExcluded(userId)) return;
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
    if (isAnalyticsUserExcluded(userId)) return;
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
    if (isAnalyticsUserExcluded(userId)) return;
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
    if (isAnalyticsUserExcluded(userId)) return;
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
    if (isAnalyticsUserExcluded(userId)) return;
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
    void ensureAnalyticsMaintenanceAsync().catch(() => {});
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

function getAppSettingLocal(key) {
    const db = readDb();
    ensureAnalytics(db);
    return db.appSettings?.[String(key)] ?? null;
}

function setAppSettingLocal(key, value) {
    const db = readDb();
    ensureAnalytics(db);
    db.appSettings[String(key)] = value ?? null;
    writeDb(db);
}

export async function getAppSettingAsync(key) {
    const p = getPool();
    if (!p) return getAppSettingLocal(key);
    await ensurePgSchema();
    const res = await p.query(
        "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
        [String(key)]
    );
    return res.rows[0]?.value ?? null;
}

export async function setAppSettingAsync(key, value) {
    const p = getPool();
    if (!p) return setAppSettingLocal(key, value);
    await ensurePgSchema();
    await p.query(
        `
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key)
        DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW()
        `,
        [String(key), value ?? null]
    );
}

export async function getBroadcastDraftAsync() {
    return getAppSettingAsync("broadcast_draft");
}

export async function setBroadcastDraftAsync(value) {
    return setAppSettingAsync("broadcast_draft", value);
}

export async function getAdminLastTextAsync() {
    return getAppSettingAsync("admin_last_text");
}

export async function setAdminLastTextAsync(value) {
    return setAppSettingAsync("admin_last_text", value);
}

function listCardCheckoutRecoveryCandidatesLocal({
    fromTs,
    toTs,
    campaignId = null,
    limit = 200,
}) {
    const db = readDb();
    ensureAnalytics(db);

    const fromMs = Date.parse(fromTs);
    const toMs = Date.parse(toTs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return [];

    const purchasesByUserProduct = new Set();
    for (const [userIdKey, user] of Object.entries(db?.users || {})) {
        if (isAnalyticsUserExcluded(userIdKey)) continue;
        for (const productId of Object.keys(user?.purchases || {})) {
            purchasesByUserProduct.add(`${userIdKey}:${productId}`);
        }
    }

    const alreadyNotifiedUsers = new Set();
    if (campaignId) {
        for (const row of db.analytics.notificationLog || []) {
            if (String(row?.campaignId || "") !== String(campaignId)) continue;
            if (String(row?.status || "") !== "sent") continue;
            alreadyNotifiedUsers.add(Number(row?.userId));
        }
    }

    const latestByUser = new Map();
    for (const event of db.analytics.events || []) {
        const userId = Number(event?.userId);
        if (!Number.isFinite(userId) || isAnalyticsUserExcluded(userId)) continue;
        if (String(event?.eventType || "") !== "click_buy_card") continue;
        const tsMs = Date.parse(event?.ts);
        if (!Number.isFinite(tsMs) || tsMs < fromMs || tsMs >= toMs) continue;
        if (alreadyNotifiedUsers.has(userId)) continue;

        const user = db.analytics.users?.[String(userId)];
        if (user?.canNotify === false) continue;

        const productId = String(event?.productId || "").trim();
        if (!productId) continue;
        if (purchasesByUserProduct.has(`${userId}:${productId}`)) continue;

        const current = latestByUser.get(userId);
        if (!current || String(event?.ts || "") > String(current.lastEventAt || "")) {
            latestByUser.set(userId, {
                userId,
                username: user?.username || null,
                productId,
                city: resolveAnalyticsCity(event),
                lastEventAt: event?.ts || null,
            });
        }
    }

    return Array.from(latestByUser.values())
        .sort((a, b) => String(b.lastEventAt || "").localeCompare(String(a.lastEventAt || "")))
        .slice(0, clampInt(limit, 1, 5000, 200));
}

export async function listCardCheckoutRecoveryCandidatesAsync({
    fromTs,
    toTs,
    campaignId = null,
    limit = 200,
}) {
    const p = getPool();
    if (!p) {
        return listCardCheckoutRecoveryCandidatesLocal({ fromTs, toTs, campaignId, limit });
    }
    await ensurePgSchema();
    const res = await p.query(
        `
        WITH latest_clicks AS (
            SELECT DISTINCT ON (e.user_id)
                e.user_id,
                u.username,
                e.product_id,
                NULLIF(TRIM(e.city), '') AS city,
                e.ts AS last_event_at
            FROM events e
            JOIN users u ON u.user_id = e.user_id
            LEFT JOIN purchases p
                ON p.user_id = e.user_id
               AND p.product_id = e.product_id
            LEFT JOIN notification_log nl
                ON nl.user_id = e.user_id
               AND nl.campaign_id IS NOT DISTINCT FROM $3::text
               AND nl.channel = 'telegram'
               AND nl.status = 'sent'
            WHERE e.event_type = 'click_buy_card'
              AND e.ts >= $1::timestamptz
              AND e.ts < $2::timestamptz
              AND COALESCE(u.can_notify, TRUE) = TRUE
              AND p.user_id IS NULL
              AND ($3::text IS NULL OR nl.user_id IS NULL)
              AND NOT (e.user_id = ANY($5::bigint[]))
            ORDER BY e.user_id, e.ts DESC
        )
        SELECT
            user_id,
            username,
            product_id,
            city,
            last_event_at
        FROM latest_clicks
        ORDER BY last_event_at DESC
        LIMIT $4
        `,
        [fromTs, toTs, campaignId || null, clampInt(limit, 1, 5000, 200), ANALYTICS_EXCLUDE_USER_IDS]
    );

    return res.rows.map((row) => ({
        userId: Number(row.user_id),
        username: row.username || null,
        productId: row.product_id || null,
        city: row.city || resolveAnalyticsCity(row),
        lastEventAt: row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
    }));
}

function listFreeGuideUsersLocal({
    fromTs,
    toTs,
    campaignId = null,
    limit = 200,
}) {
    const db = readDb();
    ensureAnalytics(db);

    const fromMs = Date.parse(fromTs);
    const toMs = Date.parse(toTs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return [];

    const usersWithPurchases = new Set();
    for (const [userIdKey, user] of Object.entries(db?.users || {})) {
        if (isAnalyticsUserExcluded(userIdKey)) continue;
        if (Object.keys(user?.purchases || {}).length > 0) {
            usersWithPurchases.add(Number(userIdKey));
        }
    }

    const alreadyNotifiedUsers = new Set();
    if (campaignId) {
        for (const row of db.analytics.notificationLog || []) {
            if (String(row?.campaignId || "") !== String(campaignId)) continue;
            if (String(row?.status || "") !== "sent") continue;
            alreadyNotifiedUsers.add(Number(row?.userId));
        }
    }

    const latestByUser = new Map();
    for (const event of db.analytics.events || []) {
        const userId = Number(event?.userId);
        if (!Number.isFinite(userId) || isAnalyticsUserExcluded(userId)) continue;
        if (String(event?.eventType || "") !== "click_get_file") continue;
        const productId = String(event?.productId || "").trim();
        if (!productId.endsWith("_mini")) continue;
        const tsMs = Date.parse(event?.ts);
        if (!Number.isFinite(tsMs) || tsMs < fromMs || tsMs >= toMs) continue;
        if (alreadyNotifiedUsers.has(userId)) continue;
        if (usersWithPurchases.has(userId)) continue;

        const user = db.analytics.users?.[String(userId)];
        if (user?.canNotify === false) continue;

        const current = latestByUser.get(userId);
        if (!current || String(event?.ts || "") > String(current.lastEventAt || "")) {
            latestByUser.set(userId, {
                userId,
                username: user?.username || null,
                productId,
                city: resolveAnalyticsCity(event),
                lastEventAt: event?.ts || null,
            });
        }
    }

    return Array.from(latestByUser.values())
        .sort((a, b) => String(b.lastEventAt || "").localeCompare(String(a.lastEventAt || "")))
        .slice(0, clampInt(limit, 1, 5000, 200));
}

export async function listFreeGuideUsersAsync({
    fromTs,
    toTs,
    campaignId = null,
    limit = 200,
}) {
    const p = getPool();
    if (!p) {
        return listFreeGuideUsersLocal({ fromTs, toTs, campaignId, limit });
    }
    await ensurePgSchema();
    const res = await p.query(
        `
        WITH latest_downloads AS (
            SELECT DISTINCT ON (e.user_id)
                e.user_id,
                u.username,
                e.product_id,
                NULLIF(TRIM(e.city), '') AS city,
                e.ts AS last_event_at
            FROM events e
            JOIN users u ON u.user_id = e.user_id
            LEFT JOIN purchases p
                ON p.user_id = e.user_id
            LEFT JOIN notification_log nl
                ON nl.user_id = e.user_id
               AND nl.campaign_id IS NOT DISTINCT FROM $3::text
               AND nl.channel = 'telegram'
               AND nl.status = 'sent'
            WHERE e.event_type = 'click_get_file'
              AND RIGHT(COALESCE(e.product_id, ''), 5) = '_mini'
              AND e.ts >= $1::timestamptz
              AND e.ts < $2::timestamptz
              AND COALESCE(u.can_notify, TRUE) = TRUE
              AND p.user_id IS NULL
              AND ($3::text IS NULL OR nl.user_id IS NULL)
              AND NOT (e.user_id = ANY($5::bigint[]))
            ORDER BY e.user_id, e.ts DESC
        )
        SELECT
            user_id,
            username,
            product_id,
            city,
            last_event_at
        FROM latest_downloads
        ORDER BY last_event_at DESC
        LIMIT $4
        `,
        [fromTs, toTs, campaignId || null, clampInt(limit, 1, 5000, 200), ANALYTICS_EXCLUDE_USER_IDS]
    );

    return res.rows.map((row) => ({
        userId: Number(row.user_id),
        username: row.username || null,
        productId: row.product_id || null,
        city: row.city || resolveAnalyticsCity(row),
        lastEventAt: row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
    }));
}

function listAllNotifiableUsersLocal({
    campaignId = null,
    limit = 200,
}) {
    const db = readDb();
    ensureAnalytics(db);

    const alreadyNotifiedUsers = new Set();
    if (campaignId) {
        for (const row of db.analytics.notificationLog || []) {
            if (String(row?.campaignId || "") !== String(campaignId)) continue;
            if (String(row?.status || "") !== "sent") continue;
            alreadyNotifiedUsers.add(Number(row?.userId));
        }
    }

    const rows = Object.values(db.analytics.users || {})
        .filter((user) => {
            const userId = Number(user?.userId);
            if (!Number.isFinite(userId)) return false;
            if (isAnalyticsUserExcluded(userId)) return false;
            if (user?.canNotify === false) return false;
            if (alreadyNotifiedUsers.has(userId)) return false;
            return true;
        })
        .map((user) => ({
            userId: Number(user.userId),
            username: user.username || null,
            productId: null,
            city: null,
            lastEventAt: user.lastSeenAt || user.firstSeenAt || null,
        }))
        .sort((a, b) => String(b.lastEventAt || "").localeCompare(String(a.lastEventAt || "")))
        .slice(0, clampInt(limit, 1, 5000, 200));

    return rows;
}

export async function listAllNotifiableUsersAsync({
    campaignId = null,
    limit = 200,
}) {
    const p = getPool();
    if (!p) {
        return listAllNotifiableUsersLocal({ campaignId, limit });
    }
    await ensurePgSchema();
    const res = await p.query(
        `
        SELECT
            u.user_id,
            u.username,
            u.last_seen_at
        FROM users u
        LEFT JOIN notification_log nl
            ON nl.user_id = u.user_id
           AND nl.campaign_id IS NOT DISTINCT FROM $1::text
           AND nl.channel = 'telegram'
           AND nl.status = 'sent'
        WHERE COALESCE(u.can_notify, TRUE) = TRUE
          AND ($1::text IS NULL OR nl.user_id IS NULL)
          AND NOT (u.user_id = ANY($3::bigint[]))
        ORDER BY u.last_seen_at DESC
        LIMIT $2
        `,
        [campaignId || null, clampInt(limit, 1, 5000, 200), ANALYTICS_EXCLUDE_USER_IDS]
    );

    return res.rows.map((row) => ({
        userId: Number(row.user_id),
        username: row.username || null,
        productId: null,
        city: null,
        lastEventAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    }));
}

async function runAnalyticsMaintenanceAsync() {
    const p = getPool();
    if (!p) return;
    await ensurePgSchema();

    await p.query(
        `
        WITH e AS (
            SELECT
                (ts AT TIME ZONE 'Europe/Moscow')::date AS day,
                COUNT(*) FILTER (WHERE event_type = 'app_open') AS app_opens,
                COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'app_open') AS dau,
                COUNT(*) FILTER (WHERE event_type = 'click_buy_card') AS buy_card_clicks,
                COUNT(*) FILTER (WHERE event_type = 'click_buy_usdt') AS buy_usdt_clicks,
                COUNT(*) FILTER (WHERE event_type = 'click_buy_stars') AS buy_stars_clicks,
                COUNT(*) FILTER (WHERE event_type = 'usdt_submit_success') AS usdt_requests,
                COUNT(*) FILTER (WHERE event_type = 'click_get_file') AS free_download_clicks
            FROM events
            WHERE ts >= NOW() - ($1::int * INTERVAL '1 day')
              AND NOT (user_id = ANY($2::bigint[]))
            GROUP BY 1
        ),
        pur AS (
            SELECT
                (paid_at AT TIME ZONE 'Europe/Moscow')::date AS day,
                COUNT(*) AS paid_purchases
            FROM purchases
            WHERE paid_at >= NOW() - ($1::int * INTERVAL '1 day')
              AND NOT (user_id = ANY($2::bigint[]))
            GROUP BY 1
        ),
        merged AS (
            SELECT
                COALESCE(e.day, pur.day) AS day,
                COALESCE(e.dau, 0) AS dau,
                COALESCE(e.app_opens, 0) AS app_opens,
                COALESCE(e.buy_card_clicks, 0) AS buy_card_clicks,
                COALESCE(e.buy_usdt_clicks, 0) AS buy_usdt_clicks,
                COALESCE(e.buy_stars_clicks, 0) AS buy_stars_clicks,
                COALESCE(e.usdt_requests, 0) AS usdt_requests,
                COALESCE(e.free_download_clicks, 0) AS free_download_clicks,
                COALESCE(pur.paid_purchases, 0) AS paid_purchases
            FROM e
            FULL JOIN pur USING (day)
        )
        INSERT INTO daily_metrics (
            day,
            dau,
            app_opens,
            buy_card_clicks,
            buy_usdt_clicks,
            buy_stars_clicks,
            usdt_requests,
            free_download_clicks,
            paid_purchases,
            computed_at
        )
        SELECT
            day,
            dau,
            app_opens,
            buy_card_clicks,
            buy_usdt_clicks,
            buy_stars_clicks,
            usdt_requests,
            free_download_clicks,
            paid_purchases,
            NOW()
        FROM merged
        ON CONFLICT (day)
        DO UPDATE SET
            dau = EXCLUDED.dau,
            app_opens = EXCLUDED.app_opens,
            buy_card_clicks = EXCLUDED.buy_card_clicks,
            buy_usdt_clicks = EXCLUDED.buy_usdt_clicks,
            buy_stars_clicks = EXCLUDED.buy_stars_clicks,
            usdt_requests = EXCLUDED.usdt_requests,
            free_download_clicks = EXCLUDED.free_download_clicks,
            paid_purchases = EXCLUDED.paid_purchases,
            computed_at = NOW()
        `,
        [ANALYTICS_ROLLUP_DAYS, ANALYTICS_EXCLUDE_USER_IDS]
    );

    await p.query(
        `
        DELETE FROM daily_metrics
        WHERE day < (NOW() AT TIME ZONE 'Europe/Moscow')::date - ($1::int - 1)
        `,
        [ANALYTICS_ROLLUP_DAYS]
    );

    await p.query(
        `
        DELETE FROM events
        WHERE ts < NOW() - ($1::int * INTERVAL '1 day')
        `,
        [ANALYTICS_EVENTS_RETENTION_DAYS]
    );
}

async function ensureAnalyticsMaintenanceAsync({ force = false } = {}) {
    const p = getPool();
    if (!p) return;

    const now = Date.now();
    if (
        !force &&
        analyticsMaintenanceLastAt > 0 &&
        now - analyticsMaintenanceLastAt < ANALYTICS_MAINTENANCE_INTERVAL_MS
    ) {
        return;
    }

    if (analyticsMaintenancePromise) {
        return analyticsMaintenancePromise;
    }

    analyticsMaintenancePromise = runAnalyticsMaintenanceAsync()
        .then(() => {
            analyticsMaintenanceLastAt = Date.now();
        })
        .finally(() => {
            analyticsMaintenancePromise = null;
        });

    return analyticsMaintenancePromise;
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return Math.min(max, Math.max(min, i));
}

function toMoscowDayKey(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return MOSCOW_DAY_FORMATTER.format(d);
}

function emptyDayRow(day) {
    return {
        day,
        dau: 0,
        app_opens: 0,
        buy_card_clicks: 0,
        buy_usdt_clicks: 0,
        buy_stars_clicks: 0,
        usdt_requests: 0,
        free_download_clicks: 0,
        paid_purchases: 0,
    };
}

function localPurchasesAll(db) {
    const rows = [];
    const users = db?.users || {};
    for (const [userIdKey, user] of Object.entries(users)) {
        if (isAnalyticsUserExcluded(userIdKey)) continue;
        const purchases = user?.purchases || {};
        for (const [productId, purchase] of Object.entries(purchases)) {
            rows.push({
                userId: Number(userIdKey),
                productId,
                paidAt: purchase?.paidAt || null,
            });
        }
    }
    return rows;
}

function buildDailyLocal(events, purchases, days) {
    const now = new Date();
    const today = toMoscowDayKey(now);
    const startDate = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    const minDay = toMoscowDayKey(startDate);
    const byDay = new Map();
    const dauSets = new Map();

    for (const e of events || []) {
        if (isAnalyticsUserExcluded(e?.userId)) continue;
        const day = toMoscowDayKey(e?.ts);
        if (!day || (minDay && day < minDay) || (today && day > today)) continue;

        if (!byDay.has(day)) byDay.set(day, emptyDayRow(day));
        const row = byDay.get(day);
        const type = String(e?.eventType || "");
        if (type === "app_open") {
            row.app_opens += 1;
            const uid = Number(e?.userId);
            if (Number.isFinite(uid)) {
                if (!dauSets.has(day)) dauSets.set(day, new Set());
                dauSets.get(day).add(uid);
            }
        } else if (type === "click_buy_card") {
            row.buy_card_clicks += 1;
        } else if (type === "click_buy_usdt") {
            row.buy_usdt_clicks += 1;
        } else if (type === "click_buy_stars") {
            row.buy_stars_clicks += 1;
        } else if (type === "usdt_submit_success") {
            row.usdt_requests += 1;
        } else if (type === "click_get_file") {
            row.free_download_clicks += 1;
        }
    }

    for (const purchase of purchases || []) {
        if (isAnalyticsUserExcluded(purchase?.userId)) continue;
        const day = toMoscowDayKey(purchase?.paidAt);
        if (!day || (minDay && day < minDay) || (today && day > today)) continue;
        if (!byDay.has(day)) byDay.set(day, emptyDayRow(day));
        byDay.get(day).paid_purchases += 1;
    }

    for (const [day, set] of dauSets.entries()) {
        const row = byDay.get(day);
        if (row) row.dau = set.size;
    }

    return Array.from(byDay.values()).sort((a, b) => String(b.day).localeCompare(String(a.day)));
}

function parseDayKeyUtc(dayKey) {
    const parts = String(dayKey || "").split("-");
    if (parts.length !== 3) return null;
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return new Date(Date.UTC(year, month - 1, day));
}

function toDayKeyUtc(date) {
    return date.toISOString().slice(0, 10);
}

function addDaysUtc(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfWeekUtc(date) {
    const day = date.getUTCDay();
    const diff = (day + 6) % 7;
    return addDaysUtc(date, -diff);
}

function startOfMonthUtc(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonthUtc(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function buildPeriodRollupLocal(daily, mode) {
    const buckets = new Map();
    for (const row of daily || []) {
        const dayDate = parseDayKeyUtc(row?.day);
        if (!dayDate) continue;

        const periodStartDate = mode === "month" ? startOfMonthUtc(dayDate) : startOfWeekUtc(dayDate);
        const periodStart = toDayKeyUtc(periodStartDate);

        if (!buckets.has(periodStart)) {
            const periodEndDate =
                mode === "month" ? endOfMonthUtc(periodStartDate) : addDaysUtc(periodStartDate, 6);
            buckets.set(periodStart, {
                period_start: periodStart,
                period_end: toDayKeyUtc(periodEndDate),
                days_count: 0,
                dau_sum: 0,
                dau_peak: 0,
                app_opens: 0,
                buy_card_clicks: 0,
                buy_usdt_clicks: 0,
                buy_stars_clicks: 0,
                usdt_requests: 0,
                free_download_clicks: 0,
                paid_purchases: 0,
            });
        }

        const bucket = buckets.get(periodStart);
        const dau = Number(row?.dau || 0);
        bucket.days_count += 1;
        bucket.dau_sum += dau;
        bucket.dau_peak = Math.max(bucket.dau_peak, dau);
        bucket.app_opens += Number(row?.app_opens || 0);
        bucket.buy_card_clicks += Number(row?.buy_card_clicks || 0);
        bucket.buy_usdt_clicks += Number(row?.buy_usdt_clicks || 0);
        bucket.buy_stars_clicks += Number(row?.buy_stars_clicks || 0);
        bucket.usdt_requests += Number(row?.usdt_requests || 0);
        bucket.free_download_clicks += Number(row?.free_download_clicks || 0);
        bucket.paid_purchases += Number(row?.paid_purchases || 0);
    }

    return Array.from(buckets.values())
        .map((bucket) => ({
            period_start: bucket.period_start,
            period_end: bucket.period_end,
            days_count: bucket.days_count,
            dau_avg:
                bucket.days_count > 0
                    ? Number((bucket.dau_sum / bucket.days_count).toFixed(1))
                    : 0,
            dau_peak: bucket.dau_peak,
            app_opens: bucket.app_opens,
            buy_card_clicks: bucket.buy_card_clicks,
            buy_usdt_clicks: bucket.buy_usdt_clicks,
            buy_stars_clicks: bucket.buy_stars_clicks,
            usdt_requests: bucket.usdt_requests,
            free_download_clicks: bucket.free_download_clicks,
            paid_purchases: bucket.paid_purchases,
        }))
        .sort((a, b) => String(b.period_start).localeCompare(String(a.period_start)));
}

function buildTopCitiesLocal(events, days) {
    const startDate = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
    const minDay = toMoscowDayKey(startDate);
    const counters = new Map();
    const productCityMap = readCatalogProductCityMap();
    for (const e of events || []) {
        if (isAnalyticsUserExcluded(e?.userId)) continue;
        const day = toMoscowDayKey(e?.ts);
        if (!day || (minDay && day < minDay)) continue;
        const type = String(e?.eventType || "");
        const isCityMetricType =
            type === "city_focus" ||
            type === "click_get_file" ||
            type === "click_buy_card" ||
            type === "click_buy_usdt" ||
            type === "click_buy_stars";
        if (!isCityMetricType) continue;

        const city = resolveAnalyticsCity(e, productCityMap);
        if (!city) continue;
        if (!counters.has(city)) {
            counters.set(city, { city, city_focuses: 0, free_clicks: 0, buy_clicks: 0 });
        }
        const row = counters.get(city);
        if (type === "city_focus") row.city_focuses += 1;
        if (type === "click_get_file") row.free_clicks += 1;
        if (
            type === "click_buy_card" ||
            type === "click_buy_usdt" ||
            type === "click_buy_stars"
        ) {
            row.buy_clicks += 1;
        }
    }
    return Array.from(counters.values()).sort((a, b) => {
        if (b.buy_clicks !== a.buy_clicks) return b.buy_clicks - a.buy_clicks;
        if (b.free_clicks !== a.free_clicks) return b.free_clicks - a.free_clicks;
        if (b.city_focuses !== a.city_focuses) return b.city_focuses - a.city_focuses;
        return String(a.city).localeCompare(String(b.city));
    });
}

function buildUsersLastSeenLocal(db) {
    const users = Object.values(db?.analytics?.users || {})
        .filter((u) => !isAnalyticsUserExcluded(u?.userId))
        .map((u) => ({
            user_id: Number(u?.userId),
            username: u?.username || null,
            language_code: u?.languageCode || null,
            opens_count: Number(u?.opensCount || 0),
            last_platform: u?.lastPlatform || null,
            first_seen_at: u?.firstSeenAt || null,
            last_seen_at: u?.lastSeenAt || null,
        }));
    users.sort((a, b) => String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")));
    return users;
}

function getAdminAnalyticsLocal({ days, topCitiesLimit, usersLimit }) {
    const db = readDb();
    ensureAnalytics(db);
    const events = db.analytics.events || [];
    const purchases = localPurchasesAll(db);
    const daily = buildDailyLocal(events, purchases, days);
    const topCities = buildTopCitiesLocal(events, days).slice(0, topCitiesLimit);
    const usersLastSeen = buildUsersLastSeenLocal(db).slice(0, usersLimit);
    const usersTotal = Object.values(db?.analytics?.users || {}).filter(
        (u) => !isAnalyticsUserExcluded(u?.userId)
    ).length;
    const buyersSet = new Set(purchases.map((p) => Number(p.userId)).filter((v) => Number.isFinite(v)));
    return {
        generatedAt: new Date().toISOString(),
        rangeDays: days,
        summary: {
            users_total: usersTotal,
            purchases_total: purchases.length,
            buyers_total: buyersSet.size,
        },
        daily,
        weekly: buildPeriodRollupLocal(daily, "week"),
        monthly: buildPeriodRollupLocal(daily, "month"),
        topCities,
        usersLastSeen,
    };
}

export async function getAdminAnalyticsAsync(options = {}) {
    const days = clampInt(options.days, 1, 120, 30);
    const topCitiesLimit = clampInt(options.topCitiesLimit, 1, 50, 15);
    const usersLimit = clampInt(options.usersLimit, 1, 200, 50);

    const p = getPool();
    if (!p) {
        return getAdminAnalyticsLocal({ days, topCitiesLimit, usersLimit });
    }

    await ensurePgSchema();
    try {
        await ensureAnalyticsMaintenanceAsync({ force: true });
    } catch (error) {
        console.error("[analytics_maintenance_failed]", error?.message || error);
    }

    const dailyRes = await p.query(
        `
        SELECT
            TO_CHAR(day, 'YYYY-MM-DD') AS day,
            dau,
            app_opens,
            buy_card_clicks,
            buy_usdt_clicks,
            buy_stars_clicks,
            usdt_requests,
            free_download_clicks,
            paid_purchases
        FROM daily_metrics
        WHERE day >= (NOW() AT TIME ZONE 'Europe/Moscow')::date - ($1::int - 1)
        ORDER BY day DESC
        LIMIT $1
        `,
        [days]
    );

    const topCitiesEventsRes = await p.query(
        `
        SELECT
            ts,
            user_id,
            event_type,
            NULLIF(TRIM(city), '') AS city,
            product_id
        FROM events
        WHERE ts >= NOW() - ($1::int * INTERVAL '1 day')
          AND event_type IN ('city_focus', 'click_get_file', 'click_buy_card', 'click_buy_usdt', 'click_buy_stars')
          AND NOT (user_id = ANY($2::bigint[]))
        `,
        [days, ANALYTICS_EXCLUDE_USER_IDS]
    );
    const topCities = buildTopCitiesLocal(
        topCitiesEventsRes.rows.map((row) => ({
            ts: row.ts,
            userId: Number(row.user_id),
            eventType: row.event_type,
            city: row.city,
            productId: row.product_id,
        })),
        days
    ).slice(0, topCitiesLimit);

    const usersRes = await p.query(
        `
        SELECT
            user_id,
            username,
            language_code,
            opens_count,
            last_platform,
            first_seen_at,
            last_seen_at
        FROM users
        WHERE NOT (user_id = ANY($2::bigint[]))
        ORDER BY last_seen_at DESC
        LIMIT $1
        `,
        [usersLimit, ANALYTICS_EXCLUDE_USER_IDS]
    );

    const summaryRes = await p.query(
        `
        SELECT
            (SELECT COUNT(*)::int FROM users WHERE NOT (user_id = ANY($1::bigint[]))) AS users_total,
            (SELECT COUNT(*)::int FROM purchases WHERE NOT (user_id = ANY($1::bigint[]))) AS purchases_total,
            (SELECT COUNT(DISTINCT user_id)::int FROM purchases WHERE NOT (user_id = ANY($1::bigint[]))) AS buyers_total
        `,
        [ANALYTICS_EXCLUDE_USER_IDS]
    );

    const weeklyRes = await p.query(
        `
        WITH sliced AS (
            SELECT
                day,
                dau,
                app_opens,
                buy_card_clicks,
                buy_usdt_clicks,
                buy_stars_clicks,
                usdt_requests,
                free_download_clicks,
                paid_purchases
            FROM daily_metrics
            WHERE day >= (NOW() AT TIME ZONE 'Europe/Moscow')::date - ($1::int - 1)
        )
        SELECT
            TO_CHAR(date_trunc('week', day::timestamp)::date, 'YYYY-MM-DD') AS period_start,
            TO_CHAR((date_trunc('week', day::timestamp)::date + 6), 'YYYY-MM-DD') AS period_end,
            COUNT(*)::int AS days_count,
            ROUND(AVG(dau)::numeric, 1) AS dau_avg,
            MAX(dau)::int AS dau_peak,
            SUM(app_opens)::int AS app_opens,
            SUM(buy_card_clicks)::int AS buy_card_clicks,
            SUM(buy_usdt_clicks)::int AS buy_usdt_clicks,
            SUM(buy_stars_clicks)::int AS buy_stars_clicks,
            SUM(usdt_requests)::int AS usdt_requests,
            SUM(free_download_clicks)::int AS free_download_clicks,
            SUM(paid_purchases)::int AS paid_purchases
        FROM sliced
        GROUP BY 1, 2
        ORDER BY period_start DESC
        `,
        [days]
    );

    const monthlyRes = await p.query(
        `
        WITH sliced AS (
            SELECT
                day,
                dau,
                app_opens,
                buy_card_clicks,
                buy_usdt_clicks,
                buy_stars_clicks,
                usdt_requests,
                free_download_clicks,
                paid_purchases
            FROM daily_metrics
            WHERE day >= (NOW() AT TIME ZONE 'Europe/Moscow')::date - ($1::int - 1)
        )
        SELECT
            TO_CHAR(date_trunc('month', day::timestamp)::date, 'YYYY-MM-DD') AS period_start,
            TO_CHAR((date_trunc('month', day::timestamp)::date + INTERVAL '1 month - 1 day')::date, 'YYYY-MM-DD') AS period_end,
            COUNT(*)::int AS days_count,
            ROUND(AVG(dau)::numeric, 1) AS dau_avg,
            MAX(dau)::int AS dau_peak,
            SUM(app_opens)::int AS app_opens,
            SUM(buy_card_clicks)::int AS buy_card_clicks,
            SUM(buy_usdt_clicks)::int AS buy_usdt_clicks,
            SUM(buy_stars_clicks)::int AS buy_stars_clicks,
            SUM(usdt_requests)::int AS usdt_requests,
            SUM(free_download_clicks)::int AS free_download_clicks,
            SUM(paid_purchases)::int AS paid_purchases
        FROM sliced
        GROUP BY 1, 2
        ORDER BY period_start DESC
        `,
        [days]
    );

    return {
        generatedAt: new Date().toISOString(),
        rangeDays: days,
        summary: {
            users_total: Number(summaryRes.rows[0]?.users_total || 0),
            purchases_total: Number(summaryRes.rows[0]?.purchases_total || 0),
            buyers_total: Number(summaryRes.rows[0]?.buyers_total || 0),
        },
        daily: dailyRes.rows.map((row) => ({
            day: row.day,
            dau: Number(row.dau || 0),
            app_opens: Number(row.app_opens || 0),
            buy_card_clicks: Number(row.buy_card_clicks || 0),
            buy_usdt_clicks: Number(row.buy_usdt_clicks || 0),
            buy_stars_clicks: Number(row.buy_stars_clicks || 0),
            usdt_requests: Number(row.usdt_requests || 0),
            free_download_clicks: Number(row.free_download_clicks || 0),
            paid_purchases: Number(row.paid_purchases || 0),
        })),
        weekly: weeklyRes.rows.map((row) => ({
            period_start: row.period_start,
            period_end: row.period_end,
            days_count: Number(row.days_count || 0),
            dau_avg: Number(row.dau_avg || 0),
            dau_peak: Number(row.dau_peak || 0),
            app_opens: Number(row.app_opens || 0),
            buy_card_clicks: Number(row.buy_card_clicks || 0),
            buy_usdt_clicks: Number(row.buy_usdt_clicks || 0),
            buy_stars_clicks: Number(row.buy_stars_clicks || 0),
            usdt_requests: Number(row.usdt_requests || 0),
            free_download_clicks: Number(row.free_download_clicks || 0),
            paid_purchases: Number(row.paid_purchases || 0),
        })),
        monthly: monthlyRes.rows.map((row) => ({
            period_start: row.period_start,
            period_end: row.period_end,
            days_count: Number(row.days_count || 0),
            dau_avg: Number(row.dau_avg || 0),
            dau_peak: Number(row.dau_peak || 0),
            app_opens: Number(row.app_opens || 0),
            buy_card_clicks: Number(row.buy_card_clicks || 0),
            buy_usdt_clicks: Number(row.buy_usdt_clicks || 0),
            buy_stars_clicks: Number(row.buy_stars_clicks || 0),
            usdt_requests: Number(row.usdt_requests || 0),
            free_download_clicks: Number(row.free_download_clicks || 0),
            paid_purchases: Number(row.paid_purchases || 0),
        })),
        topCities,
        usersLastSeen: usersRes.rows.map((row) => ({
            user_id: Number(row.user_id),
            username: row.username || null,
            language_code: row.language_code || null,
            opens_count: Number(row.opens_count || 0),
            last_platform: row.last_platform || null,
            first_seen_at: row.first_seen_at
                ? new Date(row.first_seen_at).toISOString()
                : null,
            last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
        })),
    };
}
