import http from "http";
import crypto from "crypto";

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

export function startApiServer({ port, botToken, onAction }) {
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
