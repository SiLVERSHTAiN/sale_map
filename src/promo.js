export function normalizePromoCode(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
}

export function clampPromoDiscount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(95, Math.floor(n)));
}

function roundDiscountedAmount(amount, step) {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const floored = Math.floor(amount / step) * step;
    if (floored > 0) return floored;
    return Math.max(1, Math.floor(amount));
}

export function applyPromoDiscount(rawAmount, discountPercent, kind = "rub") {
    const amount = Number(rawAmount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return 0;

    const percent = clampPromoDiscount(discountPercent);
    if (percent <= 0) return amount;

    const discounted = amount - amount * (percent / 100);
    const step = kind === "usdt" ? 1 : 10;
    return roundDiscountedAmount(discounted, step);
}

export function sanitizePromoConfig(raw) {
    const code = normalizePromoCode(raw?.code);
    const discountPercent = clampPromoDiscount(raw?.discountPercent);
    const enabled = Boolean(raw?.enabled);
    return {
        code,
        discountPercent,
        enabled: enabled && Boolean(code) && discountPercent > 0,
        updatedAt: raw?.updatedAt || null,
    };
}

export function isPromoActive(config) {
    const promo = sanitizePromoConfig(config);
    return promo.enabled && Boolean(promo.code) && promo.discountPercent > 0;
}

export function validatePromoCode(config, code) {
    const promo = sanitizePromoConfig(config);
    if (!isPromoActive(promo)) {
        return { ok: false, reason: "promo_disabled", promo };
    }

    const normalized = normalizePromoCode(code);
    if (!normalized) {
        return { ok: false, reason: "promo_missing", promo };
    }

    if (promo.code !== normalized) {
        return { ok: false, reason: "promo_invalid", promo };
    }

    return {
        ok: true,
        reason: "promo_valid",
        promo: {
            code: promo.code,
            discountPercent: promo.discountPercent,
            enabled: true,
            updatedAt: promo.updatedAt || null,
        },
    };
}
