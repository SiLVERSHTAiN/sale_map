import "dotenv/config";
import fs from "fs";
import path from "path";
import { Telegraf, Markup } from "telegraf";
import { nanoid } from "nanoid";

import { hasPurchaseAsync, storePurchaseAsync } from "./storage.js";

// -------------------- ENV --------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing in .env");

const ASSETS_DIR = process.env.ASSETS_DIR || "./assets";
const CATALOG_PATH = process.env.CATALOG_PATH || "./docs/products.json";
const DEFAULT_CITY_ID = process.env.DEFAULT_CITY_ID || "";

// URL витрины. Можно переопределить через .env (WEBAPP_URL)
const WEBAPP_URL =
    process.env.WEBAPP_URL || "https://silvershtain.github.io/sale_map/";

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
    return Markup.keyboard([[Markup.button.webApp("🗺 Открыть витрину", WEBAPP_URL)]])
        .resize()
        .persistent();
}

async function sendKmz(ctx, filePath, caption) {
    await ctx.replyWithDocument(
        fileSource(filePath),
        { caption, parse_mode: "Markdown" }
    );
}

// -------------------- Business Logic --------------------
async function handleHowTo(ctx) {
    await ctx.reply(instructionText(), { parse_mode: "Markdown" });
}

async function handleGetFile(ctx, productId) {
    const { productsById, citiesById } = getCatalog();
    const product = productsById[productId];

    if (!product) {
        await ctx.reply("Не нашёл такой продукт 🙈 Открой витрину ещё раз.", webAppKeyboardIfAny());
        return;
    }

    // full (платный) отдаём только если куплен
    if (product.type === "full" && Number(product.priceStars || 0) > 0) {
        const userId = ctx.from?.id;
        if (!userId) return;

        if (!(await hasPurchaseAsync(userId, product.id))) {
            await ctx.reply("Полная версия доступна после оплаты ⭐", webAppKeyboardIfAny());
            return;
        }
    }

    const city = citiesById[product.cityId];
    const caption = `✅ *${product.title || "Файл"}*\n${cityLabel(city)}`.trim();

    await sendKmz(ctx, product.file, caption);
    await handleHowTo(ctx);
}

async function handleBuy(ctx, productId) {
    const { productsById, citiesById } = getCatalog();
    const product = productsById[productId];

    if (!product) {
        await ctx.reply("Не нашёл такой продукт 🙈 Открой витрину ещё раз.", webAppKeyboardIfAny());
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
        await ctx.reply("✅ Уже куплено. Отправляю файл ещё раз:");
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

// -------------------- Bot --------------------
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
    const kb = webAppKeyboardIfAny();
    await ctx.reply(
        "Я собрал готовые места на карте: еда, виды, прогулки и много полезного.\n\nНажми кнопку «🗺 Открыть витрину» ниже 🔻 — выбирай город и получишь файл в этот чат.",
        kb
            ? { parse_mode: "Markdown", disable_web_page_preview: true, ...kb }
            : { parse_mode: "Markdown", disable_web_page_preview: true }
    );
});

bot.command("support", async (ctx) => {
    await ctx.reply(
        "🆘 *Поддержка*\n\nОпиши проблему и пришли:\n— модель телефона\n— приложение (Organic Maps или MAPS.ME)\n— скрин/видео ошибки\n\nЯ помогу.",
        { parse_mode: "Markdown" }
    );
});

bot.command("how", handleHowTo);

// Быстрая проверка что каталог читается
bot.command("catalog", async (ctx) => {
    const { catalog } = getCatalog();
    const cities = (catalog.cities || []).filter((c) => c.active !== false);
    const products = (catalog.products || []).filter((p) => p.active !== false);
    await ctx.reply(`📦 Catalog OK\nCities: ${cities.length}\nProducts: ${products.length}`);
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
        await ctx.reply("✅ Оплата прошла, но я не понял какой продукт. Напиши /support");
        return;
    }

    await storePurchaseAsync({
        userId,
        productId,
        telegramPaymentChargeId: sp.telegram_payment_charge_id,
        payload: sp.invoice_payload,
    });

    await ctx.reply("✅ Оплата прошла! Сейчас пришлю файл.");
    await handleGetFile(ctx, productId);
});

// Главный обработчик команд из Mini App (web_app_data)
bot.on("message", async (ctx) => {
    const wa = ctx.message?.web_app_data;
    if (!wa?.data) return;

    // Ждём JSON вида: { action:"BUY", productId:"batumi_full" }
    // Поддержим и старый формат: "GET_MINI" / "BUY_FULL" / "HOW_TO"
    let data = safeJsonParse(wa.data);
    if (!data) data = { action: wa.data };

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
        if (!productId) return ctx.reply("Mini-версия не настроена в каталоге.");
        return handleGetFile(ctx, productId);
    }

    if (action === "BUY_FULL" || action === "BUY") {
        if (!productId) return ctx.reply("Full-версия не настроена в каталоге.");
        return handleBuy(ctx, productId);
    }

    await ctx.reply("Неизвестное действие 🙈 Открой витрину ещё раз.", webAppKeyboardIfAny());
});

bot.catch((err) => console.error("BOT ERROR:", err));

// На всякий: чтобы polling не конфликтовал с webhook
await bot.telegram.deleteWebhook();

bot.launch();
console.log("Bot is running...");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
