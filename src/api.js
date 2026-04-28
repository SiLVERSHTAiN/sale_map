import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
    getAppSettingAsync,
    createSessionAsync,
    getAdminAnalyticsAsync,
    listPurchasesAsync,
    setAppSettingAsync,
    touchSessionEndedAsync,
    trackEventAsync,
    upsertUserAsync,
} from "./storage.js";
import {
    applyPromoDiscount,
    isPromoActive,
    normalizePromoCode,
    sanitizePromoConfig,
    validatePromoCode,
} from "./promo.js";

function timingSafeEqualHex(a, b) {
    const aBuf = Buffer.from(a || "", "hex");
    const bBuf = Buffer.from(b || "", "hex");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function timingSafeEqualString(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
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

function parseUser(data) {
    if (!data?.user) return null;
    try {
        const u = JSON.parse(data.user);
        const id = Number(u?.id) || null;
        if (!id) return null;
        return {
            id,
            username: typeof u?.username === "string" ? u.username : null,
            languageCode:
                typeof u?.language_code === "string" ? u.language_code : null,
        };
    } catch {
        return null;
    }
}

function normalizeText(value, maxLen = 120) {
    const s = String(value || "").trim();
    if (!s) return null;
    return s.slice(0, maxLen);
}

function normalizePayload(value, maxLen = 4000) {
    if (value == null) return null;
    if (typeof value !== "object") return null;
    try {
        const json = JSON.stringify(value);
        if (json.length <= maxLen) return value;
        return { truncated: true };
    } catch {
        return null;
    }
}

async function getPromoConfigAsync() {
    const raw = await getAppSettingAsync("promo_config");
    return sanitizePromoConfig(raw);
}

function applyProductPromo(product, promo) {
    const active = isPromoActive(promo);
    const priceRub = Number(product?.priceRub || 0);
    const priceStars = Number(product?.priceStars || 0);
    const priceUsdt = Number(product?.priceUsdt || 0);
    return {
        priceRub: active ? applyPromoDiscount(priceRub, promo.discountPercent, "rub") : priceRub,
        priceStars: active
            ? applyPromoDiscount(priceStars, promo.discountPercent, "stars")
            : priceStars,
        priceUsdt: active ? applyPromoDiscount(priceUsdt, promo.discountPercent, "usdt") : priceUsdt,
    };
}

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
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

function getBearerTokenFromHeader(req) {
    const value = String(req.headers?.authorization || "").trim();
    if (!value) return "";
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? String(match[1] || "").trim() : "";
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

        if (url.pathname === "/api/admin/analytics") {
            if (req.method !== "GET") {
                return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
            }

            const expectedToken = String(process.env.ADMIN_ANALYTICS_TOKEN || "").trim();
            if (!expectedToken) {
                return sendJson(res, 503, { ok: false, error: "admin_token_missing" });
            }

            const bearer = getBearerTokenFromHeader(req);
            const queryToken = String(url.searchParams.get("token") || "").trim();
            const providedToken = bearer || queryToken;

            if (!providedToken || !timingSafeEqualString(providedToken, expectedToken)) {
                return sendJson(res, 401, { ok: false, error: "unauthorized" });
            }

            const days = Number(url.searchParams.get("days") || 30);
            const topCitiesLimit = Number(url.searchParams.get("topCitiesLimit") || 15);
            const usersLimit = Number(url.searchParams.get("usersLimit") || 50);
            try {
                const data = await getAdminAnalyticsAsync({
                    days,
                    topCitiesLimit,
                    usersLimit,
                });
                return sendJson(res, 200, { ok: true, ...data });
            } catch (error) {
                return sendJson(res, 500, {
                    ok: false,
                    error: "analytics_failed",
                    details: error?.message || "unknown_error",
                });
            }
        }

        if (url.pathname === "/api/admin/promo") {
            const expectedToken = String(process.env.ADMIN_ANALYTICS_TOKEN || "").trim();
            if (!expectedToken) {
                return sendJson(res, 503, { ok: false, error: "admin_token_missing" });
            }

            const bearer = getBearerTokenFromHeader(req);
            const queryToken = String(url.searchParams.get("token") || "").trim();
            const providedToken = bearer || queryToken;
            if (!providedToken || !timingSafeEqualString(providedToken, expectedToken)) {
                return sendJson(res, 401, { ok: false, error: "unauthorized" });
            }

            if (req.method === "GET") {
                const promo = await getPromoConfigAsync();
                return sendJson(res, 200, { ok: true, promo });
            }

            if (req.method === "POST") {
                if (!isJsonRequest) {
                    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
                }
                const body = await readJsonBody(req);
                const promo = sanitizePromoConfig({
                    code: body?.code,
                    discountPercent: body?.discountPercent,
                    enabled: body?.enabled,
                    updatedAt: new Date().toISOString(),
                });
                await setAppSettingAsync("promo_config", promo);
                return sendJson(res, 200, { ok: true, promo });
            }

            return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        }

        if (url.pathname === "/api/promo/validate") {
            if (req.method !== "POST" || !isJsonRequest) {
                return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
            }

            const body = await readJsonBody(req);
            const promo = await getPromoConfigAsync();
            const validation = validatePromoCode(promo, body?.code);
            if (!validation.ok) {
                return sendJson(res, 200, {
                    ok: true,
                    valid: false,
                    reason: validation.reason,
                });
            }

            return sendJson(res, 200, {
                ok: true,
                valid: true,
                promo: validation.promo,
            });
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

        if (url.pathname === "/api/track") {
            if (req.method !== "POST" || !isJsonRequest) {
                return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
            }

            const body = await readJsonBody(req);
            const initData = body?.initData;
            const eventType = normalizeText(body?.eventType, 80);

            if (!initData || !eventType) {
                return sendJson(res, 400, { ok: false, error: "initData_or_event_missing" });
            }

            const verified = verifyInitData(initData, botToken);
            if (!verified) {
                return sendJson(res, 401, { ok: false, error: "invalid_init_data" });
            }

            const user = parseUser(verified);
            if (!user?.id) {
                return sendJson(res, 400, { ok: false, error: "user_id_missing" });
            }

            const sessionIdInput = normalizeText(body?.sessionId, 120);
            const page = normalizeText(body?.page, 80);
            const productId = normalizeText(body?.productId, 120);
            const city = normalizeText(body?.city, 80);
            const payload = normalizePayload(body?.payload);
            const platform = normalizeText(body?.platform, 40);
            const tgVersion = normalizeText(body?.tgVersion, 40);
            const colorScheme = normalizeText(body?.colorScheme, 20);
            const startParam = normalizeText(
                body?.startParam || verified?.start_param,
                120
            );
            const isTg = body?.isTg !== false;

            let sessionId = sessionIdInput;
            if (eventType === "app_open" && !sessionId) {
                sessionId = crypto.randomUUID();
            }

            try {
                await upsertUserAsync({
                    userId: user.id,
                    username: user.username,
                    languageCode: user.languageCode,
                    canNotify: true,
                    platform,
                    tgVersion,
                    startParam,
                    incrementOpens: eventType === "app_open",
                });

                if (eventType === "app_open" && sessionId) {
                    await createSessionAsync({
                        sessionId,
                        userId: user.id,
                        page,
                        platform,
                        tgVersion,
                        colorScheme,
                        isTg,
                    });
                }

                if (eventType === "session_end" && sessionId) {
                    await touchSessionEndedAsync(sessionId);
                }

                await trackEventAsync({
                    userId: user.id,
                    sessionId: sessionId || null,
                    eventType,
                    page,
                    productId,
                    city,
                    payload,
                });
            } catch (error) {
                return sendJson(res, 500, {
                    ok: false,
                    error: "track_failed",
                    details: error?.message || "unknown_error",
                });
            }

            return sendJson(res, 200, {
                ok: true,
                userId: user.id,
                sessionId: sessionId || null,
            });
        }


        if (url.pathname === "/api/yookassa/create") {
            if (req.method !== "POST" || !isJsonRequest) {
                return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
            }

            const body = await readJsonBody(req);
            const initData = body?.initData;
            const productId = body?.productId;
            const promoCode = normalizePromoCode(body?.promoCode);

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
            const promo = await getPromoConfigAsync();
            const promoValidation = validatePromoCode(promo, promoCode);
            const pricing = applyProductPromo(product, promoValidation.ok ? promoValidation.promo : null);
            const amountValue = Number(pricing.priceRub || 0);

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
                    promo_code: promoValidation.ok ? promoValidation.promo.code : "",
                    promo_discount_percent: promoValidation.ok
                        ? String(promoValidation.promo.discountPercent)
                        : "",
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
            const promoCode = normalizePromoCode(body?.promoCode);
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
            const promo = await getPromoConfigAsync();
            const promoValidation = validatePromoCode(promo, promoCode);
            const pricing = applyProductPromo(product, promoValidation.ok ? promoValidation.promo : null);
            const amountUsdt = Number(pricing.priceUsdt || 0);

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
                    promoCode: promoValidation.ok ? promoValidation.promo.code : null,
                    promoDiscountPercent: promoValidation.ok
                        ? promoValidation.promo.discountPercent
                        : null,
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
            const promoCode = normalizePromoCode(body?.promoCode);

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
                await onAction({ userId, action, productId, promoCode });
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
