import "dotenv/config";
import fs from "fs";
import path from "path";
import { Telegraf } from "telegraf";
import { nanoid } from "nanoid";
import { mainMenuKeyboard } from "./keyboards.js";
import { hasPurchase, storePurchase } from "./storage.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing in .env");

const PRICE_STARS = Number(process.env.PRICE_STARS || "199");
const PRODUCT_ID = process.env.PRODUCT_ID || "batumi_full_v1";

const MINI_KMZ_PATH = path.resolve(process.env.MINI_KMZ_PATH || "./assets/batumi-mini.kmz");
const FULL_KMZ_PATH = path.resolve(process.env.FULL_KMZ_PATH || "./assets/batumi-full.kmz");

for (const p of [MINI_KMZ_PATH, FULL_KMZ_PATH]) {
    if (!fs.existsSync(p)) {
        throw new Error(`File not found: ${p}`);
    }
}

const bot = new Telegraf(BOT_TOKEN);

function instructionText() {
    return [
        "📍 *Как импортировать точки в Organic Maps / MAPS.ME*",
        "1) Скачай файл .kmz (я отправляю его документом).",
        "2) Открой файл на телефоне и выбери *Organic Maps* или *MAPS.ME*.",
        "3) Подтверди импорт — точки появятся в закладках/избранном.",
        "",
        "Если не импортируется — напиши /support (модель телефона + скрин ошибки)."
    ].join("\n");
}

async function sendKmz(ctx, filePath, caption) {
    await ctx.replyWithDocument(
        { source: fs.createReadStream(filePath) },
        { caption, parse_mode: "Markdown" }
    );
}

async function showMain(ctx) {
    await ctx.reply(
        "Привет! Это бот с путеводителем по Батуми в формате точек (.kmz) для Organic Maps / MAPS.ME.\n\nВыбирай действие:",
        mainMenuKeyboard()
    );
}

// /start
bot.start(async (ctx) => {
    await showMain(ctx);
});

// /terms и /support — Telegram рекомендует иметь быстрый доступ к этим командам :contentReference[oaicite:3]{index=3}
bot.command("terms", async (ctx) => {
    await ctx.reply(
        "📄 *Условия*\n\n" +
        "— Продукт: цифровой файл .kmz (точки на карте).\n" +
        "— Доставка: автоматически в этом чате после оплаты.\n" +
        "— Поддержка: /support\n\n" +
        "Если нужно — я помогу оформить полный текст условий позже.",
        { parse_mode: "Markdown" }
    );
});

bot.command("support", async (ctx) => {
    await ctx.reply(
        "🆘 *Поддержка*\n\nОпиши проблему и пришли:\n— модель телефона\n— что за приложение (Organic Maps или MAPS.ME)\n— скрин/видео ошибки\n\nЯ отвечу и помогу.",
        { parse_mode: "Markdown" }
    );
});

// Кнопки
bot.action("GET_MINI", async (ctx) => {
    await ctx.answerCbQuery();
    await sendKmz(ctx, MINI_KMZ_PATH, "✅ Вот mini-версия путеводителя (.kmz).");
    await ctx.reply(instructionText(), { parse_mode: "Markdown" });
});

bot.action("HOW_TO", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(instructionText(), { parse_mode: "Markdown" });
});

bot.action("DOWNLOAD_AGAIN", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!hasPurchase(userId, PRODUCT_ID)) {
        await ctx.reply("Похоже, полной покупки ещё нет. Нажми «Купить полный путеводитель».", mainMenuKeyboard());
        return;
    }

    await sendKmz(ctx, FULL_KMZ_PATH, "🔁 Повторная выдача полной версии (.kmz).");
    await ctx.reply(instructionText(), { parse_mode: "Markdown" });
});

bot.action("BUY_FULL", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    // если уже купил — не просим платить второй раз
    if (hasPurchase(userId, PRODUCT_ID)) {
        await ctx.reply("✅ У тебя уже есть покупка. Держи файл ещё раз:");
        await sendKmz(ctx, FULL_KMZ_PATH, "📎 Полная версия (.kmz).");
        await ctx.reply(instructionText(), { parse_mode: "Markdown" });
        return;
    }

const payload = `${PRODUCT_ID}:${userId}:${nanoid(10)}`;

  // Stars: currency = XTR, provider_token можно пустой строкой, prices = 1 item :contentReference[oaicite:4]{index=4}
    await ctx.replyWithInvoice({
        title: "Путеводитель по Батуми (полная версия)",
        description: "Все точки + логика маршрута. Формат: .kmz для Organic Maps / MAPS.ME.",
        payload,
        provider_token: "",     // для Stars можно оставить пустым :contentReference[oaicite:5]{index=5}
        currency: "XTR",
        prices: [{ label: "Batumi guide", amount: PRICE_STARS }]
    });
});

// Pre-checkout: нужно ответить <= 10 сек, иначе платёж отменится :contentReference[oaicite:6]{index=6}
bot.on("pre_checkout_query", async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
});

// Успешная оплата → записываем charge_id и выдаём файл :contentReference[oaicite:7]{index=7}
bot.on("successful_payment", async (ctx) => {
    const sp = ctx.message?.successful_payment;
    const userId = ctx.from?.id;
    if (!sp || !userId) return;

    // Telegram рекомендует сохранять telegram_payment_charge_id :contentReference[oaicite:8]{index=8}
    storePurchase({
        userId,
        productId: PRODUCT_ID,
        telegramPaymentChargeId: sp.telegram_payment_charge_id,
        payload: sp.invoice_payload
    });

    await ctx.reply("✅ Оплата прошла! Сейчас пришлю файл.");
    await sendKmz(ctx, FULL_KMZ_PATH, "📎 Полная версия путеводителя (.kmz).");
    await ctx.reply(instructionText(), { parse_mode: "Markdown" });
});

bot.catch((err) => console.error("BOT ERROR:", err));

bot.on("message", async (ctx) => {
    const wa = ctx.message?.web_app_data;
    if (!wa?.data) return;

    let data;
    try { data = JSON.parse(wa.data); } catch { data = { action: wa.data }; }

    if (data.action === "GET_MINI") {
        await sendKmz(ctx, MINI_KMZ_PATH, "✅ Вот mini-версия путеводителя (.kmz).");
        await ctx.reply(instructionText(), { parse_mode: "Markdown" });
    }

    if (data.action === "HOW_TO") {
        await ctx.reply(instructionText(), { parse_mode: "Markdown" });
    }

    if (data.action === "BUY_FULL") {
        // просто вызываем ту же логику покупки, что у кнопки BUY_FULL
        // самый простой способ — скопировать код из bot.action("BUY_FULL", ...) в функцию и вызывать её тут
        await ctx.reply("Ок! Сейчас открою оплату Stars…");
        // ниже — вариант “быстро”: имитируем нажатие callback
        // но лучше вынести покупку в отдельную функцию
    }
});

bot.launch();
console.log("Bot is running...");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
