import { Markup } from "telegraf";

export function mainMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.webApp("🗺 Открыть витрину", "https://YOUR_DOMAIN/index.html")],
        [Markup.button.callback("✅ Бесплатный mini-гайд (.kmz)", "GET_MINI")],
        [Markup.button.callback("⭐ Купить полный путеводитель (Stars)", "BUY_FULL")],
        [Markup.button.callback("❓ Как установить (инструкция)", "HOW_TO")],
        [Markup.button.callback("🔁 Скачать ещё раз", "DOWNLOAD_AGAIN")]
    ]);
}

