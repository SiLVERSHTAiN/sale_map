import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { listPurchasesAsync } from "./storage.js";

function timingSafeEqualHex(a, b) {
    const aBuf = Buffer.from(a || "", "hex");
    const bBuf = Buffer.from(b || "", "hex");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseInitData(initData) {
    const params = new URLSearchParams(String(initData || ""));
    const data = {};
    for (const [k, v] of params.entries()) data[k] = v;
    return data;
}

function buildCheckString(data) {
    return Object.keys(data)
        .filter((k) => k !== "hash")
        .sort()
        .map((k) => `${k}=${data[k]}`)
        .join("\n");
}

function verifyInitData(initData, botToken) {
    const data = parseInitData(initData);
    const hash = data.hash;
    if (!hash || !botToken) return null;
    const checkString = buildCheckString(data);
    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest();
    const signature = crypto
        .createHmac("sha256", secretKey)
        .update(checkString)
        .digest("hex");
    if (!timingSafeEqualHex(signature, hash)) return null;
    return data;
}

function parseUserId(data) {
    if (!data?.user) return null;
    try {
        const u = JSON.parse(data.user);
        return Number(u?.id) || null;
    } catch {
        return null;
    }
}

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function sendJson(res, status, payload) {
    setCors(res);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
        });
        req.on("end", () => {
            if (!raw) return resolve(null);
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve(null);
            }
        });
    });
}

function readRawBody(req) {
    return new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
        });
        req.on("end", () => resolve(raw));
    });
}

function safeJsonParse(s) {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

function base64UrlDecode(input) {
    const b64 = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    return Buffer.from(b64 + pad, "base64").toString("utf8");
}

function base64UrlEncode(buf) {
    return Buffer.from(buf)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function verifyPostbackToken(token, secret) {
    if (!token || !secret) return null;
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const data = `${headerB64}.${payloadB64}`;
    const expected = crypto.createHmac("sha256", secret).update(data).digest();
    const expectedB64 = base64UrlEncode(expected);
    if (expectedB64 !== sigB64) return null;
    const payloadJson = base64UrlDecode(payloadB64);
    const payload = safeJsonParse(payloadJson);
    if (!payload) return null;
    if (payload.exp && Date.now() / 1000 > Number(payload.exp) + 30) return null;
    return payload;
}

function abs(p) {
    return path.resolve(process.cwd(), p);
}

function readCatalog() {
    const file = abs(process.env.CATALOG_PATH || "./docs/products.json");
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
        return null;
    }
}

export function startApiServer({ port, botToken, onAction, onCryptoPaid }) {
    const server = http.createServer(async (req, res) => {
        setCors(res);
        if (req.method === "OPTIONS") {
            res.statusCode = 204;
            return res.end();
        }

        const url = new URL(req.url || "/", "http://localhost");
        const isJsonRequest = req.headers["content-type"]?.includes("application/json");

        if (url.pathname === "/health" || url.pathname === "/api/health") {
            return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/entitlements") {
            let initData = url.searchParams.get("initData");
            if (!initData && req.method === "POST") {
                const body = await readJsonBody(req);
                initData = body?.initData;
            }

            if (!initData) {
                return sendJson(res, 400, { ok: false, error: "initData_required" });
            }

            const verified = verifyInitData(initData, botToken);
            if (!verified) {
                return sendJson(res, 401, { ok: false, error: "invalid_init_data" });
            }

            const userId = parseUserId(verified);
            if (!userId) {
                return sendJson(res, 400, { ok: false, error: "user_id_missing" });
            }

            const purchasesDetailed = await listPurchasesAsync(userId);
            const purchases = purchasesDetailed.map((p) => p.productId);
            return sendJson(res, 200, { ok: true, userId, purchases, purchasesDetailed });
        }

        if (url.pathname === "/api/crypto/invoice") {
            if (req.method !== "POST" || !isJsonRequest) {
                return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
            }

            const body = await readJsonBody(req);
            const initData = body?.initData;
            const productId = body?.productId;

            if (!initData || !productId) {
                return sendJson(res, 400, { ok: false, error: "initData_or_product_missing" });
            }

            const verified = verifyInitData(initData, botToken);
            if (!verified) {
                return sendJson(res, 401, { ok: false, error: "invalid_init_data" });
            }

            const userId = parseUserId(verified);
            if (!userId) {
                return sendJson(res, 400, { ok: false, error: "user_id_missing" });
            }

            const catalog = readCatalog();
            const products = Array.isArray(catalog?.products) ? catalog.products : [];
            const product = products.find((p) => p && p.id === productId && p.active !== false);
            const amount = Number(product?.priceUsdt || 0);

            if (!product || !Number.isFinite(amount) || amount <= 0) {
                return sendJson(res, 400, { ok: false, error: "invalid_product" });
            }

            const apiKey = process.env.CRYPTOCLOUD_API_KEY;
            const shopId = process.env.CRYPTOCLOUD_SHOP_ID;
            if (!apiKey || !shopId) {
                return sendJson(res, 500, { ok: false, error: "crypto_config_missing" });
            }

            const orderId = `${userId}:${productId}:${Date.now().toString(36)}`;
            try {
                const availableCurrenciesRaw = process.env.CRYPTOCLOUD_AVAILABLE_CURRENCIES || "";
                const availableCurrencies = availableCurrenciesRaw
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);

                const payload = {
                    shop_id: shopId,
                    amount,
                    currency: "USD",
                    order_id: orderId,
                    add_fields: {
                        product_id: productId,
                        user_id: String(userId),
                    },
                };

                if (availableCurrencies.length) {
                    payload.add_fields.available_currencies = availableCurrencies;
                }

                const resp = await fetch("https://api.cryptocloud.plus/v2/invoice/create", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Token ${apiKey}`,
                    },
                    body: JSON.stringify(payload),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok || data?.status !== "success") {
                    return sendJson(res, 502, { ok: false, error: "crypto_create_failed" });
                }
                const payUrl = data?.link || data?.pay_url || data?.invoice_url;
                if (!payUrl) {
                    return sendJson(res, 502, { ok: false, error: "crypto_no_link" });
                }
                return sendJson(res, 200, { ok: true, payUrl, orderId });
            } catch {
                return sendJson(res, 502, { ok: false, error: "crypto_request_failed" });
            }
        }

        if (url.pathname === "/api/crypto/postback") {
            const raw = await readRawBody(req);
            const body = safeJsonParse(raw) || Object.fromEntries(new URLSearchParams(raw));
            const token = body?.token || body?.jwt || body?.signature || null;
            const secret = process.env.CRYPTOCLOUD_POSTBACK_SECRET;

            if (!token || !secret) {
                return sendJson(res, 400, { ok: false, error: "crypto_token_missing" });
            }

            const verified = verifyPostbackToken(token, secret);
            if (!verified) {
                return sendJson(res, 401, { ok: false, error: "crypto_token_invalid" });
            }

            const invoice = body?.invoice_info || body?.invoice || {};
            const orderId = body?.order_id || invoice?.order_id;
            const status = String(body?.status || invoice?.invoice_status || invoice?.status || "");

            if (!orderId) {
                return sendJson(res, 400, { ok: false, error: "order_id_missing" });
            }

            if (status && !["success", "paid", "overpaid"].includes(status)) {
                return sendJson(res, 200, { ok: true });
            }

            const parts = String(orderId).split(":");
            const userId = Number(parts[0]);
            const productId = parts[1];
            if (!Number.isFinite(userId) || !productId) {
                return sendJson(res, 400, { ok: false, error: "order_id_invalid" });
            }

            if (typeof onCryptoPaid === "function") {
                try {
                    await onCryptoPaid({
                        userId,
                        productId,
                        invoice: body,
                    });
                } catch {
                    return sendJson(res, 500, { ok: false, error: "crypto_handler_failed" });
                }
            }

            return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/action") {
            if (req.method !== "POST" || !isJsonRequest) {
                return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
            }

            const body = await readJsonBody(req);
            const initData = body?.initData;
            const action = body?.action;
            const productId = body?.productId || null;

            if (!initData || !action) {
                return sendJson(res, 400, { ok: false, error: "initData_or_action_missing" });
            }

            const verified = verifyInitData(initData, botToken);
            if (!verified) {
                return sendJson(res, 401, { ok: false, error: "invalid_init_data" });
            }

            const userId = parseUserId(verified);
            if (!userId) {
                return sendJson(res, 400, { ok: false, error: "user_id_missing" });
            }

            if (typeof onAction !== "function") {
                return sendJson(res, 500, { ok: false, error: "action_handler_missing" });
            }

            try {
                await onAction({ userId, action, productId });
                return sendJson(res, 200, { ok: true });
            } catch (e) {
                return sendJson(res, 500, { ok: false, error: "action_failed" });
            }
        }

        return sendJson(res, 404, { ok: false, error: "not_found" });
    });

    server.listen(port, () => {
        console.log(`API is running on :${port}`);
    });

    return server;
}
