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

function normalizeTronTxid(input) {
    const raw = String(input || "").trim();
    if (!raw) return null;

    if (/^[a-fA-F0-9]{64}$/.test(raw)) {
        return raw.toLowerCase();
    }

    try {
        const u = new URL(raw);
        const byParam =
            u.searchParams.get("txid") ||
            u.searchParams.get("hash") ||
            u.searchParams.get("transaction");
        if (byParam && /^[a-fA-F0-9]{64}$/.test(byParam)) {
            return byParam.toLowerCase();
        }
        const chunks = [u.pathname, u.hash, u.search];
        for (const chunk of chunks) {
            const m = String(chunk || "").match(/[a-fA-F0-9]{64}/);
            if (m) return m[0].toLowerCase();
        }
    } catch {}

    const m = raw.match(/[a-fA-F0-9]{64}/);
    if (m) return m[0].toLowerCase();
    return null;
}

function abs(p) {
    return path.resolve(process.cwd(), p);
}

function resolveSiteUrl() {
    const raw = process.env.SITE_URL || process.env.WEBAPP_URL || "";
    if (!raw) return "";
    try {
        return new URL(raw).origin;
    } catch {
        return "";
    }
}

async function fetchYookassaPayment(paymentId, shopId, secretKey) {
    if (!paymentId || !shopId || !secretKey) return null;
    const auth = Buffer.from(`${shopId}:${secretKey}`).toString("base64");
    try {
        const resp = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
            method: "GET",
            headers: {
                Authorization: `Basic ${auth}`,
            },
        });
        if (!resp.ok) return null;
        return await resp.json().catch(() => null);
    } catch {
        return null;
    }
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

export function startApiServer({
    port,
    botToken,
    onAction,
    onYookassaPaid,
    onYookassaRefund,
    onManualUsdtRequest,
}) {
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


        if (url.pathname === "/api/yookassa/create") {
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
            const cities = Array.isArray(catalog?.cities) ? catalog.cities : [];
            const product = products.find((p) => p && p.id === productId && p.active !== false);
            const amountValue = Number(product?.priceRub || 0);

            if (!product || !Number.isFinite(amountValue) || amountValue <= 0) {
                return sendJson(res, 400, { ok: false, error: "invalid_product" });
            }

            const shopId = process.env.YOOKASSA_SHOP_ID;
            const secretKey = process.env.YOOKASSA_SECRET_KEY;
            if (!shopId || !secretKey) {
                return sendJson(res, 500, { ok: false, error: "yookassa_config_missing" });
            }

            const siteUrl = resolveSiteUrl();
            if (!siteUrl) {
                return sendJson(res, 500, { ok: false, error: "site_url_missing" });
            }

            const city = cities.find((c) => c && String(c.id) === String(product.cityId)) || {};
            const description =
                product?.description ||
                `${city?.name || "Город"} — ${product?.title || "Путеводитель"}. Файл .kmz для Organic Maps / MAPS.ME.`;

            const payload = {
                amount: { value: amountValue.toFixed(2), currency: "RUB" },
                capture: true,
                confirmation: {
                    type: "redirect",
                    return_url: `${siteUrl}/payment-result`,
                },
                description,
                metadata: {
                    product_id: productId,
                    user_id: String(userId),
                },
            };

            if (String(process.env.YOOKASSA_TEST_MODE || "").toLowerCase() === "true") {
                payload.test = true;
            }

            const auth = Buffer.from(`${shopId}:${secretKey}`).toString("base64");
            const idemKey = crypto.randomUUID();

            try {
                const resp = await fetch("https://api.yookassa.ru/v3/payments", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Idempotence-Key": idemKey,
                        Authorization: `Basic ${auth}`,
                    },
                    body: JSON.stringify(payload),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok || data?.type === "error") {
                    console.error("YOOKASSA_CREATE_FAILED", {
                        httpStatus: resp.status,
                        body: data,
                    });
                    return sendJson(res, 502, {
                        ok: false,
                        error: "yookassa_create_failed",
                        details: data,
                    });
                }

                const confirmationUrl = data?.confirmation?.confirmation_url;
                if (!confirmationUrl) {
                    return sendJson(res, 502, { ok: false, error: "yookassa_no_link" });
                }
                return sendJson(res, 200, {
                    ok: true,
                    confirmationUrl,
                    paymentId: data?.id || null,
                });
            } catch {
                return sendJson(res, 502, { ok: false, error: "yookassa_request_failed" });
            }
        }

        if (url.pathname === "/api/yookassa/webhook") {
            const raw = await readRawBody(req);
            const body = safeJsonParse(raw);
            if (!body || !body?.event || !body?.object) {
                return sendJson(res, 400, { ok: false, error: "invalid_payload" });
            }

            if (body.event === "payment.succeeded") {
                const payment = body.object || {};
                if (payment.status && payment.status !== "succeeded") {
                    return sendJson(res, 200, { ok: true });
                }

                const metadata = payment.metadata || {};
                const userId = Number(metadata.user_id);
                const productId = metadata.product_id;

                if (!Number.isFinite(userId) || !productId) {
                    return sendJson(res, 400, { ok: false, error: "order_metadata_missing" });
                }

                if (typeof onYookassaPaid === "function") {
                    try {
                        await onYookassaPaid({ userId, productId, payment });
                    } catch {
                        return sendJson(res, 500, { ok: false, error: "yookassa_handler_failed" });
                    }
                }

                return sendJson(res, 200, { ok: true });
            }

            if (body.event === "refund.succeeded") {
                const refund = body.object || {};
                const paymentId = refund?.payment_id || refund?.payment?.id;
                if (!paymentId) {
                    return sendJson(res, 400, { ok: false, error: "refund_payment_missing" });
                }

                const shopId = process.env.YOOKASSA_SHOP_ID;
                const secretKey = process.env.YOOKASSA_SECRET_KEY;
                const payment = await fetchYookassaPayment(paymentId, shopId, secretKey);
                const metadata = payment?.metadata || {};
                const userId = Number(metadata.user_id);
                const productId = metadata.product_id;

                if (!Number.isFinite(userId) || !productId) {
                    return sendJson(res, 400, { ok: false, error: "refund_metadata_missing" });
                }

                const refundAmount = Number(refund?.amount?.value || 0);
                const paymentAmount = Number(payment?.amount?.value || 0);
                const isFullRefund =
                    Number.isFinite(refundAmount) &&
                    Number.isFinite(paymentAmount) &&
                    refundAmount >= paymentAmount;

                if (typeof onYookassaRefund === "function") {
                    try {
                        await onYookassaRefund({
                            userId,
                            productId,
                            refund,
                            payment,
                            isFullRefund,
                        });
                    } catch {
                        return sendJson(res, 500, { ok: false, error: "yookassa_refund_failed" });
                    }
                }

                return sendJson(res, 200, { ok: true });
            }

            return sendJson(res, 200, { ok: true });
        }


        if (url.pathname === "/api/usdt/request") {
            if (req.method !== "POST" || !isJsonRequest) {
                return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
            }

            const body = await readJsonBody(req);
            const initData = body?.initData;
            const productId = body?.productId;
            const txidRaw = String(body?.txid || "").trim();
            const txid = normalizeTronTxid(txidRaw);

            if (!initData || !productId || !txidRaw) {
                return sendJson(res, 400, { ok: false, error: "missing_fields" });
            }
            if (!txid) {
                return sendJson(res, 400, { ok: false, error: "invalid_txid_format" });
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
            const amountUsdt = Number(product?.priceUsdt || 0);

            if (!product || !Number.isFinite(amountUsdt) || amountUsdt <= 0) {
                return sendJson(res, 400, { ok: false, error: "invalid_product" });
            }

            if (typeof onManualUsdtRequest !== "function") {
                return sendJson(res, 500, { ok: false, error: "manual_handler_missing" });
            }

            try {
                await onManualUsdtRequest({
                    userId,
                    productId,
                    txid,
                    product,
                    amountUsdt,
                });
                return sendJson(res, 200, { ok: true });
            } catch (error) {
                const details =
                    error?.message ||
                    error?.description ||
                    error?.response?.description ||
                    "unknown_error";
                return sendJson(res, 500, {
                    ok: false,
                    error: "manual_request_failed",
                    details,
                });
            }
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
