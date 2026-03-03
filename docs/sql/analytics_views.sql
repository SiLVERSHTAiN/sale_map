-- Run in Neon SQL editor.
-- This file creates rollup table + helper views.

CREATE TABLE IF NOT EXISTS daily_metrics (
    day DATE PRIMARY KEY,
    dau INTEGER NOT NULL DEFAULT 0,
    app_opens INTEGER NOT NULL DEFAULT 0,
    buy_card_clicks INTEGER NOT NULL DEFAULT 0,
    buy_usdt_clicks INTEGER NOT NULL DEFAULT 0,
    buy_stars_clicks INTEGER NOT NULL DEFAULT 0,
    usdt_requests INTEGER NOT NULL DEFAULT 0,
    free_download_clicks INTEGER NOT NULL DEFAULT 0,
    paid_purchases INTEGER NOT NULL DEFAULT 0,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Manual rollup example for last 180 days.
WITH e AS (
    SELECT
        (ts AT TIME ZONE 'Europe/Moscow')::date AS day,
        COUNT(*) FILTER (WHERE event_type = 'app_open') AS app_opens,
        COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'app_open') AS dau,
        COUNT(*) FILTER (WHERE event_type = 'click_buy_card') AS buy_card_clicks,
        COUNT(*) FILTER (WHERE event_type = 'click_buy_usdt') AS buy_usdt_clicks,
        COUNT(*) FILTER (WHERE event_type = 'click_buy_stars') AS buy_stars_clicks,
        COUNT(*) FILTER (WHERE event_type = 'usdt_submit_success') AS usdt_requests,
        COUNT(*) FILTER (WHERE event_type = 'click_get_file') AS free_download_clicks
    FROM events
    WHERE ts >= NOW() - INTERVAL '180 days'
    GROUP BY 1
),
p AS (
    SELECT
        (paid_at AT TIME ZONE 'Europe/Moscow')::date AS day,
        COUNT(*) AS paid_purchases
    FROM purchases
    WHERE paid_at >= NOW() - INTERVAL '180 days'
    GROUP BY 1
),
merged AS (
    SELECT
        COALESCE(e.day, p.day) AS day,
        COALESCE(e.dau, 0) AS dau,
        COALESCE(e.app_opens, 0) AS app_opens,
        COALESCE(e.buy_card_clicks, 0) AS buy_card_clicks,
        COALESCE(e.buy_usdt_clicks, 0) AS buy_usdt_clicks,
        COALESCE(e.buy_stars_clicks, 0) AS buy_stars_clicks,
        COALESCE(e.usdt_requests, 0) AS usdt_requests,
        COALESCE(e.free_download_clicks, 0) AS free_download_clicks,
        COALESCE(p.paid_purchases, 0) AS paid_purchases
    FROM e
    FULL JOIN p USING (day)
)
INSERT INTO daily_metrics (
    day,
    dau,
    app_opens,
    buy_card_clicks,
    buy_usdt_clicks,
    buy_stars_clicks,
    usdt_requests,
    free_download_clicks,
    paid_purchases,
    computed_at
)
SELECT
    day,
    dau,
    app_opens,
    buy_card_clicks,
    buy_usdt_clicks,
    buy_stars_clicks,
    usdt_requests,
    free_download_clicks,
    paid_purchases,
    NOW()
FROM merged
ON CONFLICT (day)
DO UPDATE SET
    dau = EXCLUDED.dau,
    app_opens = EXCLUDED.app_opens,
    buy_card_clicks = EXCLUDED.buy_card_clicks,
    buy_usdt_clicks = EXCLUDED.buy_usdt_clicks,
    buy_stars_clicks = EXCLUDED.buy_stars_clicks,
    usdt_requests = EXCLUDED.usdt_requests,
    free_download_clicks = EXCLUDED.free_download_clicks,
    paid_purchases = EXCLUDED.paid_purchases,
    computed_at = NOW();

CREATE OR REPLACE VIEW analytics_daily AS
SELECT
    day,
    dau,
    app_opens,
    buy_card_clicks,
    buy_usdt_clicks,
    buy_stars_clicks,
    usdt_requests,
    free_download_clicks,
    paid_purchases,
    computed_at
FROM daily_metrics
ORDER BY day DESC;

CREATE OR REPLACE VIEW analytics_weekly AS
SELECT
    date_trunc('week', day::timestamp)::date AS period_start,
    (date_trunc('week', day::timestamp)::date + 6) AS period_end,
    COUNT(*)::int AS days_count,
    ROUND(AVG(dau)::numeric, 1) AS dau_avg,
    MAX(dau)::int AS dau_peak,
    SUM(app_opens)::int AS app_opens,
    SUM(buy_card_clicks)::int AS buy_card_clicks,
    SUM(buy_usdt_clicks)::int AS buy_usdt_clicks,
    SUM(buy_stars_clicks)::int AS buy_stars_clicks,
    SUM(usdt_requests)::int AS usdt_requests,
    SUM(free_download_clicks)::int AS free_download_clicks,
    SUM(paid_purchases)::int AS paid_purchases
FROM daily_metrics
GROUP BY 1, 2
ORDER BY period_start DESC;

CREATE OR REPLACE VIEW analytics_monthly AS
SELECT
    date_trunc('month', day::timestamp)::date AS period_start,
    (date_trunc('month', day::timestamp)::date + INTERVAL '1 month - 1 day')::date AS period_end,
    COUNT(*)::int AS days_count,
    ROUND(AVG(dau)::numeric, 1) AS dau_avg,
    MAX(dau)::int AS dau_peak,
    SUM(app_opens)::int AS app_opens,
    SUM(buy_card_clicks)::int AS buy_card_clicks,
    SUM(buy_usdt_clicks)::int AS buy_usdt_clicks,
    SUM(buy_stars_clicks)::int AS buy_stars_clicks,
    SUM(usdt_requests)::int AS usdt_requests,
    SUM(free_download_clicks)::int AS free_download_clicks,
    SUM(paid_purchases)::int AS paid_purchases
FROM daily_metrics
GROUP BY 1, 2
ORDER BY period_start DESC;

CREATE OR REPLACE VIEW analytics_top_cities AS
SELECT
    COALESCE(city, 'unknown') AS city,
    COUNT(*) FILTER (WHERE event_type = 'city_focus') AS city_focuses,
    COUNT(*) FILTER (
        WHERE event_type IN ('click_buy_card', 'click_buy_usdt', 'click_buy_stars')
    ) AS buy_clicks
FROM events
GROUP BY 1
ORDER BY buy_clicks DESC, city_focuses DESC;

CREATE OR REPLACE VIEW analytics_users_last_seen AS
SELECT
    user_id,
    username,
    language_code,
    opens_count,
    last_platform,
    first_seen_at,
    last_seen_at
FROM users
ORDER BY last_seen_at DESC;

-- Manual cleanup examples:
-- DELETE FROM events WHERE ts < NOW() - INTERVAL '90 days';
-- DELETE FROM daily_metrics WHERE day < (NOW() AT TIME ZONE 'Europe/Moscow')::date - 179;
