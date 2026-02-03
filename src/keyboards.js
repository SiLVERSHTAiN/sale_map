import { Markup } from "telegraf";

export function webAppReplyKeyboard() {
    return Markup.keyboard([
        Markup.button.webApp("🗺 Открыть витрину", "https://silvershtain.github.io/sale_map/")
    ])
        .resize();
}

export function mainMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("✅ Бесплатный mini-гайд (.kmz)", "GET_MINI")],
        [Markup.button.callback("⭐ Купить полный путеводитель (Stars)", "BUY_FULL")],
        [Markup.button.callback("❓ Как установить (инструкция)", "HOW_TO")],
        [Markup.button.callback("🔁 Скачать ещё раз", "DOWNLOAD_AGAIN")]
    ]);
}
