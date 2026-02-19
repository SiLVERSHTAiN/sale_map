const tg = window.Telegram?.WebApp;
const isTg = !!tg;
const APP_CONFIG = window.APP_CONFIG || {};
const API_BASE = String(APP_CONFIG.API_BASE || "").replace(/\/$/, "");
const USDT_ADDRESS = String(APP_CONFIG.USDT_TRC20_ADDRESS || "").trim();
const USDT_NETWORK = String(APP_CONFIG.USDT_NETWORK || "TRC20").trim() || "TRC20";

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

function q(sel){ return document.querySelector(sel); }

async function loadCatalog(){
    const res = await fetch('./products.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('products.json не загрузился');
    return res.json();
}

function formatUsdt(value){
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return `${n} USDT`;
}

function setNote(message, ok = false){
    const note = q('#txid-note');
    if (!note) return;
    note.textContent = message;
    note.classList.remove('hidden');
    note.classList.toggle('success', ok);
}

function setQr(address){
    const img = q('#usdt-qr');
    if (!img) return;
    if (!address) {
        img.classList.add('hidden');
        return;
    }
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(address)}`;
    img.src = url;
}

function copyText(text){
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text);
        return true;
    }
    const input = q('#usdt-address');
    if (!input) return false;
    input.focus();
    input.select();
    try { return document.execCommand('copy'); } catch { return false; }
}

async function submitRequest(productId){
    const txid = String(q('#txid-input')?.value || '').trim();
    if (!txid) {
        setNote('Укажите TXID или ссылку на транзакцию.', false);
        return;
    }
    if (!API_BASE) {
        setNote('Сервис недоступен. Попробуйте позже.', false);
        return;
    }
    if (!isTg) {
        setNote('Откройте эту страницу внутри Telegram.', false);
        return;
    }
    const initData = await waitInitData();
    if (!initData) {
        setNote('Не удалось получить данные Telegram. Перезапустите витрину.', false);
        return;
    }
    try{
        const res = await fetch(`${API_BASE}/api/usdt/request`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ initData, productId, txid })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
            const details = typeof data?.error === 'string' ? data.error : 'Попробуйте позже.';
            setNote(`Не удалось отправить заявку. ${details}`, false);
            return;
        }
        setNote('Заявка отправлена. Мы проверим оплату и пришлём файл в чат.', true);
        const btn = q('#submit-usdt');
        if (btn) btn.disabled = true;
        const input = q('#txid-input');
        if (input) input.value = '';
        try { tg.HapticFeedback?.notificationOccurred('success'); } catch(e){}
    }catch(e){
        setNote('Не удалось отправить заявку. Попробуйте позже.', false);
    }
}

async function init(){
    applyTelegramTheme();
    q('#usdt-network').textContent = USDT_NETWORK || 'TRC20';
    q('#usdt-address').value = USDT_ADDRESS;
    setQr(USDT_ADDRESS);

    const params = new URLSearchParams(window.location.search);
    const productId = params.get('product');

    try{
        const data = await loadCatalog();
        const products = Array.isArray(data?.products) ? data.products : [];
        const cities = Array.isArray(data?.cities) ? data.cities : [];
        const product = products.find(p => p && p.id === productId) ||
            products.find(p => p && p.type === 'full' && Number(p.priceUsdt || 0) > 0) ||
            products.find(p => p && p.type === 'full');

        if (!product) {
            q('#usdt-product').textContent = 'Полная версия';
            q('#usdt-amount').textContent = '—';
        } else {
            const city = cities.find(c => c && c.id === product.cityId);
            const title = city ? `${city.name} — ${product.title || 'Полная версия'}` : (product.title || 'Полная версия');
            q('#usdt-product').textContent = title;
            q('#usdt-amount').textContent = formatUsdt(product.priceUsdt);
        }

        q('#submit-usdt').addEventListener('click', () => submitRequest(product?.id || productId || ''));
    }catch{
        q('#usdt-product').textContent = 'Полная версия';
    }

    q('#copy-address').addEventListener('click', () => {
        const ok = copyText(USDT_ADDRESS);
        setNote(ok ? 'Адрес скопирован.' : 'Не удалось скопировать адрес.', ok);
    });
}

init();
