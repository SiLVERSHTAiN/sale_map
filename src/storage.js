import fs from "fs";
import path from "path";

const DB_PATH = path.resolve("data/db.json");

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
    const db = readDb();
    const u = db.users?.[String(userId)];
    return Boolean(u?.purchases?.[productId]?.paidAt);
}

export function storePurchase({ userId, productId, telegramPaymentChargeId, payload }) {
    const db = readDb();
    const key = String(userId);

    db.users[key] ??= { purchases: {} };
    db.users[key].purchases ??= {};

    db.users[key].purchases[productId] = {
        paidAt: new Date().toISOString(),
        telegramPaymentChargeId,
        payload
    };

    writeDb(db);
}
