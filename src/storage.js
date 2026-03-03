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

let analyticsMaintenancePromise = null;
let analyticsMaintenanceLastAt = 0;

function clampConfigInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return Math.min(max, Math.max(min, i));
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
            GROUP BY 1
        ),
        pur AS (
            SELECT
                (paid_at AT TIME ZONE 'Europe/Moscow')::date AS day,
                COUNT(*) AS paid_purchases
            FROM purchases
            WHERE paid_at >= NOW() - ($1::int * INTERVAL '1 day')
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
        [ANALYTICS_ROLLUP_DAYS]
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
    for (const e of events || []) {
        const day = toMoscowDayKey(e?.ts);
        if (!day || (minDay && day < minDay)) continue;
        const city = String(e?.city || "").trim() || "unknown";
        if (!counters.has(city)) {
            counters.set(city, { city, city_focuses: 0, buy_clicks: 0 });
        }
        const row = counters.get(city);
        const type = String(e?.eventType || "");
        if (type === "city_focus") row.city_focuses += 1;
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
        if (b.city_focuses !== a.city_focuses) return b.city_focuses - a.city_focuses;
        return String(a.city).localeCompare(String(b.city));
    });
}

function buildUsersLastSeenLocal(db) {
    const users = Object.values(db?.analytics?.users || {}).map((u) => ({
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
    const usersTotal = Object.keys(db?.analytics?.users || {}).length;
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

    const topCitiesRes = await p.query(
        `
        SELECT
            COALESCE(NULLIF(city, ''), 'unknown') AS city,
            COUNT(*) FILTER (WHERE event_type = 'city_focus') AS city_focuses,
            COUNT(*) FILTER (
                WHERE event_type IN ('click_buy_card', 'click_buy_usdt', 'click_buy_stars')
            ) AS buy_clicks
        FROM events
        WHERE ts >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY 1
        ORDER BY buy_clicks DESC, city_focuses DESC, city ASC
        LIMIT $2
        `,
        [days, topCitiesLimit]
    );

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
        ORDER BY last_seen_at DESC
        LIMIT $1
        `,
        [usersLimit]
    );

    const summaryRes = await p.query(
        `
        SELECT
            (SELECT COUNT(*)::int FROM users) AS users_total,
            (SELECT COUNT(*)::int FROM purchases) AS purchases_total,
            (SELECT COUNT(DISTINCT user_id)::int FROM purchases) AS buyers_total
        `
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
        topCities: topCitiesRes.rows.map((row) => ({
            city: row.city,
            city_focuses: Number(row.city_focuses || 0),
            buy_clicks: Number(row.buy_clicks || 0),
        })),
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
