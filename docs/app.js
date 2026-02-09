const tg = window.Telegram?.WebApp;
const isTg = !!tg;
const APP_CONFIG = window.APP_CONFIG || {};
const API_BASE = String(APP_CONFIG.API_BASE || "").replace(/\/$/, "");
const ENTITLEMENTS_KEY = 'entitlements.v2';
const ENTITLEMENTS_TTL = 10 * 60 * 1000;

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

async function getEntitlements({ allowFetch = true } = {}){
    const cached = readEntitlementsCache();
    if (cached) return cached;
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

// ВАЖНО: теперь send принимает (action, productId)
async function send(action, productId){
    const payload = JSON.stringify({ action, productId });
    if (!isTg){
        alert('Открой mini-приложение внутри Telegram.\n\n' + payload);
        return;
    }
    const initData = await waitInitData(1200);
    if (action === 'CRYPTO'){
        if (!API_BASE || !initData) {
            alert('Оплата криптовалютой доступна только внутри Telegram.');
            return;
        }
        try{
            const res = await fetch(`${API_BASE}/api/crypto/invoice`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ initData, productId })
            });
            const data = await res.json();
            if (!res.ok || !data?.ok || !data?.payUrl) {
                alert('Не удалось создать счёт. Попробуйте позже.');
                return;
            }
            try { sessionStorage.removeItem(ENTITLEMENTS_KEY); } catch(e){}
            if (tg?.openLink) {
                tg.openLink(data.payUrl);
            } else {
                window.location.href = data.payUrl;
            }
        }catch(e){
            alert('Не удалось создать счёт. Попробуйте позже.');
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
                            ${rubUrl ? `
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
                        ` : ''}
                        ${hasCryptoPay ? `
                            <button class="btn" data-action="CRYPTO" data-product="${esc(full.id)}">
                                Оплатить криптой ${esc(usdtLabel(full.priceUsdt))}
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
    const el = document.getElementById('catalog');
    const page = document.body?.dataset?.page || 'home';
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
