const tg = window.Telegram?.WebApp;
const isTg = !!tg;
const APP_CONFIG = window.APP_CONFIG || {};
const API_BASE = String(APP_CONFIG.API_BASE || "").replace(/\/$/, "");
const ENTITLEMENTS_KEY = 'entitlements.v2';
const ENTITLEMENTS_TTL = 10 * 60 * 1000;
const PENDING_PAYMENT_KEY = 'pending_payment.v1';
const TRACK_SESSION_KEY = 'track.session.v1';

function applyTelegramTheme(){
    if (!isTg) return;
    tg.ready();
    tg.expand();
    
    const css = document.documentElement.style;
    const scheme = (tg.colorScheme || 'dark').toLowerCase();
    const p = tg.themeParams || {};
    
    if (scheme === 'light') {
        css.setProperty('--bg',    '#f6f7fb');
        css.setProperty('--card',  '#ffffff');
        css.setProperty('--card2', '#ffffff');
        css.setProperty('--text',  '#0f172a');
        css.setProperty('--muted', '#334155');
        css.setProperty('--stroke','rgba(15, 23, 42, .08)');
        css.setProperty('--btn',   '#eef2ff');
        css.setProperty('--btnText','#0f172a');
        css.setProperty('--shadow','0 18px 40px rgba(15, 23, 42, .10)');
        css.setProperty('--skeleton','rgba(15, 23, 42, .08)');
        css.setProperty('--skeletonShine','rgba(15, 23, 42, .18)');
        css.setProperty('--consent-bg','rgba(15, 23, 42, .04)');
        css.setProperty('--consent-border','rgba(15, 23, 42, .08)');
        css.setProperty('--consent-text','#1f2937');
        css.setProperty('--consent-link','#1f3b7a');
    } else {
      // dark — базовые значения уже в css, можно не трогать
    }

    if (p.button_color) css.setProperty('--accent', p.button_color);
    if (p.button_text_color) css.setProperty('--accentText', p.button_text_color);

    try { tg.setHeaderColor?.(scheme === 'light' ? '#f6f7fb' : '#0b1220'); } catch(e){}
    try { tg.setBackgroundColor?.(scheme === 'light' ? '#f6f7fb' : '#0b1220'); } catch(e){}
}

function getInitData(){
    const tgNow = window.Telegram?.WebApp;
    const raw = tgNow?.initData || '';
    if (raw) return raw;
    const params = new URLSearchParams(window.location.search);
    return params.get('tgWebAppData') || '';
}

async function waitInitData(timeoutMs = 2000){
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const d = getInitData();
        if (d) return d;
        await new Promise(r => setTimeout(r, 150));
    }
    return '';
}

function readTrackSessionId(){
    try{
        const v = sessionStorage.getItem(TRACK_SESSION_KEY);
        return v ? String(v) : null;
    }catch(e){
        return null;
    }
}

function writeTrackSessionId(sessionId){
    if (!sessionId) return;
    try{
        sessionStorage.setItem(TRACK_SESSION_KEY, String(sessionId));
    }catch(e){}
}

async function trackEvent(eventType, extra = {}){
    if (!API_BASE || !eventType) return null;
    const initData = await waitInitData(900);
    if (!initData) return null;

    const body = {
        initData,
        eventType: String(eventType),
        sessionId: extra.sessionId || readTrackSessionId() || undefined,
        page: extra.page || document.body?.dataset?.page || 'home',
        productId: extra.productId || undefined,
        city: extra.city || undefined,
        payload: extra.payload || undefined,
        platform: isTg && tg?.platform ? String(tg.platform) : detectPlatform(),
        tgVersion: isTg && tg?.version ? String(tg.version) : undefined,
        colorScheme: isTg && tg?.colorScheme ? String(tg.colorScheme) : undefined,
        isTg,
        startParam: isTg ? tg?.initDataUnsafe?.start_param : undefined
    };

    try{
        const res = await fetch(`${API_BASE}/api/track`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.sessionId) {
            writeTrackSessionId(data.sessionId);
        }
        return data;
    }catch(e){
        return null;
    }
}

async function ensureTrackingSession(page){
    const existing = readTrackSessionId();
    if (existing) {
        void trackEvent('page_view', {
            page,
            payload: { path: window.location.pathname, hash: window.location.hash || null }
        });
        return existing;
    }
    const data = await trackEvent('app_open', {
        page,
        payload: { path: window.location.pathname, hash: window.location.hash || null }
    });
    return data?.sessionId || null;
}

function setupSessionEndTracking(page){
    let sent = false;

    const sendEnd = (reason) => {
        if (sent) return;
        sent = true;
        void trackEvent('session_end', {
            page,
            payload: {
                reason,
                path: window.location.pathname,
                hash: window.location.hash || null
            }
        });
    };

    window.addEventListener('pagehide', () => sendEnd('pagehide'), { once: true });
    window.addEventListener('beforeunload', () => sendEnd('beforeunload'), { once: true });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            sendEnd('hidden');
        }
    });
}

async function loadEntitlements(){
    if (!API_BASE || !isTg) return null;
    const initData = await waitInitData();
    if (!initData) return null;

    try{
        const res = await fetch(`${API_BASE}/api/entitlements`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ initData })
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) return null;
        return data;
    }catch(e){
        console.warn('entitlements failed', e);
        return null;
    }
}

function readEntitlementsCache(){
    try{
        const raw = sessionStorage.getItem(ENTITLEMENTS_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.purchases)) return null;
        if (Date.now() - Number(data.ts || 0) > ENTITLEMENTS_TTL) return null;
        return {
            ok: true,
            userId: data.userId || null,
            purchases: data.purchases || [],
            purchasesDetailed: Array.isArray(data.purchasesDetailed) ? data.purchasesDetailed : []
        };
    }catch(e){
        return null;
    }
}

function writeEntitlementsCache(data){
    try{
        const payload = {
            ts: Date.now(),
            userId: data?.userId || null,
            purchases: Array.isArray(data?.purchases) ? data.purchases : [],
            purchasesDetailed: Array.isArray(data?.purchasesDetailed) ? data.purchasesDetailed : []
        };
        sessionStorage.setItem(ENTITLEMENTS_KEY, JSON.stringify(payload));
    }catch(e){}
}

async function getEntitlements({ allowFetch = true, force = false } = {}){
    if (!force) {
        const cached = readEntitlementsCache();
        if (cached) return cached;
    }
    if (!allowFetch) return null;
    const fresh = await loadEntitlements();
    if (fresh) writeEntitlementsCache(fresh);
    return fresh;
}

const LINKS = {
    organic: {
        appstore: 'https://apps.apple.com/ge/app/organic-maps-offline-map-gps/id1567437057',
        play: 'https://play.google.com/store/apps/details?id=app.organicmaps',
        web: 'https://organicmaps.app'
    },
    mapsme: {
        appstore: 'https://apps.apple.com/ge/app/maps-me-offline-maps-gps-nav/id510623322',
        play: 'https://play.google.com/store/apps/details?id=com.mapswithme.maps.pro',
        web: 'https://maps.me'
    }
};

function detectPlatform(){
    if (isTg && tg.platform) return String(tg.platform).toLowerCase();
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
    if (ua.includes('android')) return 'android';
    return 'desktop';
}

function linkFor(app){
    const platform = detectPlatform();
    const l = LINKS[app] || {};
    if (platform === 'ios') return l.appstore || l.web || '#';
    if (platform === 'android') return l.play || l.web || '#';
    if (platform === 'desktop' || platform === 'tdesktop') return l.web || '#';
    return l.web || '#';
}

function setStoreLinks(root){
    root.querySelectorAll('a[data-app]').forEach(a => {
        const app = a.getAttribute('data-app');
        a.href = linkFor(app);
    });
}

function haptic(type='impact', style='light'){
    if (!isTg) return;
    try{
        const hf = tg.HapticFeedback;
        if (!hf) return;
        if (type === 'impact') hf.impactOccurred(style);
        if (type === 'notification') hf.notificationOccurred(style);
    }catch(e){}
}

function setupInfoPanel(){
    const panel = document.getElementById('info-panel');
    if (!panel) return;
    const titleEl = document.getElementById('info-panel-title');
    const bodyEl = document.getElementById('info-panel-body');
    const tabs = Array.from(document.querySelectorAll('.info-tab'));
    const closeBtn = panel.querySelector('.info-close');
    let activeKey = null;

    const content = {
        legend: {
            title: 'Описание точек / Легенда',
            body: `
                <div class="legend-grid">
                    <section class="legend-item legend-red">
                        <h4>🔴 Достопримечательности / Must-see</h4>
                        <p>Куда сходить туристу: визитки города и места, которые стоит увидеть.</p>
                        <div class="legend-tags">
                            <span>⭐️ топ</span><span>🎟 вход/билеты</span><span>🕒 лучшее время</span><span>📸 фотогенично</span><span>🌅 закат</span>
                        </div>
                    </section>

                    <section class="legend-item legend-green">
                        <h4>🟢 Еда и кофе</h4>
                        <p>Кафе, рестораны, завтраки, стрит-фуд, бары.</p>
                        <div class="legend-tags">
                            <span>☕️ кофе</span><span>🍽 еда</span><span>🍷 бар</span><span>💸 бюджетно</span><span>💳 можно картой</span><span>🔌 розетки</span><span>📶 интернет</span>
                        </div>
                    </section>

                    <section class="legend-item legend-yellow">
                        <h4>🟡 Покупки и продукты</h4>
                        <p>Супермаркеты, рынки, сувениры, ТЦ, магазины «купить нужное».</p>
                        <div class="legend-tags">
                            <span>🥬 рынок</span><span>🛒 супермаркет</span><span>🎁 сувениры</span><span>👕 одежда/ТЦ</span><span>💸 выгодно</span>
                        </div>
                    </section>

                    <section class="legend-item legend-blue">
                        <h4>🔵 Природа / Пляжи / Трекинг</h4>
                        <p>Пляжи, парки, тропы, водопады, озера, красивые места вне города.</p>
                        <div class="legend-tags">
                            <span>🏖 пляж</span><span>🥾 трекинг</span><span>🚗 лучше на авто</span><span>🕒 время/длина</span><span>📸 красиво</span>
                        </div>
                    </section>

                    <section class="legend-item legend-purple">
                        <h4>🟣 Полезное туристу (сервисы)</h4>
                        <p>SIM/eSIM, аптеки, банкоматы, обмен, ₿, коворкинги и другое полезное.</p>
                        <div class="legend-tags">
                            <span>📶 связь</span><span>🔌 ноут/розетки</span><span>₿ крипто</span><span>🏧 банкомат</span><span>💊 аптека</span><span>🧺 прачечная</span><span>⚕️ медицина</span><span>🧾 комиссия</span>
                        </div>
                    </section>

                    <section class="legend-item legend-brown">
                        <h4>🟤 Локальные находки / Атмосферно</h4>
                        <p>Небанальные места «по любви»: дворики, тихие споты, локальные находки.</p>
                        <div class="legend-tags">
                            <span>✨ атмосфера</span><span>📸 красиво</span><span>💸 недорого</span>
                        </div>
                    </section>

                    <section class="legend-item legend-black">
                        <h4>⚫️ Важно / Осторожно</h4>
                        <p>Ловушки, сомнительные точки и важные предупреждения.</p>
                        <div class="legend-tags">
                            <span>⚠️ важно</span><span>🚫 не рекомендую</span><span>🕳 развод</span><span>🧾 скрытые комиссии</span><span>🗣 навязывают</span>
                        </div>
                    </section>
                </div>

                <section class="legend-item legend-neutral">
                    <h4>Мини-теги (шпаргалка)</h4>
                    <div class="legend-tags">
                        <span>⭐️ топ / must</span><span>📸 фотогенично</span><span>🌅 закат/рассвет</span><span>🎟 вход/бронь</span><span>🕒 режим/время</span><span>💸 бюджетно</span><span>💳 карта</span><span>🔌 розетки</span><span>📶 интернет</span><span>₿ крипто</span><span>🏧 банкомат</span><span>🧾 комиссия</span><span>🚗 на авто</span><span>🏖 пляж</span><span>🥾 трекинг</span><span>💊 аптека</span><span>🧺 прачечная</span><span>⚕️ медицина</span><span>⚠️ предупреждение</span><span>🚫 не рекомендую</span><span>🐶 dog-friendly</span><span>🚌 общественный транспорт</span>
                    </div>
                </section>
            `
        },
        about: {
            title: 'О сервисе',
            body: `
                <p>Sale Maps — цифровые наборы точек (.kmz) для Organic Maps / MAPS.ME по городам.</p>
                <p>Авторская подборка лучших заведений для комфортного отдыха и прогулок.</p>
                <p>После оплаты файл приходит в этот чат.</p>
            `
        },
        how: {
            title: 'Как работает',
            body: `
                <ul>
                    <li>Выберите город и версию.</li>
                    <li>Оплатите удобным способом.</li>
                    <li>Получите .kmz и импортируйте в приложение.</li>
                </ul>
            `
        },
        support: {
            title: 'Поддержка',
            body: `
                <p>Email: <a href="mailto:silvershtain@mail.ru">silvershtain@mail.ru</a></p>
                <p>Ответ в течение 24 часов.</p>
                <p>Оферта и реквизиты — <a href="./offer.html">смотреть</a>.</p>
            `
        }
    };

    function openPanel(key){
        const item = content[key];
        if (!item) return;
        activeKey = key;
        void trackEvent('info_open', {
            page: document.body?.dataset?.page || 'home',
            payload: { tab: key }
        });
        if (titleEl) titleEl.textContent = item.title;
        if (bodyEl) bodyEl.innerHTML = item.body;
        panel.classList.add('is-open');
        document.body.classList.add('info-open');
        panel.setAttribute('aria-hidden', 'false');
        tabs.forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.info === key);
        });
    }

    function closePanel(){
        if (activeKey) {
            void trackEvent('info_close', {
                page: document.body?.dataset?.page || 'home',
                payload: { tab: activeKey }
            });
        }
        activeKey = null;
        panel.classList.remove('is-open');
        document.body.classList.remove('info-open');
        panel.setAttribute('aria-hidden', 'true');
        tabs.forEach(btn => btn.classList.remove('is-active'));
    }

    tabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.info;
            if (panel.classList.contains('is-open') && activeKey === key) {
                closePanel();
                return;
            }
            openPanel(key);
        });
    });

    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    panel.addEventListener('click', (e) => {
        if (e.target === panel) closePanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePanel();
    });
}

function setPendingPayment(productId){
    if (!productId) return;
    try{
        sessionStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({
            productId,
            ts: Date.now()
        }));
    }catch(e){}
}

function readPendingPayment(){
    try{
        const raw = sessionStorage.getItem(PENDING_PAYMENT_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data?.productId) return null;
        if (Date.now() - Number(data.ts || 0) > 30 * 60 * 1000) {
            sessionStorage.removeItem(PENDING_PAYMENT_KEY);
            return null;
        }
        return data;
    }catch(e){
        return null;
    }
}

function clearPendingPayment(){
    try{ sessionStorage.removeItem(PENDING_PAYMENT_KEY); }catch(e){}
}

function setupPendingAutoClose(){
    if (!isTg) return;
    async function check(){
        const pending = readPendingPayment();
        if (!pending) return;
        const ent = await getEntitlements({ allowFetch: true, force: true });
        const purchases = Array.isArray(ent?.purchases) ? ent.purchases : [];
        if (purchases.map(String).includes(String(pending.productId))) {
            clearPendingPayment();
            setTimeout(() => { try { tg.close(); } catch(e){} }, 600);
        }
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('focus', check);
    check();
}

// ВАЖНО: теперь send принимает (action, productId)
async function send(action, productId){
    const payload = JSON.stringify({ action, productId });
    if (!isTg){
        alert('Открой mini-приложение внутри Telegram.\n\n' + payload);
        return;
    }
    const initData = await waitInitData(1200);
    if (action === 'MANUAL_PAY'){
        const qs = new URLSearchParams();
        qs.set('product', String(productId || ''));
        if (initData) qs.set('tgWebAppData', initData);
        qs.set('v', String(Date.now()));
        const target = `./usdt-pay.html?${qs.toString()}`;
        window.location.href = target;
        return;
    }
    if (action === 'CARD'){
        if (!API_BASE || !initData) {
            alert('Оплата картой доступна только внутри Telegram.');
            return;
        }
        try{
            const res = await fetch(`${API_BASE}/api/yookassa/create`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ initData, productId })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok || !data?.confirmationUrl) {
                const details = typeof data?.details === 'string'
                    ? data.details
                    : (data?.details?.description || data?.error || '');
                alert('Не удалось создать платёж. ' + (details || 'Попробуйте позже.'));
                return;
            }
            try { sessionStorage.removeItem(ENTITLEMENTS_KEY); } catch(e){}
            setPendingPayment(productId);
            if (tg?.openLink) {
                tg.openLink(data.confirmationUrl);
            } else {
                window.location.href = data.confirmationUrl;
            }
        }catch(e){
            alert('Не удалось создать платёж. Попробуйте позже.');
        }
        return;
    }
    if (API_BASE && initData) {
        try{
            await fetch(`${API_BASE}/api/action`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ initData, action, productId })
            });
        }catch(e){}
        try { sessionStorage.removeItem(ENTITLEMENTS_KEY); } catch(e){}
        setTimeout(() => { try { tg.close(); } catch(e){} }, 80);
        return;
    }
    tg.sendData(payload);
    try { sessionStorage.removeItem(ENTITLEMENTS_KEY); } catch(e){}
    setTimeout(() => { try { tg.close(); } catch(e){} }, 80);
}

async function loadCatalog(){
    const res = await fetch('./products.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('products.json не загрузился (HTTP ' + res.status + ')');
    return res.json();
}

function esc(s){
    return String(s ?? '')
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'","&#039;");
}

function safeId(value){
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'city';
}

function toMs(value){
    const t = Date.parse(value || '');
    return Number.isFinite(t) ? t : null;
}

function hasUpdate(product, paidAt, lastDownloadedAt){
    if (!product?.updatedAt) return false;
    const base = lastDownloadedAt || paidAt;
    if (!base) return false;
    const updated = toMs(product.updatedAt);
    const last = toMs(base);
    if (!updated || !last) return false;
    return updated > last;
}

function starsLabel(priceStars){
    const n = Number(priceStars || 0);
    return n <= 0 ? 'Бесплатно ✅' : `${n} ⭐ Stars`;
}

function rubLabel(priceRub){
    const n = Number(priceRub || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `${n} ₽`;
}

function usdtLabel(priceUsdt){
    const n = Number(priceUsdt || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `${n} USDT`;
}

function promoLabel(priceRub, priceRubOld){
    const now = Number(priceRub || 0);
    const old = Number(priceRubOld || 0);
    if (!Number.isFinite(now) || now <= 0) return '';
    if (Number.isFinite(old) && old > now) return `${now} ₽ (вместо ${old} ₽)`;
    return `${now} ₽`;
}

// Рисуем карточку города из твоих CSS-классов (.card, .pill, .badge, .btn...)
function renderCityCard(city, products, purchasedSet, purchaseMap){
    const cityProducts = products.filter(p => p.cityId === city.id && p.active !== false);
    const mini = cityProducts.find(p => p.type === 'mini');
    const full = cityProducts.find(p => p.type === 'full');
    const cid = safeId(city.id);
    const purchasedProducts = purchasedSet
        ? cityProducts.filter(p => purchasedSet.has(p.id))
        : [];
    const purchasedProduct = purchasedProducts
        .sort((a, b) => Number(b.priceStars || 0) - Number(a.priceStars || 0))[0];
    const hasPurchase = Boolean(purchasedProduct);
    const purchaseInfo = hasPurchase && purchaseMap ? purchaseMap.get(purchasedProduct.id) : null;
    const paidAt = purchaseInfo?.paidAt || null;
    const lastDownloadedAt = purchaseInfo?.lastDownloadedAt || null;
    const updateAvailable = hasPurchase
        ? hasUpdate(purchasedProduct, paidAt, lastDownloadedAt)
        : false;
    
    const hasRubPay = full && Number(full.priceRub || 0) > 0;
    const hasCryptoPay = full && Number(full.priceUsdt || 0) > 0;
    const rubText = hasRubPay ? promoLabel(full.priceRub, full.priceRubOld) : '';
    const rubUrl = full?.payUrl ? String(full.payUrl) : '';
    const useCardApi = Boolean(API_BASE) && isTg;
    const showCardLink = !useCardApi && rubUrl;

    return `
        <div class="card" id="city-${cid}" data-city="${esc(city.id)}">
            <div class="cardHeader">
                <div class="pill">
                    <a data-app="organic" href="${linkFor('organic')}" target="_blank" rel="noopener">Organic Maps</a> /
                    <a data-app="mapsme" href="${linkFor('mapsme')}" target="_blank" rel="noopener">MAPS.ME</a>
                </div>
                ${city.country ? `<div class="pill">${esc(city.country)}</div>` : ''}
            </div>
        
            <div class="title">${esc(city.name)}</div>
            <p class="lead">Готовый набор точек: еда, виды, прогулки, полезное.</p>
        
            <div class="row">
                ${hasPurchase ? '' : `
                    ${mini ? `
                        <div class="badge">
                            <div class="t">${esc(mini.title || 'Mini')}</div>
                            <div class="v">${esc(mini.subtitle || starsLabel(mini.priceStars))}</div>
                        </div>` : ''
                    }
                    
                    ${full ? `
                        <div class="badge">
                            <div class="t">${esc(full.title || 'Full')}</div>
                            <div class="v">${esc(full.subtitle || starsLabel(full.priceStars))}</div>
                        </div>` : ''
                    }
                `}
                
                <div class="badge">
                    <div class="t">Обновления</div>
                    <div class="v">Включены ♻️</div>
                </div>
            </div>
        
            <div class="actions">
                ${hasPurchase ? `
                    <button class="btn primary" data-action="GET_FILE" data-product="${esc(purchasedProduct.id)}">
                        ${updateAvailable ? '🟢 Обновление — скачать' : '⬇️ Скачать снова'}
                    </button>` : `
                    ${mini ? `
                        <button class="btn" data-action="GET_FILE" data-product="${esc(mini.id)}">
                            ✅ Забрать (${esc(mini.subtitle || starsLabel(mini.priceStars))})
                        </button>` : ''
                    }

                    ${full ? `
                        ${hasRubPay ? `
                            ${useCardApi ? `
                                <button class="btn primary" data-action="CARD" data-product="${esc(full.id)}">
                                    Оплатить картой ${esc(rubLabel(full.priceRub))}
                                    ${full.priceRubOld && Number(full.priceRubOld) > Number(full.priceRub || 0)
                                        ? ` <span class="price-old">${esc(rubLabel(full.priceRubOld))}</span>`
                                        : ''}
                                </button>` : `
                                ${showCardLink ? `
                                    <a class="btn primary" href="${esc(rubUrl)}" target="_blank" rel="noopener">
                                        Оплатить картой ${esc(rubLabel(full.priceRub))}
                                        ${full.priceRubOld && Number(full.priceRubOld) > Number(full.priceRub || 0)
                                            ? ` <span class="price-old">${esc(rubLabel(full.priceRubOld))}</span>`
                                            : ''}
                                    </a>` : `
                                    <button class="btn primary disabled" disabled>
                                        Оплатить картой ${esc(rubLabel(full.priceRub))}
                                        ${full.priceRubOld && Number(full.priceRubOld) > Number(full.priceRub || 0)
                                            ? ` <span class="price-old">${esc(rubLabel(full.priceRubOld))}</span>`
                                            : ''}
                                    </button>`
                                }
                            `}
                        ` : ''}
                        ${hasCryptoPay ? `
                            <button class="btn crypto" data-action="MANUAL_PAY" data-product="${esc(full.id)}">
                                Оплатить в USDT
                            </button>` : ''
                        }
                        <button class="btn ${hasRubPay ? '' : 'primary'}" data-action="BUY" data-product="${esc(full.id)}">
                            ⭐ Купить (${esc(full.subtitle || starsLabel(full.priceStars))})
                        </button>` : ''
                    }
                    
                    <button class="btn ghost" data-action="HOW_TO">
                        ❓ Как установить
                    </button>
                `}
            </div>
            ${!hasPurchase && full && (Number(full.priceStars || 0) > 0 || hasRubPay || hasCryptoPay) ? `
                <div class="consent">
                    Нажимая «Оплатить» или «Купить», вы принимаете условия
                    <a href="./offer.html" target="_blank" rel="noopener">оферты</a>
                    и правила возврата цифрового контента.
                </div>
            ` : ''}
        
            <div class="hint">
                <div class="icon">ℹ️</div>
                <div><b>Важно:</b> файл <b>.kmz</b> придёт сообщением от бота в этот чат.</div>
            </div>
        </div>
    `;
}

function renderCityLink(city){
    const id = safeId(city.id);
    const name = esc(city.name);
    const country = city.country ? esc(city.country) : '';
    return `
        <a class="cityItem" href="./index.html#city-${id}">
            <div class="cityName">${name}</div>
            ${country ? `<div class="cityMeta">${country}</div>` : ''}
        </a>
    `;
}

function renderHomeSkeleton(count = 2){
    return Array.from({ length: count }).map(() => `
        <div class="card skeleton-card" aria-hidden="true">
            <div class="skeleton-row">
                <div class="skeleton" style="height:22px;width:150px"></div>
                <div class="skeleton" style="height:22px;width:48px"></div>
            </div>
            <div class="skeleton" style="height:18px;width:160px;margin-top:12px"></div>
            <div class="skeleton" style="height:12px;width:240px;margin-top:8px"></div>
            <div class="skeleton-row" style="margin-top:12px">
                <div class="skeleton" style="height:52px;width:48%"></div>
                <div class="skeleton" style="height:52px;width:48%"></div>
            </div>
            <div class="skeleton" style="height:46px;width:100%;margin-top:12px"></div>
            <div class="skeleton" style="height:46px;width:100%;margin-top:8px"></div>
        </div>
    `).join('');
}

function renderCatalogSkeleton(count = 4){
    return Array.from({ length: count }).map(() => `
        <div class="cityItem skeleton-card" aria-hidden="true">
            <div class="skeleton" style="height:16px;width:160px"></div>
            <div class="skeleton" style="height:12px;width:40px"></div>
        </div>
    `).join('');
}

function showSkeleton(el, page){
    el.setAttribute('aria-busy', 'true');
    el.classList.add('loading');
    if (page === 'catalog') {
        el.classList.add('cityGrid');
        el.innerHTML = renderCatalogSkeleton(5);
    } else {
        el.innerHTML = renderHomeSkeleton(2);
    }
}

function hideSkeleton(el){
    el.removeAttribute('aria-busy');
    el.classList.remove('loading');
}

function setActiveCard(next){
    if (!next) return;
    const current = document.querySelector('.card.is-active');
    if (current === next) return;
    if (current) current.classList.remove('is-active');
    next.classList.add('is-active');

    const city = String(next.dataset?.city || '').trim();
    if (city) {
        void trackEvent('city_focus', {
            page: document.body?.dataset?.page || 'home',
            city
        });
    }
}

function setupActiveCardTracking(root){
    const cards = Array.from(root.querySelectorAll('.card'));
    if (!cards.length) return;

    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
            const visible = entries
                .filter((e) => e.isIntersecting)
                .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
            if (visible[0]) setActiveCard(visible[0].target);
        }, {
            root: null,
            rootMargin: '-40% 0px -40% 0px',
            threshold: [0.15, 0.35, 0.6]
        });

        cards.forEach((c) => observer.observe(c));
        setActiveCard(cards[0]);
        return;
    }

    const pickByCenter = () => {
        const y = window.innerHeight / 2;
        let best = null;
        let bestDist = Infinity;
        cards.forEach((c) => {
            const rect = c.getBoundingClientRect();
            const center = rect.top + rect.height / 2;
            const dist = Math.abs(center - y);
            if (dist < bestDist) {
                bestDist = dist;
                best = c;
            }
        });
        setActiveCard(best);
    };

    pickByCenter();
    window.addEventListener('scroll', () => requestAnimationFrame(pickByCenter), { passive: true });
    window.addEventListener('resize', pickByCenter);
}

function setupFloatingAction(){
    const fab = document.getElementById('fab-action');
    if (!fab) return;
    const threshold = 140;
    let ticking = false;

    const update = () => {
        const show = window.scrollY > threshold;
        fab.classList.toggle('is-visible', show);
        ticking = false;
    };

    update();
    window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
    }, { passive: true });
}

function bindButtons(root){
    root.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-action');
            const productId = btn.getAttribute('data-product') || undefined;
            const city = btn.closest('.card')?.dataset?.city || undefined;
            const actionToEvent = {
                GET_FILE: 'click_get_file',
                BUY: 'click_buy_stars',
                CARD: 'click_buy_card',
                MANUAL_PAY: 'click_buy_usdt',
                HOW_TO: 'click_how_to',
            };

            void trackEvent(actionToEvent[action] || 'click_action', {
                page: document.body?.dataset?.page || 'home',
                productId,
                city,
                payload: { action }
            });
            
            haptic('impact', action === 'BUY' ? 'medium' : 'light');
            send(action, productId);
        });
    });
}

function scrollToHash(){
    const raw = window.location.hash || '';
    if (!raw) return;
    const id = decodeURIComponent(raw.replace('#',''));
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    setTimeout(() => {
        el.classList.add('is-target');
        setTimeout(() => el.classList.remove('is-target'), 1600);
    }, 280);
}

async function init(){
    applyTelegramTheme();
    setStoreLinks(document);
    setupFloatingAction();
    setupInfoPanel();
    setupPendingAutoClose();
    const el = document.getElementById('catalog');
    const page = document.body?.dataset?.page || 'home';
    await ensureTrackingSession(page);
    setupSessionEndTracking(page);
    if (el) showSkeleton(el, page);
    try{
        const allowFetchEntitlements = page === 'home';
        const [data, entitlements] = await Promise.all([
            loadCatalog(),
            getEntitlements({ allowFetch: allowFetchEntitlements })
        ]);
        const cities = (data.cities || []).filter(c => c && c.active !== false);
        const products = (data.products || []).filter(p => p && p.active !== false);
        const purchasesDetailed = Array.isArray(entitlements?.purchasesDetailed)
            ? entitlements.purchasesDetailed
            : [];
        const purchasesList = Array.isArray(entitlements?.purchases)
            ? entitlements.purchases
            : purchasesDetailed.map(p => p.productId);
        const purchasedSet = purchasesList.length
            ? new Set(purchasesList.map(String))
            : null;
        const purchaseMap = purchasesDetailed.length
            ? new Map(purchasesDetailed.map(p => [
                String(p.productId),
                {
                    paidAt: p.paidAt || null,
                    lastDownloadedAt: p.lastDownloadedAt || null
                }
            ]))
            : null;
        
        if (!cities.length){
            hideSkeleton(el);
            el.innerHTML = `<div class="error">Нет активных городов в products.json</div>`;
            return;
        }

        if (page === 'catalog') {
            el.classList.add('cityGrid');
            hideSkeleton(el);
            el.innerHTML = cities.map(c => renderCityLink(c)).join('');
            return;
        }

        hideSkeleton(el);
        el.innerHTML = cities.map(c => renderCityCard(c, products, purchasedSet, purchaseMap)).join('');
        bindButtons(el);
        setupActiveCardTracking(el);
        scrollToHash();
    }catch(e){
        hideSkeleton(el);
        el.innerHTML = `<div class="error">Ошибка:\n${esc(e.message || e)}</div>`;
    }
}

init();
