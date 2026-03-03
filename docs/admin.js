"use strict";

const STORAGE_KEYS = {
    apiBase: "admin.analytics.apiBase",
    token: "admin.analytics.token",
    days: "admin.analytics.days",
};

const el = {
    apiBase: document.getElementById("admin-api-base"),
    token: document.getElementById("admin-token"),
    days: document.getElementById("admin-days"),
    refresh: document.getElementById("admin-refresh"),
    meta: document.getElementById("admin-meta"),
    error: document.getElementById("admin-error"),
    summary: document.getElementById("admin-summary"),
    dailyBody: document.getElementById("admin-daily-body"),
    weeklyBody: document.getElementById("admin-weekly-body"),
    monthlyBody: document.getElementById("admin-monthly-body"),
    citiesBody: document.getElementById("admin-cities-body"),
    usersBody: document.getElementById("admin-users-body"),
};

const numberFmt = new Intl.NumberFormat("ru-RU");
const dateTimeFmt = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});

function normalizeApiBase(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw.replace(/\/+$/, "");
}

function clampDays(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 30;
    return Math.max(1, Math.min(120, Math.floor(n)));
}

function formatDateTime(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return dateTimeFmt.format(date);
}

function formatDay(day) {
    const s = String(day || "");
    const parts = s.split("-");
    if (parts.length !== 3) return s || "—";
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function formatPeriod(periodStart, periodEnd) {
    const start = formatDay(periodStart);
    const end = formatDay(periodEnd);
    if (start === "—" && end === "—") return "—";
    if (start === end) return start;
    return `${start} — ${end}`;
}

function setError(text) {
    if (!text) {
        el.error.textContent = "";
        el.error.classList.add("hidden");
        return;
    }
    el.error.textContent = text;
    el.error.classList.remove("hidden");
}

function setMeta(text) {
    el.meta.textContent = text || "—";
}

function setLoading(loading) {
    el.refresh.disabled = loading;
    el.refresh.textContent = loading ? "Загрузка..." : "Обновить";
}

function storageSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {}
}

function storageGet(key) {
    try {
        return localStorage.getItem(key) || "";
    } catch {
        return "";
    }
}

function readSettings() {
    return {
        apiBase: normalizeApiBase(el.apiBase.value),
        token: String(el.token.value || "").trim(),
        days: clampDays(el.days.value),
    };
}

function saveSettings(settings) {
    storageSet(STORAGE_KEYS.apiBase, settings.apiBase);
    storageSet(STORAGE_KEYS.token, settings.token);
    storageSet(STORAGE_KEYS.days, String(settings.days));
}

function hydrateSettings() {
    const defaultApiBase = normalizeApiBase(
        window.APP_CONFIG?.API_BASE || window.location.origin || ""
    );
    const savedApiBase = normalizeApiBase(storageGet(STORAGE_KEYS.apiBase));
    const savedToken = storageGet(STORAGE_KEYS.token);
    const savedDays = storageGet(STORAGE_KEYS.days);

    el.apiBase.value = savedApiBase || defaultApiBase;
    el.token.value = savedToken || "";
    el.days.value = String(clampDays(savedDays || 30));
}

function toInt(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
}

function sumDaily(rows, key) {
    return (rows || []).reduce((acc, row) => acc + toInt(row?.[key]), 0);
}

function renderSummary(summary, daily) {
    const usersTotal = toInt(summary?.users_total);
    const buyersTotal = toInt(summary?.buyers_total);
    const purchasesTotal = toInt(summary?.purchases_total);
    const buyClicksTotal =
        sumDaily(daily, "buy_card_clicks") +
        sumDaily(daily, "buy_usdt_clicks") +
        sumDaily(daily, "buy_stars_clicks");
    const appOpensTotal = sumDaily(daily, "app_opens");
    const usdtRequestsTotal = sumDaily(daily, "usdt_requests");
    const conversion =
        usersTotal > 0 ? `${((buyersTotal / usersTotal) * 100).toFixed(1)}%` : "0%";

    const cards = [
        { label: "Пользователи", value: numberFmt.format(usersTotal) },
        { label: "Покупатели", value: numberFmt.format(buyersTotal) },
        { label: "Покупки (всего)", value: numberFmt.format(purchasesTotal) },
        { label: "Конверсия в покупателя", value: conversion },
        { label: "Открытия за период", value: numberFmt.format(appOpensTotal) },
        { label: "Клики «Купить»", value: numberFmt.format(buyClicksTotal) },
        { label: "USDT заявки", value: numberFmt.format(usdtRequestsTotal) },
    ];

    el.summary.innerHTML = cards
        .map(
            (card) => `
            <article class="admin-kpi">
                <div class="admin-kpi-label">${card.label}</div>
                <div class="admin-kpi-value">${card.value}</div>
            </article>
        `
        )
        .join("");
}

function renderDaily(rows) {
    if (!rows?.length) {
        el.dailyBody.innerHTML = `
            <tr>
                <td class="admin-empty" colspan="9">Нет данных за выбранный период.</td>
            </tr>
        `;
        return;
    }

    el.dailyBody.innerHTML = rows
        .map(
            (row) => `
            <tr>
                <td>${formatDay(row.day)}</td>
                <td>${numberFmt.format(toInt(row.dau))}</td>
                <td>${numberFmt.format(toInt(row.app_opens))}</td>
                <td>${numberFmt.format(toInt(row.buy_card_clicks))}</td>
                <td>${numberFmt.format(toInt(row.buy_usdt_clicks))}</td>
                <td>${numberFmt.format(toInt(row.buy_stars_clicks))}</td>
                <td>${numberFmt.format(toInt(row.usdt_requests))}</td>
                <td>${numberFmt.format(toInt(row.free_download_clicks))}</td>
                <td>${numberFmt.format(toInt(row.paid_purchases))}</td>
            </tr>
        `
        )
        .join("");
}

function renderPeriod(rows, bodyEl) {
    if (!rows?.length) {
        bodyEl.innerHTML = `
            <tr>
                <td class="admin-empty" colspan="10">Нет данных за выбранный период.</td>
            </tr>
        `;
        return;
    }

    bodyEl.innerHTML = rows
        .map(
            (row) => `
            <tr>
                <td>${formatPeriod(row.period_start, row.period_end)}</td>
                <td>${numberFmt.format(toInt(row.dau_avg))}</td>
                <td>${numberFmt.format(toInt(row.dau_peak))}</td>
                <td>${numberFmt.format(toInt(row.app_opens))}</td>
                <td>${numberFmt.format(toInt(row.buy_card_clicks))}</td>
                <td>${numberFmt.format(toInt(row.buy_usdt_clicks))}</td>
                <td>${numberFmt.format(toInt(row.buy_stars_clicks))}</td>
                <td>${numberFmt.format(toInt(row.usdt_requests))}</td>
                <td>${numberFmt.format(toInt(row.free_download_clicks))}</td>
                <td>${numberFmt.format(toInt(row.paid_purchases))}</td>
            </tr>
        `
        )
        .join("");
}

function renderCities(rows) {
    if (!rows?.length) {
        el.citiesBody.innerHTML = `
            <tr>
                <td class="admin-empty" colspan="3">Пока нет данных.</td>
            </tr>
        `;
        return;
    }

    el.citiesBody.innerHTML = rows
        .map(
            (row) => `
            <tr>
                <td>${row.city || "—"}</td>
                <td>${numberFmt.format(toInt(row.city_focuses))}</td>
                <td>${numberFmt.format(toInt(row.buy_clicks))}</td>
            </tr>
        `
        )
        .join("");
}

function renderUsers(rows) {
    if (!rows?.length) {
        el.usersBody.innerHTML = `
            <tr>
                <td class="admin-empty" colspan="6">Пока нет данных.</td>
            </tr>
        `;
        return;
    }

    el.usersBody.innerHTML = rows
        .map((row) => {
            const username = row.username ? `@${row.username}` : "—";
            return `
                <tr>
                    <td>${numberFmt.format(toInt(row.user_id))}</td>
                    <td>${username}</td>
                    <td>${row.language_code || "—"}</td>
                    <td>${numberFmt.format(toInt(row.opens_count))}</td>
                    <td>${row.last_platform || "—"}</td>
                    <td>${formatDateTime(row.last_seen_at)}</td>
                </tr>
            `;
        })
        .join("");
}

async function loadAnalytics() {
    const settings = readSettings();
    saveSettings(settings);
    el.days.value = String(settings.days);
    setError("");

    if (!settings.apiBase) {
        setError("Укажите API Base.");
        return;
    }
    if (!settings.token) {
        setError("Укажите admin token.");
        return;
    }

    const url = new URL(`${settings.apiBase}/api/admin/analytics`);
    url.searchParams.set("days", String(settings.days));
    url.searchParams.set("topCitiesLimit", "20");
    url.searchParams.set("usersLimit", "100");

    setLoading(true);
    try {
        const resp = await fetch(url.toString(), {
            method: "GET",
            headers: {
                Authorization: `Bearer ${settings.token}`,
            },
        });
        const text = await resp.text();
        const data = text ? JSON.parse(text) : null;
        if (!resp.ok || !data?.ok) {
            const apiError = data?.error ? ` (${data.error})` : "";
            if (resp.status === 401) {
                throw new Error(`Доступ запрещен: проверь token${apiError}`);
            }
            throw new Error(`Ошибка API: HTTP ${resp.status}${apiError}`);
        }

        renderSummary(data.summary, data.daily);
        renderDaily(data.daily);
        renderPeriod(data.weekly, el.weeklyBody);
        renderPeriod(data.monthly, el.monthlyBody);
        renderCities(data.topCities);
        renderUsers(data.usersLastSeen);
        setMeta(
            `Обновлено: ${formatDateTime(data.generatedAt)} · Период: ${numberFmt.format(
                toInt(data.rangeDays)
            )} дн.`
        );
    } catch (error) {
        setError(error?.message || "Не удалось загрузить аналитику.");
    } finally {
        setLoading(false);
    }
}

function bindEvents() {
    el.refresh.addEventListener("click", () => {
        loadAnalytics();
    });

    el.days.addEventListener("blur", () => {
        el.days.value = String(clampDays(el.days.value));
    });

    [el.apiBase, el.token, el.days].forEach((input) => {
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                loadAnalytics();
            }
        });
    });
}

function init() {
    hydrateSettings();
    bindEvents();
    setMeta("Заполните token и нажмите «Обновить».");
    if (el.token.value.trim()) {
        loadAnalytics();
    }
}

init();
