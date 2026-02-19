import "dotenv/config";
import fs from "fs";
import path from "path";
import { Telegraf, Markup } from "telegraf";
import { nanoid } from "nanoid";

import {
    hasPurchaseAsync,
    markDownloadAsync,
    removePurchaseAsync,
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

function fileSource(fileName) {
    if (isRemoteFile(fileName)) {
        return { url: String(fileName) };
    }
    return { source: fs.createReadStream(resolveAssetFile(fileName)) };
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

function webAppKeyboardIfAny() {
    return Markup.inlineKeyboard([
        Markup.button.webApp("🗺 Открыть витрину", WEBAPP_URL),
    ]);
}

function withWebAppKeyboard(options = {}) {
    const kb = webAppKeyboardIfAny();
    return kb ? { ...options, ...kb } : options;
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
        `Подтвердить: /approve ${userId} ${productId}`,
        `Отклонить: /reject ${userId} ${productId}`,
    ];
    try {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, lines.join("\n"));
    } catch (error) {
        const details =
            error?.description ||
            error?.response?.description ||
            error?.message ||
            String(error);
        throw new Error(`admin_notify_failed:${details}`);
    }
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

    await bot.telegram.sendMessage(
        userId,
        "Платёж пока не подтверждён. Проверь TXID и сумму или напиши в поддержку.",
        withWebAppKeyboard()
    );
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
    const data = extractWebAppData(ctx);
    if (!data) return;
    try { await ctx.answerCbQuery(); } catch {}
    return handleWebAppAction(ctx, data);
});

bot.catch((err) => console.error("BOT ERROR:", err));

// На всякий: чтобы polling не конфликтовал с webhook
await bot.telegram.deleteWebhook();

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
