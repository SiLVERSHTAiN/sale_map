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
    dbReady = true;
}

function ensureDb() {
    if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify({ users: {} }, null, 2), "utf-8");
    }
}

function readDb() {
    ensureDb();
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDb(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
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
