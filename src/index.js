import "dotenv/config";
import fs from "fs";
import path from "path";
import { Telegraf, Markup } from "telegraf";
import { nanoid } from "nanoid";

import {
    getAdminLastTextAsync,
    getBroadcastDraftAsync,
    hasPurchaseAsync,
    listAllNotifiableUsersAsync,
    listCardCheckoutRecoveryCandidatesAsync,
    logNotificationAsync,
    markDownloadAsync,
    removePurchaseAsync,
    setAdminLastTextAsync,
    setBroadcastDraftAsync,
    storePurchaseAsync,
} from "./storage.js";
import { startApiServer } from "./api.js";

// -------------------- ENV --------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing in .env");

const ASSETS_DIR = process.env.ASSETS_DIR || "./assets";
const CATALOG_PATH = process.env.CATALOG_PATH || "./docs/products.json";
const DEFAULT_CITY_ID = process.env.DEFAULT_CITY_ID || "";
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);

// URL витрины. Можно переопределить через .env (WEBAPP_URL)
const WEBAPP_URL =
    process.env.WEBAPP_URL || "https://silvershtain.github.io/sale_map/";
const PORT = Number(process.env.PORT || 3000);

// -------------------- Helpers --------------------
function abs(p) {
    return path.resolve(process.cwd(), p);
}

function instructionText() {
    return [
        "📍 *Как импортировать точки в Organic Maps / MAPS.ME*",
        "1) Скачай файл .kmz (я отправляю его документом).",
        "2) Открой файл на телефоне и выбери *Organic Maps* или *MAPS.ME*.",
        "3) Подтверди импорт — точки появятся в закладках/избранном.",
        "",
        "Если не импортируется — напиши /support (модель телефона + скрин ошибки).",
    ].join("\n");
}

function isAdmin(userId) {
    return Boolean(ADMIN_CHAT_ID) && Number(userId) === Number(ADMIN_CHAT_ID);
}

function readCatalog() {
    const file = abs(CATALOG_PATH);
    if (!fs.existsSync(file)) {
        throw new Error(`Catalog not found: ${file}\nCreate docs/products.json first.`);
    }

    const raw = fs.readFileSync(file, "utf-8");
    const catalog = JSON.parse(raw);

    const cities = Array.isArray(catalog.cities) ? catalog.cities : [];
    const products = Array.isArray(catalog.products) ? catalog.products : [];

    const activeCities = cities.filter((c) => c && c.active !== false);
    const activeProducts = products.filter((p) => p && p.active !== false);

    const citiesById = Object.fromEntries(activeCities.map((c) => [c.id, c]));
    const productsById = Object.fromEntries(activeProducts.map((p) => [p.id, p]));

    const defaultCityId =
        (DEFAULT_CITY_ID && citiesById[DEFAULT_CITY_ID] ? DEFAULT_CITY_ID : "") ||
        activeCities[0]?.id ||
        "";

    const defaultMini = activeProducts.find(
        (p) => p.cityId === defaultCityId && p.type === "mini"
    )?.id;

    const defaultFull = activeProducts.find(
        (p) => p.cityId === defaultCityId && p.type === "full"
    )?.id;

    return {
        catalog,
        citiesById,
        productsById,
        defaultCityId,
        defaultMiniProductId: defaultMini || null,
        defaultFullProductId: defaultFull || null,
    };
}

// В DEV удобно перечитывать каталог на каждый запрос (ты меняешь JSON → сразу работает)
function getCatalog() {
    return readCatalog();
}

function resolveAssetFile(fileName) {
    const p = abs(path.join(ASSETS_DIR, fileName));
    if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
    return p;
}

function isRemoteFile(fileName) {
    return /^https?:\/\//i.test(String(fileName || ""));
}

function guessFileName(fileName) {
    const raw = String(fileName || "").trim();
    if (!raw) return "map.kmz";

    try {
        const u = new URL(raw);
        const name = path.basename(u.pathname || "");
        if (name) return name;
    } catch {}

    const localName = path.basename(raw);
    return localName || "map.kmz";
}

function fileSource(fileName) {
    const filename = guessFileName(fileName);
    if (isRemoteFile(fileName)) {
        return { url: String(fileName), filename };
    }
    return { source: fs.createReadStream(resolveAssetFile(fileName)), filename };
}

function cityLabel(city) {
    if (!city) return "";
    return city.country ? `${city.name} · ${city.country}` : city.name;
}

function safeJsonParse(s) {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

function parseTxidFromAdminMessage(text) {
    const m = String(text || "").match(/^TXID:\s*(.+)$/m);
    if (!m) return null;
    const txid = String(m[1] || "").trim();
    if (!txid || txid === "-") return null;
    return txid;
}

function parseIsoDateArg(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) return null;
    return new Date(ts).toISOString();
}

function buildCardFixCampaignId(fromTs, toTs) {
    return `card_fix:${fromTs}:${toTs}`;
}

function adminMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("📣 Рассылки", "adm:menu:broadcasts")],
        [Markup.button.callback("📦 Каталог", "adm:action:catalog")],
    ]);
}

function broadcastsMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("📝 Текст рассылки", "adm:menu:draft")],
        [Markup.button.callback("🎯 Потенциальные покупатели", "adm:broadcast:recovery")],
        [Markup.button.callback("👥 Все пользователи", "adm:broadcast:allusers")],
        [Markup.button.callback("⬅️ Назад", "adm:menu:root")],
    ]);
}

function draftMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("👀 Показать черновик", "adm:draft:show")],
        [Markup.button.callback("💾 Сохранить последнее сообщение", "adm:draft:use_last")],
        [Markup.button.callback("⬅️ К рассылкам", "adm:menu:broadcasts")],
    ]);
}

function audienceMenuKeyboard(audience) {
    const scope = String(audience || "recovery");
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("👀 Показать 1 день", `adm:broadcast:${scope}:preview:1d`),
            Markup.button.callback("🚀 Отправить 1 день", `adm:broadcast:${scope}:send:1d`),
        ],
        [
            Markup.button.callback("👀 Показать 7 дней", `adm:broadcast:${scope}:preview:7d`),
            Markup.button.callback("🚀 Отправить 7 дней", `adm:broadcast:${scope}:send:7d`),
        ],
        [
            Markup.button.callback("👀 Показать 30 дней", `adm:broadcast:${scope}:preview:30d`),
            Markup.button.callback("🚀 Отправить 30 дней", `adm:broadcast:${scope}:send:30d`),
        ],
        [
            Markup.button.callback("👀 Показать всех", `adm:broadcast:${scope}:preview:all`),
            Markup.button.callback("🚀 Отправить всех", `adm:broadcast:${scope}:send:all`),
        ],
        [Markup.button.callback("⬅️ К рассылкам", "adm:menu:broadcasts")],
    ]);
}

function getPresetRange(preset) {
    const now = new Date();
    const map = {
        "1d": 1,
        "7d": 7,
        "30d": 30,
    };
    const days = map[String(preset || "")];
    if (!days) {
        return { fromTs: null, toTs: now.toISOString() };
    }
    return {
        fromTs: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
        toTs: now.toISOString(),
    };
}

function formatPreviewTime(value) {
    const ts = Date.parse(value || "");
    if (!Number.isFinite(ts)) return String(value || "—");
    return new Date(ts).toISOString().replace(".000Z", "Z");
}

function formatAudienceLabel(audience) {
    return audience === "allusers" ? "Все пользователи" : "Потенциальные покупатели";
}

function formatPresetLabel(preset) {
    const map = {
        "1d": "1 день",
        "7d": "7 дней",
        "30d": "30 дней",
        all: "все время",
    };
    return map[String(preset || "all")] || String(preset || "all");
}

function buildCardFixMessage(candidate) {
    const { citiesById } = getCatalog();
    const city = candidate?.city ? citiesById[candidate.city] : null;
    const cityPart = city ? ` по карте *${cityLabel(city)}*` : "";
    return [
        `🔧 Недавно у нас были техработы с оплатой картой${cityPart}.`,
        "",
        "Из-за этого при попытке оплаты могла показываться ошибка.",
        "Сейчас всё исправлено: можно снова открыть витрину и завершить покупку.",
        "",
        "Если что-то не сработает, напиши /support.",
    ].join("\n");
}

async function sendCardFixNotification(candidate, campaignId) {
    const userId = Number(candidate?.userId);
    if (!Number.isFinite(userId)) {
        return { ok: false, error: "user_id_missing" };
    }

    try {
        await bot.telegram.sendMessage(
            userId,
            buildCardFixMessage(candidate),
            withWebAppKeyboard({
                parse_mode: "Markdown",
                disable_web_page_preview: true,
            })
        );
        await logNotificationAsync({
            userId,
            campaignId,
            channel: "telegram",
            status: "sent",
        });
        return { ok: true };
    } catch (error) {
        const details =
            error?.description ||
            error?.response?.description ||
            error?.message ||
            String(error);
        await logNotificationAsync({
            userId,
            campaignId,
            channel: "telegram",
            status: "failed",
            errorText: details,
        });
        return { ok: false, error: details };
    }
}

function buildBroadcastMessage(text) {
    return String(text || "").trim();
}

async function loadCardFixCandidatesFromCommand(text) {
    const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
    const now = Date.now();
    const defaultFrom = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const defaultTo = new Date(now).toISOString();

    const fromTs = parseIsoDateArg(parts[1]) || defaultFrom;
    const toTs = parseIsoDateArg(parts[2]) || defaultTo;
    const campaignId = parts[3] || buildCardFixCampaignId(fromTs, toTs);
    const candidates = await listCardCheckoutRecoveryCandidatesAsync({
        fromTs,
        toTs,
        campaignId,
        limit: 500,
    });

    return { fromTs, toTs, campaignId, candidates };
}

async function loadCardFixCandidatesByPreset(preset) {
    const { fromTs, toTs } = getPresetRange(preset);
    const campaignId = buildCardFixCampaignId(fromTs, toTs);
    const candidates = await listCardCheckoutRecoveryCandidatesAsync({
        fromTs,
        toTs,
        campaignId,
        limit: 500,
    });
    return { fromTs, toTs, campaignId, candidates };
}

async function loadBroadcastAudienceByPreset({ audience, preset }) {
    const normalizedAudience = audience === "allusers" ? "allusers" : "recovery";
    const { fromTs, toTs } = getPresetRange(preset);
    const campaignId = `broadcast:${normalizedAudience}:${preset}:${fromTs || "all"}:${toTs || "now"}`;

    if (normalizedAudience === "allusers") {
        const candidates = await listAllNotifiableUsersAsync({
            campaignId,
            limit: 5000,
        });
        return { audience: normalizedAudience, preset, fromTs, toTs, campaignId, candidates };
    }

    if (!fromTs || !toTs) {
        const farPast = "2020-01-01T00:00:00.000Z";
        const candidates = await listCardCheckoutRecoveryCandidatesAsync({
            fromTs: farPast,
            toTs: toTs || new Date().toISOString(),
            campaignId,
            limit: 5000,
        });
        return {
            audience: normalizedAudience,
            preset,
            fromTs: farPast,
            toTs: toTs || new Date().toISOString(),
            campaignId,
            candidates,
        };
    }

    const candidates = await listCardCheckoutRecoveryCandidatesAsync({
        fromTs,
        toTs,
        campaignId,
        limit: 5000,
    });
    return { audience: normalizedAudience, preset, fromTs, toTs, campaignId, candidates };
}

function buildCardFixPreviewLines({ fromTs, toTs, campaignId, candidates }) {
    const lines = [
        "📣 Кандидаты на уведомление",
        `Период: ${formatPreviewTime(fromTs)} → ${formatPreviewTime(toTs)}`,
        `campaign_id: ${campaignId}`,
        `Найдено: ${candidates.length}`,
        "",
    ];

    if (!candidates.length) {
        lines.push("Никого не нашёл.");
        return lines;
    }

    for (const row of candidates.slice(0, 20)) {
        const username = row.username ? `@${row.username}` : "—";
        lines.push(
            `${row.userId} · ${username} · ${row.productId || "—"} · ${row.city || "—"} · ${formatPreviewTime(row.lastEventAt)}`
        );
    }
    if (candidates.length > 20) {
        lines.push("", `Показаны первые 20 из ${candidates.length}.`);
    }
    return lines;
}

function buildBroadcastPreviewLines(payload) {
    const { audience, preset, fromTs, toTs, campaignId, candidates } = payload;
    const lines = [
        "📣 Кандидаты на уведомление",
        `Аудитория: ${formatAudienceLabel(audience)}`,
        `Период: ${formatPresetLabel(preset)}`,
        fromTs ? `Окно: ${formatPreviewTime(fromTs)} → ${formatPreviewTime(toTs)}` : `Окно: до ${formatPreviewTime(toTs)}`,
        `campaign_id: ${campaignId}`,
        `Найдено: ${candidates.length}`,
        "",
    ];

    if (!candidates.length) {
        lines.push("Никого не нашёл.");
        return lines;
    }

    for (const row of candidates.slice(0, 20)) {
        const username = row.username ? `@${row.username}` : "—";
        lines.push(
            `${row.userId} · ${username} · ${row.productId || "—"} · ${row.city || "—"} · ${formatPreviewTime(row.lastEventAt)}`
        );
    }
    if (candidates.length > 20) {
        lines.push("", `Показаны первые 20 из ${candidates.length}.`);
    }
    return lines;
}

async function runCardFixSend({ fromTs, toTs, campaignId, candidates }) {
    if (!candidates.length) {
        return {
            lines: [
                "📭 Никого не нашёл для отправки.",
                `Период: ${formatPreviewTime(fromTs)} → ${formatPreviewTime(toTs)}`,
                `campaign_id: ${campaignId}`,
            ],
        };
    }

    let sent = 0;
    let failed = 0;
    const failedRows = [];
    for (const candidate of candidates) {
        const result = await sendCardFixNotification(candidate, campaignId);
        if (result.ok) {
            sent += 1;
        } else {
            failed += 1;
            failedRows.push(`${candidate.userId}: ${result.error || "unknown_error"}`);
        }
    }

    const lines = [
        "✅ Рассылка завершена.",
        `campaign_id: ${campaignId}`,
        `Отправлено: ${sent}`,
        `Ошибок: ${failed}`,
    ];
    if (failedRows.length) {
        lines.push("", "Ошибки:", ...failedRows.slice(0, 20));
    }
    return { lines };
}

async function runBroadcastSend(payload) {
    const draft = await getBroadcastDraftAsync();
    const messageText = buildBroadcastMessage(draft?.text);
    if (!messageText) {
        return {
            lines: [
                "✍️ Черновик рассылки пуст.",
                "Отправь мне обычным сообщением текст и в меню «Рассылки» нажми «Текст рассылки» → «Сохранить последнее сообщение».",
            ],
        };
    }

    const { audience, preset, fromTs, toTs, campaignId, candidates } = payload;
    if (!candidates.length) {
        return {
            lines: [
                "📭 Никого не нашёл для отправки.",
                `Аудитория: ${formatAudienceLabel(audience)}`,
                `Период: ${formatPresetLabel(preset)}`,
                fromTs
                    ? `Окно: ${formatPreviewTime(fromTs)} → ${formatPreviewTime(toTs)}`
                    : `Окно: до ${formatPreviewTime(toTs)}`,
                `campaign_id: ${campaignId}`,
            ],
        };
    }

    let sent = 0;
    let failed = 0;
    const failedRows = [];
    for (const candidate of candidates) {
        try {
            await bot.telegram.sendMessage(
                Number(candidate.userId),
                messageText,
                withWebAppKeyboard({ disable_web_page_preview: false })
            );
            await logNotificationAsync({
                userId: Number(candidate.userId),
                campaignId,
                channel: "telegram",
                status: "sent",
            });
            sent += 1;
        } catch (error) {
            const details =
                error?.description ||
                error?.response?.description ||
                error?.message ||
                String(error);
            await logNotificationAsync({
                userId: Number(candidate.userId),
                campaignId,
                channel: "telegram",
                status: "failed",
                errorText: details,
            });
            failed += 1;
            failedRows.push(`${candidate.userId}: ${details}`);
        }
    }

    const lines = [
        "✅ Рассылка завершена.",
        `Аудитория: ${formatAudienceLabel(audience)}`,
        `Период: ${formatPresetLabel(preset)}`,
        `campaign_id: ${campaignId}`,
        `Отправлено: ${sent}`,
        `Ошибок: ${failed}`,
    ];
    if (failedRows.length) {
        lines.push("", "Ошибки:", ...failedRows.slice(0, 20));
    }
    return { lines };
}

async function buildDraftStatusText() {
    const [draft, lastText] = await Promise.all([
        getBroadcastDraftAsync(),
        getAdminLastTextAsync(),
    ]);
    const draftText = buildBroadcastMessage(draft?.text);
    const lastMessageText = buildBroadcastMessage(lastText?.text);
    return [
        "📝 Текст рассылки",
        "",
        draftText
            ? `Текущий черновик:\n${draftText}`
            : "Текущий черновик: пока пусто.",
        "",
        lastMessageText
            ? `Последнее твоё сообщение:\n${lastMessageText}`
            : "Последнее сообщение пока не найдено.",
        "",
        "Как обновить текст:",
        "1. Отправь боту обычным сообщением нужный текст.",
        "2. Нажми «Сохранить последнее сообщение».",
    ].join("\n");
}

async function handleAdminCallback(ctx, cbData) {
    if (!isAdmin(ctx.from?.id)) {
        try { await ctx.answerCbQuery("Недостаточно прав", { show_alert: true }); } catch {}
        return true;
    }

    if (cbData === "adm:menu:root") {
        try { await ctx.answerCbQuery(); } catch {}
        await ctx.reply("Админ-меню", adminMenuKeyboard());
        return true;
    }

    if (cbData === "adm:menu:broadcasts") {
        try { await ctx.answerCbQuery(); } catch {}
        await ctx.reply("Раздел рассылок", broadcastsMenuKeyboard());
        return true;
    }

    if (cbData === "adm:menu:draft") {
        try { await ctx.answerCbQuery(); } catch {}
        await ctx.reply(await buildDraftStatusText(), draftMenuKeyboard());
        return true;
    }

    if (cbData === "adm:draft:show") {
        try { await ctx.answerCbQuery(); } catch {}
        await ctx.reply(await buildDraftStatusText(), draftMenuKeyboard());
        return true;
    }

    if (cbData === "adm:draft:use_last") {
        const lastText = await getAdminLastTextAsync();
        const text = buildBroadcastMessage(lastText?.text);
        if (!text) {
            try { await ctx.answerCbQuery("Сначала пришли текст сообщением", { show_alert: true }); } catch {}
            return true;
        }
        await setBroadcastDraftAsync({
            text,
            savedAt: new Date().toISOString(),
        });
        try { await ctx.answerCbQuery("Черновик сохранён"); } catch {}
        await ctx.reply(await buildDraftStatusText(), draftMenuKeyboard());
        return true;
    }

    if (cbData === "adm:broadcast:recovery") {
        try { await ctx.answerCbQuery(); } catch {}
        await ctx.reply(
            "Аудитория: потенциальные покупатели без завершённой покупки.",
            audienceMenuKeyboard("recovery")
        );
        return true;
    }

    if (cbData === "adm:broadcast:allusers") {
        try { await ctx.answerCbQuery(); } catch {}
        await ctx.reply(
            "Аудитория: все пользователи, у кого разрешены уведомления.",
            audienceMenuKeyboard("allusers")
        );
        return true;
    }

    if (cbData === "adm:action:catalog") {
        try { await ctx.answerCbQuery(); } catch {}
        const { catalog } = getCatalog();
        const cities = (catalog.cities || []).filter((c) => c.active !== false);
        const products = (catalog.products || []).filter((p) => p.active !== false);
        await ctx.reply(
            `📦 Catalog OK\nCities: ${cities.length}\nProducts: ${products.length}`,
            adminMenuKeyboard()
        );
        return true;
    }

    const parts = String(cbData || "").split(":");
    if (parts[0] !== "adm" || parts[1] !== "broadcast") return false;

    const audience = parts[2];
    const mode = parts[3];
    const preset = parts[4] || "1d";
    const payload = await loadBroadcastAudienceByPreset({ audience, preset });

    if (mode === "preview") {
        try { await ctx.answerCbQuery("Собираю список"); } catch {}
        await ctx.reply(buildBroadcastPreviewLines(payload).join("\n"), audienceMenuKeyboard(audience));
        return true;
    }

    if (mode === "send") {
        try { await ctx.answerCbQuery("Запускаю отправку"); } catch {}
        await ctx.reply(
            [
                "🚀 Начинаю отправку уведомлений.",
                `Аудитория: ${formatAudienceLabel(payload.audience)}`,
                `Период: ${formatPresetLabel(payload.preset)}`,
                `campaign_id: ${payload.campaignId}`,
                `Кандидатов: ${payload.candidates.length}`,
            ].join("\n"),
            audienceMenuKeyboard(audience)
        );
        const result = await runBroadcastSend(payload);
        await ctx.reply(result.lines.join("\n"), audienceMenuKeyboard(audience));
        return true;
    }

    return false;
}

function webAppKeyboardIfAny() {
    return Markup.inlineKeyboard([
        Markup.button.webApp("🗺 Открыть витрину", WEBAPP_URL),
    ]);
}

function withWebAppKeyboard(options = {}) {
    const kb = webAppKeyboardIfAny();
    return kb ? { ...options, ...kb } : options;
}

async function registerBotCommands() {
    const userCommands = [
        { command: "start", description: "Запустить бота" },
        { command: "how", description: "Как установить карту" },
        { command: "support", description: "Поддержка" },
        { command: "catalog", description: "Проверить каталог" },
    ];

    await bot.telegram.setMyCommands(userCommands);

    if (!ADMIN_CHAT_ID) return;

    const adminCommands = [
        ...userCommands,
        { command: "admin", description: "Админ-меню" },
        { command: "notify_card_fix_preview", description: "Предпросмотр сервисной рассылки" },
        { command: "notify_card_fix_send", description: "Отправить сервисную рассылку" },
        { command: "approve", description: "Подтвердить USDT-оплату" },
        { command: "reject", description: "Отклонить USDT-оплату" },
    ];

    await bot.telegram.setMyCommands(adminCommands, {
        scope: { type: "chat", chat_id: ADMIN_CHAT_ID },
    });
}

async function sendKmz(ctx, filePath, caption) {
    await ctx.replyWithDocument(
        fileSource(filePath),
        { caption, parse_mode: "Markdown" }
    );
}

async function sendKmzToUser(userId, filePath, caption) {
    await bot.telegram.sendDocument(
        userId,
        fileSource(filePath),
        { caption, parse_mode: "Markdown" }
    );
}

// -------------------- Business Logic --------------------
async function handleHowTo(ctx) {
    await ctx.reply(
        instructionText(),
        withWebAppKeyboard({ parse_mode: "Markdown" })
    );
}

async function handleHowToToUser(userId) {
    await bot.telegram.sendMessage(
        userId,
        instructionText(),
        withWebAppKeyboard({ parse_mode: "Markdown" })
    );
}

async function handleGetFile(ctx, productId) {
    const { productsById, citiesById } = getCatalog();
    const product = productsById[productId];

    if (!product) {
        await ctx.reply(
            "Не нашёл такой продукт 🙈 Открой витрину ещё раз.",
            withWebAppKeyboard()
        );
        return;
    }

    // full (платный) отдаём только если куплен
    if (product.type === "full" && Number(product.priceStars || 0) > 0) {
        const userId = ctx.from?.id;
        if (!userId) return;

        if (!(await hasPurchaseAsync(userId, product.id))) {
            await ctx.reply(
                "Полная версия доступна после оплаты ⭐",
                withWebAppKeyboard()
            );
            return;
        }
    }

    const city = citiesById[product.cityId];
    const caption = `✅ *${product.title || "Файл"}*\n${cityLabel(city)}`.trim();

    await sendKmz(ctx, product.file, caption);
    const userId = ctx.from?.id;
    if (userId) {
        await markDownloadAsync(userId, product.id);
    }
    await handleHowTo(ctx);
}

async function handleGetFileByUser(userId, productId) {
    const { productsById, citiesById } = getCatalog();
    const product = productsById[productId];

    if (!product) {
        await bot.telegram.sendMessage(
            userId,
            "Не нашёл такой продукт 🙈 Открой витрину ещё раз.",
            withWebAppKeyboard()
        );
        return;
    }

    if (product.type === "full" && Number(product.priceStars || 0) > 0) {
        if (!(await hasPurchaseAsync(userId, product.id))) {
            await bot.telegram.sendMessage(
                userId,
                "Полная версия доступна после оплаты ⭐",
                withWebAppKeyboard()
            );
            return;
        }
    }

    const city = citiesById[product.cityId];
    const caption = `✅ *${product.title || "Файл"}*\n${cityLabel(city)}`.trim();

    await sendKmzToUser(userId, product.file, caption);
    if (userId) {
        await markDownloadAsync(userId, product.id);
    }
    await handleHowToToUser(userId);
}

async function handleYookassaPaid({ userId, productId, payment }) {
    if (!userId || !productId) return;
    if (!(await hasPurchaseAsync(userId, productId))) {
        await storePurchaseAsync({
            userId,
            productId,
            telegramPaymentChargeId: null,
            payload: JSON.stringify({
                provider: "yookassa",
                payment: payment || null,
            }),
        });
    }
    await handleGetFileByUser(userId, productId);
}

async function handleYookassaRefund({ userId, productId, isFullRefund }) {
    if (!userId || !productId) return;
    if (isFullRefund) {
        await removePurchaseAsync(userId, productId);
        await bot.telegram.sendMessage(
            userId,
            "ℹ️ Оплата возвращена. Доступ к файлу отключён. Если нужна помощь — /support",
            withWebAppKeyboard()
        );
    }
}

async function handleManualUsdtRequest({ userId, productId, txid, product, amountUsdt }) {
    if (!ADMIN_CHAT_ID) {
        throw new Error("admin_chat_id_missing");
    }
    const title = product?.title || "Полная версия";
    const city = product?.cityId ? ` (${product.cityId})` : "";
    const lines = [
        "🪙 Запрос оплаты USDT",
        `Пользователь: ${userId}`,
        `Товар: ${productId}${city} — ${title}`,
        `Сумма: ${amountUsdt} USDT`,
        `TXID: ${txid}`,
        "",
        "Нажмите кнопку ниже для решения:",
        `Командой тоже можно: /approve ${userId} ${productId}`,
    ];
    try {
        await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            lines.join("\n"),
            Markup.inlineKeyboard([
                [
                    Markup.button.callback("✅ Подтвердить", `ua:${userId}:${productId}`),
                    Markup.button.callback("❌ Отклонить", `ur:${userId}:${productId}`),
                ],
            ])
        );
    } catch (error) {
        const details =
            error?.description ||
            error?.response?.description ||
            error?.message ||
            String(error);
        throw new Error(`admin_notify_failed:${details}`);
    }
}

async function approveUsdtPurchase({ userId, productId, txid }) {
    await storePurchaseAsync({
        userId,
        productId,
        telegramPaymentChargeId: null,
        payload: JSON.stringify({
            provider: "usdt_manual",
            txid: txid || null,
        }),
    });

    await bot.telegram.sendMessage(
        userId,
        "✅ Оплата подтверждена. Сейчас отправлю файл.",
        withWebAppKeyboard()
    );
    await handleGetFileByUser(userId, productId);
}

async function rejectUsdtPurchase({ userId, productId }) {
    await bot.telegram.sendMessage(
        userId,
        "Платёж пока не подтверждён. Проверь TXID и сумму или напиши в поддержку.",
        withWebAppKeyboard()
    );
}

async function handleBuy(ctx, productId) {
    const { productsById, citiesById } = getCatalog();
    const product = productsById[productId];

    if (!product) {
        await ctx.reply(
            "Не нашёл такой продукт 🙈 Открой витрину ещё раз.",
            withWebAppKeyboard()
        );
        return;
    }

    const userId = ctx.from?.id;
    if (!userId) return;

    // бесплатное — просто отдаём
    if (Number(product.priceStars || 0) <= 0) {
        return handleGetFile(ctx, product.id);
    }

  // уже куплено — выдаём без оплаты
    if (await hasPurchaseAsync(userId, product.id)) {
        await ctx.reply(
            "✅ Уже куплено. Отправляю файл ещё раз:",
            withWebAppKeyboard()
        );
        return handleGetFile(ctx, product.id);
    }

    const city = citiesById[product.cityId];

    const invoicePayload = JSON.stringify({
        productId: product.id,
        userId,
        nonce: nanoid(10),
    });

    await ctx.replyWithInvoice({
        title: `${cityLabel(city)} — ${product.title || "Путеводитель"}`,
        description:
            product.description || "Файл .kmz (точки на карте) для Organic Maps / MAPS.ME.",
        payload: invoicePayload,
        provider_token: "", // Stars
        currency: "XTR",
        prices: [
            {
                label: `${city?.name || "Guide"} — ${product.type || "product"}`,
                amount: Number(product.priceStars || 0),
            },
        ],
    });
}

async function handleBuyByUser(userId, productId) {
    const { productsById, citiesById } = getCatalog();
    const product = productsById[productId];

    if (!product) {
        await bot.telegram.sendMessage(
            userId,
            "Не нашёл такой продукт 🙈 Открой витрину ещё раз.",
            withWebAppKeyboard()
        );
        return;
    }

    if (Number(product.priceStars || 0) <= 0) {
        return handleGetFileByUser(userId, product.id);
    }

    if (await hasPurchaseAsync(userId, product.id)) {
        await bot.telegram.sendMessage(
            userId,
            "✅ Уже куплено. Отправляю файл ещё раз:",
            withWebAppKeyboard()
        );
        return handleGetFileByUser(userId, product.id);
    }

    const city = citiesById[product.cityId];
    const invoicePayload = JSON.stringify({
        productId: product.id,
        userId,
        nonce: nanoid(10),
    });

    await bot.telegram.sendInvoice(userId, {
        title: `${cityLabel(city)} — ${product.title || "Путеводитель"}`,
        description:
            product.description || "Файл .kmz (точки на карте) для Organic Maps / MAPS.ME.",
        payload: invoicePayload,
        provider_token: "",
        currency: "XTR",
        prices: [
            {
                label: `${city?.name || "Guide"} — ${product.type || "product"}`,
                amount: Number(product.priceStars || 0),
            },
        ],
    });
}

// -------------------- Bot --------------------
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
    const kb = webAppKeyboardIfAny();

    await ctx.reply(
        "Я собрал готовые места на карте: еда, виды, прогулки и много полезного.\n\nНажми кнопку «🗺 Открыть витрину» ниже 🔻 — выбирай город и получишь файл в этот чат.",
        withWebAppKeyboard({
            parse_mode: "Markdown",
            disable_web_page_preview: true,
        })
    );
});

bot.command("support", async (ctx) => {
    await ctx.reply(
        "🆘 *Поддержка*\n\nEmail: silvershtain@mail.ru\nОтвет в течение 24 часов.\n\nОпиши проблему и пришли:\n— модель телефона\n— приложение (Organic Maps или MAPS.ME)\n— скрин/видео ошибки\n\nЯ помогу.",
        withWebAppKeyboard({ parse_mode: "Markdown" })
    );
});

bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    await ctx.reply("Админ-меню", adminMenuKeyboard());
});

bot.command("notify_card_fix_preview", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const text = String(ctx.message?.text || "").trim();
    const { fromTs, toTs, campaignId, candidates } = await loadCardFixCandidatesFromCommand(text);
    const lines = buildCardFixPreviewLines({ fromTs, toTs, campaignId, candidates });
    if (candidates.length) {
        lines.push(
            "",
            "Отправка:",
            `/notify_card_fix_send ${fromTs} ${toTs} ${campaignId}`
        );
    }
    await ctx.reply(lines.join("\n"));
});

bot.command("notify_card_fix_send", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const text = String(ctx.message?.text || "").trim();
    const payload = await loadCardFixCandidatesFromCommand(text);
    await ctx.reply(
        [
            "🚀 Начинаю отправку уведомлений.",
            `Период: ${formatPreviewTime(payload.fromTs)} → ${formatPreviewTime(payload.toTs)}`,
            `campaign_id: ${payload.campaignId}`,
            `Кандидатов: ${payload.candidates.length}`,
        ].join("\n")
    );
    const result = await runCardFixSend(payload);
    await ctx.reply(result.lines.join("\n"));
});

bot.command("approve", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const text = String(ctx.message?.text || "").trim();
    const parts = text.split(/\s+/);
    const userId = Number(parts[1]);
    const productId = parts[2];
    const txid = parts.slice(3).join(" ") || null;

    if (!Number.isFinite(userId) || !productId) {
        await ctx.reply("Использование: /approve <user_id> <product_id> [txid]");
        return;
    }

    await approveUsdtPurchase({ userId, productId, txid });

    await ctx.reply("Готово. Файл отправлен.");
});

bot.command("reject", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const text = String(ctx.message?.text || "").trim();
    const parts = text.split(/\s+/);
    const userId = Number(parts[1]);
    const productId = parts[2];

    if (!Number.isFinite(userId) || !productId) {
        await ctx.reply("Использование: /reject <user_id> <product_id>");
        return;
    }

    await rejectUsdtPurchase({ userId, productId });
    await ctx.reply("Ок, пользователь уведомлён.");
});

bot.command("how", handleHowTo);

// Быстрая проверка что каталог читается
bot.command("catalog", async (ctx) => {
    const { catalog } = getCatalog();
    const cities = (catalog.cities || []).filter((c) => c.active !== false);
    const products = (catalog.products || []).filter((p) => p.active !== false);
    await ctx.reply(
        `📦 Catalog OK\nCities: ${cities.length}\nProducts: ${products.length}`,
        withWebAppKeyboard()
    );
});

bot.on("text", async (ctx, next) => {
    const text = String(ctx.message?.text || "").trim();
    if (isAdmin(ctx.from?.id) && text && !text.startsWith("/")) {
        await setAdminLastTextAsync({
            text,
            savedAt: new Date().toISOString(),
        });
    }
    return next();
});

// Telegram требует отвечать на pre_checkout
bot.on("pre_checkout_query", async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
});

// Оплата прошла → достаём productId из invoice_payload → сохраняем → выдаём файл
bot.on("successful_payment", async (ctx) => {
    const sp = ctx.message?.successful_payment;
    const userId = ctx.from?.id;
    if (!sp || !userId) return;

    let productId = null;

    const parsed = safeJsonParse(sp.invoice_payload);
    if (parsed?.productId) {
        productId = parsed.productId;
    } else {
        // fallback на старый payload формата "id:user:nonce"
        const parts = String(sp.invoice_payload || "").split(":");
        if (parts[0]) productId = parts[0];
    }

    if (!productId) {
        await ctx.reply(
            "✅ Оплата прошла, но я не понял какой продукт. Напиши /support",
            withWebAppKeyboard()
        );
        return;
    }

    await storePurchaseAsync({
        userId,
        productId,
        telegramPaymentChargeId: sp.telegram_payment_charge_id,
        payload: sp.invoice_payload,
    });

    await ctx.reply(
        "✅ Оплата прошла! Сейчас пришлю файл.",
        withWebAppKeyboard()
    );
    await handleGetFile(ctx, productId);
});

function extractWebAppData(ctx) {
    return (
        ctx.message?.web_app_data?.data ||
        ctx.update?.message?.web_app_data?.data ||
        ctx.callbackQuery?.web_app_data?.data ||
        ctx.update?.callback_query?.web_app_data?.data ||
        null
    );
}

async function handleWebAppAction(ctx, rawData) {
    // Ждём JSON вида: { action:"BUY", productId:"batumi_full" }
    // Поддержим и старый формат: "GET_MINI" / "BUY_FULL" / "HOW_TO"
    let data = safeJsonParse(rawData);
    if (!data) data = { action: rawData };

    const { defaultMiniProductId, defaultFullProductId } = getCatalog();

    const action = data.action;
    let productId = data.productId || null;

    // legacy mapping
    if (!productId) {
        if (action === "GET_MINI" || action === "GET_FILE") productId = defaultMiniProductId;
        if (action === "BUY_FULL" || action === "BUY") productId = defaultFullProductId;
    }

    if (action === "HOW_TO") return handleHowTo(ctx);

    if (action === "GET_MINI" || action === "GET_FILE") {
        if (!productId) {
            return ctx.reply(
                "Mini-версия не настроена в каталоге.",
                withWebAppKeyboard()
            );
        }
        return handleGetFile(ctx, productId);
    }

    if (action === "BUY_FULL" || action === "BUY") {
        if (!productId) {
            return ctx.reply(
                "Full-версия не настроена в каталоге.",
                withWebAppKeyboard()
            );
        }
        return handleBuy(ctx, productId);
    }

    await ctx.reply(
        "Неизвестное действие 🙈 Открой витрину ещё раз.",
        withWebAppKeyboard()
    );
}

async function handleWebAppActionByUser({ userId, action, productId }) {
    const { defaultMiniProductId, defaultFullProductId } = getCatalog();

    let pid = productId || null;
    if (!pid) {
        if (action === "GET_MINI" || action === "GET_FILE") pid = defaultMiniProductId;
        if (action === "BUY_FULL" || action === "BUY") pid = defaultFullProductId;
    }

    if (action === "HOW_TO") return handleHowToToUser(userId);
    if (action === "GET_MINI" || action === "GET_FILE") {
        if (!pid) {
            return bot.telegram.sendMessage(
                userId,
                "Mini-версия не настроена в каталоге.",
                withWebAppKeyboard()
            );
        }
        return handleGetFileByUser(userId, pid);
    }
    if (action === "BUY_FULL" || action === "BUY") {
        if (!pid) {
            return bot.telegram.sendMessage(
                userId,
                "Full-версия не настроена в каталоге.",
                withWebAppKeyboard()
            );
        }
        return handleBuyByUser(userId, pid);
    }
    await bot.telegram.sendMessage(
        userId,
        "Неизвестное действие 🙈 Открой витрину ещё раз.",
        withWebAppKeyboard()
    );
}

// Главный обработчик команд из Mini App (web_app_data) — сообщения
bot.on("message", async (ctx) => {
    const data = extractWebAppData(ctx);
    if (!data) return;
    return handleWebAppAction(ctx, data);
});

// На некоторых клиентах web_app_data приходит как callback_query
bot.on("callback_query", async (ctx) => {
    const cbData = String(ctx.callbackQuery?.data || "");
    if (cbData.startsWith("adm:")) {
        const handled = await handleAdminCallback(ctx, cbData);
        if (handled) return;
    }
    if (cbData.startsWith("ua:") || cbData.startsWith("ur:")) {
        if (!isAdmin(ctx.from?.id)) {
            try { await ctx.answerCbQuery("Недостаточно прав", { show_alert: true }); } catch {}
            return;
        }
        const parts = cbData.split(":");
        const action = parts[0];
        const userId = Number(parts[1]);
        const productId = parts[2];
        if (!Number.isFinite(userId) || !productId) {
            try { await ctx.answerCbQuery("Некорректные данные", { show_alert: true }); } catch {}
            return;
        }

        try {
            if (action === "ua") {
                const txid = parseTxidFromAdminMessage(ctx.callbackQuery?.message?.text);
                await approveUsdtPurchase({ userId, productId, txid });
                try { await ctx.answerCbQuery("Оплата подтверждена"); } catch {}
                try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
                await ctx.reply("Готово. Файл отправлен.");
                return;
            }
            if (action === "ur") {
                await rejectUsdtPurchase({ userId, productId });
                try { await ctx.answerCbQuery("Пользователь уведомлён"); } catch {}
                try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
                await ctx.reply("Ок, пользователь уведомлён.");
                return;
            }
        } catch (error) {
            const msg = error?.message || "Ошибка";
            try { await ctx.answerCbQuery(`Ошибка: ${msg}`, { show_alert: true }); } catch {}
            return;
        }
    }

    const data = extractWebAppData(ctx);
    if (!data) return;
    try { await ctx.answerCbQuery(); } catch {}
    return handleWebAppAction(ctx, data);
});

bot.catch((err) => console.error("BOT ERROR:", err));

// На всякий: чтобы polling не конфликтовал с webhook
await bot.telegram.deleteWebhook();
await registerBotCommands();

bot.launch();
console.log("Bot is running...");
startApiServer({
    port: PORT,
    botToken: BOT_TOKEN,
    onAction: handleWebAppActionByUser,
    onYookassaPaid: handleYookassaPaid,
    onYookassaRefund: handleYookassaRefund,
    onManualUsdtRequest: handleManualUsdtRequest,
});
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
