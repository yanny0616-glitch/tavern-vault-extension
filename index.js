// TavernVault 酒馆藏馆 —— SillyTavern / TauriTavern 插件
// 作用：1) 全屏内嵌藏馆网页；2) 作为桥，替藏馆页面读写酒馆本地数据（角色卡、世界书、预设、正则、快速回复、主题、背景）

const EXT_KEY = 'tavernVault';
const VERSION = '1.1.0';
const DEFAULTS = { url: '', token: '', fab: true, fabPos: null };
const isTT = () => Boolean(window.__TAURITAVERN__);

const ctx = () => SillyTavern.getContext();

function settings() {
    const es = ctx().extensionSettings;
    es[EXT_KEY] ??= {};
    for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in es[EXT_KEY])) es[EXT_KEY][k] = v;
    return es[EXT_KEY];
}
const save = () => ctx().saveSettingsDebounced();
const baseUrl = () => String(settings().url || '').trim().replace(/\/+$/, '');

function toast(msg, kind = 'info') {
    const t = window.toastr;
    if (t && t[kind]) t[kind](msg, '酒馆藏馆');
    else console.log('[TavernVault]', msg);
}

function headers(json = true) {
    const c = ctx();
    let h;
    try { h = c.getRequestHeaders(json ? undefined : { omitContentType: true }); } catch { h = c.getRequestHeaders(); }
    h = { ...h };
    if (!json) delete h['Content-Type'];
    return h;
}

async function stPost(path, body) {
    const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res;
}

async function stUpload(path, file, extra = {}) {
    const fd = new FormData();
    fd.append('avatar', file);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const res = await fetch(path, { method: 'POST', headers: headers(false), body: fd });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
}

// ---------------- 酒馆数据访问 ----------------
let settingsCache = null;
async function stSettings(force = false) {
    if (!settingsCache || force) settingsCache = await (await stPost('/api/settings/get', {})).json();
    return settingsCache;
}

const PRESET_GROUPS = [
    { apiId: 'openai', label: '对话补全预设', names: 'openai_setting_names', values: 'openai_settings', json: true },
    { apiId: 'textgenerationwebui', label: '文本补全预设', names: 'textgenerationwebui_preset_names', values: 'textgenerationwebui_presets', json: true },
    { apiId: 'instruct', label: '指令模板', objects: 'instruct' },
    { apiId: 'context', label: '上下文模板', objects: 'context' },
    { apiId: 'sysprompt', label: '系统提示词', objects: 'sysprompt' },
];

function presetEntries(s) {
    const out = [];
    for (const g of PRESET_GROUPS) {
        if (g.objects) {
            for (const o of s[g.objects] || []) if (o?.name) out.push({ id: `${g.apiId}::${o.name}`, name: o.name, sub: g.label, apiId: g.apiId, data: o });
        } else {
            const names = s[g.names] || [];
            const values = s[g.values] || [];
            names.forEach((name, i) => {
                let data = values[i];
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
                if (data) out.push({ id: `${g.apiId}::${name}`, name, sub: g.label, apiId: g.apiId, data });
            });
        }
    }
    return out;
}

async function backgroundList() {
    const res = await stPost('/api/backgrounds/all', {});
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.images || data.backgrounds || [];
    return list.map((x) => (typeof x === 'string' ? x : x.filename || x.name)).filter(Boolean);
}

const jsonFile = (name, obj) => ({ filename: `${String(name).replace(/[\\/:*?"<>|]/g, '_')}.json`, data: new TextEncoder().encode(JSON.stringify(obj, null, 2)).buffer });

const handlers = {
    hello: async () => ({ host: isTT() ? 'TauriTavern' : 'SillyTavern', version: VERSION, features: ['raw', 'replace'] }),

    /** 返回酒馆里条目的原始内容（JSON），藏馆用它计算内容指纹，判断两边是否一致 */
    async raw({ kind, ids = [] }) {
        const c = ctx();
        const out = [];
        const pool = async (list, fn, n = 4) => {
            let i = 0;
            await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
                while (i < list.length) {
                    const id = list[i++];
                    try { const data = await fn(id); if (data) out.push({ id, data }); } catch { /* 单个失败不影响其它 */ }
                }
            }));
        };
        switch (kind) {
            case 'character':
                await pool(ids, async (id) => {
                    const ch = (c.characters || []).find((x) => x.avatar === id);
                    const parse = (x) => { if (x && typeof x.json_data === 'string') { try { return JSON.parse(x.json_data); } catch { /* ignore */ } } return x; };
                    if (ch && !ch.shallow) return parse(ch);
                    return parse(await (await stPost('/api/characters/get', { avatar_url: id })).json());
                });
                break;
            case 'worldbook':
                await pool(ids, async (id) => (await stPost('/api/worldinfo/get', { name: id })).json());
                break;
            case 'preset': {
                const all = presetEntries(await stSettings(true));
                for (const id of ids) { const p = all.find((x) => x.id === id); if (p) out.push({ id, data: p.data }); }
                break;
            }
            case 'regex':
                for (const id of ids) { const r = (c.extensionSettings?.regex || []).find((x) => x.id === id); if (r) out.push({ id, data: r }); }
                break;
            case 'quickreply': case 'theme': {
                const s = await stSettings(true);
                const list = kind === 'theme' ? s.themes || [] : s.quickReplyPresets || [];
                for (const id of ids) { const x = list.find((y) => y?.name === id); if (x) out.push({ id, data: x }); }
                break;
            }
            default:
                break;
        }
        return out;
    },

    async list({ kind }) {
        const c = ctx();
        switch (kind) {
            case 'character':
                return (c.characters || []).map((ch) => ({
                    id: ch.avatar,
                    name: ch.name,
                    sub: [ch.data?.creator || ch.creator, (ch.data?.tags || ch.tags || []).slice(0, 3).join(' ')].filter(Boolean).join(' · '),
                    thumb: true,
                }));
            case 'worldbook': {
                const s = await stSettings(true);
                return (s.world_names || []).map((n) => ({ id: n, name: n }));
            }
            case 'preset':
                return presetEntries(await stSettings(true)).map(({ id, name, sub }) => ({ id, name, sub }));
            case 'regex':
                return (c.extensionSettings?.regex || []).map((r) => ({ id: r.id, name: r.scriptName || '(未命名)', sub: r.disabled ? '已禁用' : '' }));
            case 'quickreply': {
                const s = await stSettings(true);
                return (s.quickReplyPresets || []).filter((q) => q?.name).map((q) => ({ id: q.name, name: q.name, sub: `${(q.qrList || []).length} 个按钮` }));
            }
            case 'theme': {
                const s = await stSettings(true);
                return (s.themes || []).filter((t) => t?.name).map((t) => ({ id: t.name, name: t.name }));
            }
            case 'background':
                return (await backgroundList()).map((f) => ({ id: f, name: f, thumb: true }));
            default:
                throw new Error(`不支持的类型：${kind}`);
        }
    },

    async thumb({ kind, id }) {
        const type = kind === 'background' ? 'bg' : 'avatar';
        const res = await fetch(`/thumbnail?type=${type}&file=${encodeURIComponent(id)}`, { headers: headers() });
        if (!res.ok) throw new Error('缩略图获取失败');
        return { mime: res.headers.get('content-type') || 'image/png', data: await res.arrayBuffer(), transfer: true };
    },

    async export({ kind, id }) {
        const c = ctx();
        switch (kind) {
            case 'character': {
                const ch = (c.characters || []).find((x) => x.avatar === id);
                const res = await stPost('/api/characters/export', { format: 'png', avatar_url: id });
                return { filename: `${ch?.name || id.replace(/\.png$/i, '')}.png`, data: await res.arrayBuffer(), transfer: true };
            }
            case 'worldbook': {
                const data = await (await stPost('/api/worldinfo/get', { name: id })).json();
                return { ...jsonFile(id, data), transfer: true };
            }
            case 'preset': {
                const p = presetEntries(await stSettings()).find((x) => x.id === id);
                if (!p) throw new Error('预设不存在');
                return { ...jsonFile(p.name, { ...p.data, name: p.data.name || p.name }), transfer: true };
            }
            case 'regex': {
                const r = (c.extensionSettings?.regex || []).find((x) => x.id === id);
                if (!r) throw new Error('正则不存在');
                return { ...jsonFile(r.scriptName || 'regex', r), transfer: true };
            }
            case 'quickreply': {
                const q = ((await stSettings()).quickReplyPresets || []).find((x) => x.name === id);
                if (!q) throw new Error('快速回复不存在');
                return { ...jsonFile(q.name, q), transfer: true };
            }
            case 'theme': {
                const t = ((await stSettings()).themes || []).find((x) => x.name === id);
                if (!t) throw new Error('主题不存在');
                return { ...jsonFile(t.name, t), transfer: true };
            }
            case 'background': {
                const res = await fetch(`/backgrounds/${encodeURIComponent(id)}`, { headers: headers() });
                if (!res.ok) throw new Error('背景读取失败');
                return { filename: id, data: await res.arrayBuffer(), transfer: true };
            }
            default:
                throw new Error(`不支持的类型：${kind}`);
        }
    },

    /**
     * 导入到酒馆
     * replace：要覆盖的酒馆条目 id（角色卡头像文件名、世界书名、预设 id、正则 id……）
     * asNew：和已有条目重名时另存一份（自动加编号）
     */
    async import({ kind, filename, name, apiId, data, replace = '', asNew = false }) {
        const c = ctx();
        const file = new File([data], filename || 'file');
        const parseJson = () => JSON.parse(new TextDecoder().decode(data).replace(/^\uFEFF/, ''));
        const clean = (n) => String(n || '').replace(/[\\/:*?"<>|]/g, '_');
        const unique = (n, taken) => {
            const set = new Set(taken);
            if (!set.has(n)) return n;
            let i = 2;
            while (set.has(`${n} (${i})`)) i++;
            return `${n} (${i})`;
        };
        switch (kind) {
            case 'character': {
                const ext = (filename.split('.').pop() || 'png').toLowerCase();
                await stUpload('/api/characters/import', file, replace ? { file_type: ext, preserved_name: replace } : { file_type: ext });
                try { await c.getCharacters?.(); } catch { /* ignore */ }
                return { message: replace ? '已覆盖酒馆里的角色卡（聊天记录保留）' : '已导入角色卡' };
            }
            case 'worldbook': {
                let n = clean(name || filename.replace(/\.json$/i, ''));
                if (replace) n = replace;
                else if (asNew) n = unique(n, (await stSettings(true)).world_names || []);
                await stUpload('/api/worldinfo/import', new File([data], `${n}.json`, { type: 'application/json' }));
                try { (await import('/scripts/world-info.js')).updateWorldInfoList?.(); } catch { /* ignore */ }
                settingsCache = null;
                return { message: `${replace ? '已覆盖' : '已导入'}世界书「${n}」` };
            }
            case 'preset': {
                const obj = parseJson();
                let id = apiId || 'openai';
                let n = obj.name || name || filename.replace(/\.json$/i, '');
                if (replace) [id, n] = [replace.split('::')[0], replace.split('::').slice(1).join('::')];
                else if (asNew) n = unique(n, presetEntries(await stSettings(true)).filter((p) => p.apiId === id).map((p) => p.name));
                if ('name' in obj) obj.name = n;
                await stPost('/api/presets/save', { apiId: id, name: n, preset: obj });
                settingsCache = null;
                return { message: `已${replace ? '覆盖' : '保存'}预设「${n}」，刷新酒馆后在预设列表中可见` };
            }
            case 'regex': {
                const obj = parseJson();
                const list = Array.isArray(obj) ? obj : [obj];
                c.extensionSettings.regex ??= [];
                const all = c.extensionSettings.regex;
                const newId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
                if (replace && list.length === 1) {
                    const idx = all.findIndex((x) => x.id === replace);
                    if (idx >= 0) {
                        all[idx] = { ...list[0], id: replace, disabled: all[idx].disabled };
                        save();
                        return { message: `已覆盖正则「${all[idx].scriptName}」，刷新后生效` };
                    }
                }
                let added = 0;
                for (const r of list) {
                    if (!asNew && all.some((x) => x.scriptName === r.scriptName && x.findRegex === r.findRegex)) continue;
                    const scriptName = asNew ? unique(r.scriptName || '正则', all.map((x) => x.scriptName)) : r.scriptName;
                    all.push({ ...r, scriptName, id: newId() });
                    added++;
                }
                save();
                return { message: `已添加 ${added} 条全局正则${added < list.length ? `（${list.length - added} 条已存在）` : ''}，刷新后在正则面板可见` };
            }
            case 'quickreply': case 'theme': {
                const obj = parseJson();
                obj.name ||= name;
                if (replace) obj.name = replace;
                else if (asNew) {
                    const s = await stSettings(true);
                    obj.name = unique(obj.name, (kind === 'theme' ? s.themes || [] : s.quickReplyPresets || []).map((x) => x?.name));
                }
                await stPost(kind === 'theme' ? '/api/themes/save' : '/api/quick-replies/save', obj);
                settingsCache = null;
                return { message: `已${replace ? '覆盖' : '保存'}${kind === 'theme' ? '主题' : '快速回复'}「${obj.name}」，刷新后可见` };
            }
            case 'background': {
                let fname = filename;
                if (replace) fname = replace;
                else if (asNew) {
                    const dot = filename.lastIndexOf('.');
                    const stem = dot > 0 ? filename.slice(0, dot) : filename;
                    const ext = dot > 0 ? filename.slice(dot) : '';
                    const taken = new Set(await backgroundList());
                    let i = 2;
                    while (taken.has(fname)) fname = `${stem} (${i++})${ext}`;
                }
                await stUpload('/api/backgrounds/upload', new File([data], fname));
                return { message: replace ? '已覆盖背景' : '已上传背景' };
            }
            default:
                throw new Error(`酒馆不支持直接导入该类型：${kind}`);
        }
    },
};

// ---------------- 面板 & 消息桥 ----------------
let panel;
let iframe;
let loadedSrc = '';

const SVG = (d, size = 18) => `<svg class="tv-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
    archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    wifiOff: '<path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 13a10 10 0 0 1 5.24-2.76"/><path d="m2 2 20 20"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};

function vaultOrigin() {
    try { return new URL(baseUrl()).origin; } catch { return ''; }
}

function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'tv-panel';
    panel.innerHTML = `
        <div class="tv-bar">
            <span class="tv-title">${SVG(IC.archive, 17)}<span>酒馆藏馆</span></span>
            <button type="button" data-act="reload" title="刷新">${SVG(IC.refresh)}</button>
            <button type="button" data-act="close" title="关闭">${SVG(IC.x)}</button>
        </div>
        <iframe allow="clipboard-write; clipboard-read; fullscreen" referrerpolicy="no-referrer"></iframe>
        <div class="tv-error"><div class="tv-error-ic">${SVG(IC.wifiOff, 40)}</div><div class="tv-error-msg"></div>
            <button type="button" class="menu_button" data-act="retry">重试</button></div>`;
    document.body.append(panel);
    iframe = panel.querySelector('iframe');
    panel.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') closePanel();
        if (act === 'reload') { loadedSrc = ''; openPanel(); }
        if (act === 'retry') openPanel();
    });
    if (isTT()) {
        import('/scripts/tauritavern/layout-kit.js')
            .then(async (kit) => { await kit.waitForHostReady?.(); kit.applySurface?.(panel, kit.SURFACE.FullscreenWindow); })
            .catch(() => { /* 旧版本没有 layout-kit */ });
    }
}

async function openPanel() {
    if (!baseUrl()) {
        toast('请先在扩展设置里填写藏馆服务器地址', 'warning');
        document.querySelector('#tv-settings .inline-drawer-toggle')?.click();
        return;
    }
    if (!panel) buildPanel();
    panel.classList.add('open');
    panel.classList.remove('error');
    try {
        const r = await fetch(`${baseUrl()}/api/health`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
        panel.classList.add('error');
        panel.querySelector('.tv-error-msg').innerHTML = `无法连接藏馆服务：${e.message}<br><small>请检查地址是否正确、服务是否在运行。iOS 版 TauriTavern 请使用 https 地址。</small>`;
        return;
    }
    const po = location.origin && location.origin !== 'null' ? location.origin : '*';
    const q = new URLSearchParams({ embed: 'tavern', po });
    if (settings().token) q.set('token', settings().token);
    const src = `${baseUrl()}/#/library?${q}`;
    if (loadedSrc !== src) {
        loadedSrc = src;
        iframe.src = src;
    }
}

function closePanel() {
    panel?.classList.remove('open');
}

window.addEventListener('message', async (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    if (e.origin !== vaultOrigin()) return;
    const m = e.data;
    if (!m || m.tv !== 1) return;
    if (m.kind === 'close') { closePanel(); return; }
    if (m.kind !== 'req') return;
    const reply = (payload, transfer = []) => iframe.contentWindow.postMessage({ tv: 1, kind: 'res', id: m.id, ...payload }, e.origin, transfer);
    try {
        const fn = handlers[m.method];
        if (!fn) throw new Error(`未知方法：${m.method}`);
        const result = await fn(m.params || {});
        const transfer = result?.transfer && result.data instanceof ArrayBuffer ? [result.data] : [];
        if (result?.transfer) delete result.transfer;
        reply({ ok: true, result }, transfer);
    } catch (err) {
        console.error('[TavernVault]', err);
        reply({ ok: false, error: err?.message || String(err) });
    }
});

// ---------------- 悬浮按钮 ----------------
function renderFab() {
    let fab = document.getElementById('tv-fab');
    if (!settings().fab) { fab?.remove(); return; }
    if (fab) return;
    fab = document.createElement('button');
    fab.id = 'tv-fab';
    fab.type = 'button';
    fab.title = '酒馆藏馆';
    fab.innerHTML = SVG(IC.archive, 24);
    const pos = settings().fabPos;
    if (pos) { fab.style.left = `${pos.x}px`; fab.style.top = `${pos.y}px`; fab.style.right = 'auto'; fab.style.bottom = 'auto'; }
    let start = null;
    let moved = false;
    fab.addEventListener('pointerdown', (e) => {
        start = { x: e.clientX, y: e.clientY, l: fab.offsetLeft, t: fab.offsetTop };
        moved = false;
        fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        const x = Math.max(4, Math.min(window.innerWidth - fab.offsetWidth - 4, start.l + dx));
        const y = Math.max(4, Math.min(window.innerHeight - fab.offsetHeight - 4, start.t + dy));
        Object.assign(fab.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    });
    fab.addEventListener('pointerup', () => {
        if (moved) { settings().fabPos = { x: fab.offsetLeft, y: fab.offsetTop }; save(); } else openPanel();
        start = null;
    });
    document.body.append(fab);
    if (isTT()) {
        import('/scripts/tauritavern/layout-kit.js').then((kit) => kit.applySurface?.(fab, kit.SURFACE.FreeWindow)).catch(() => {});
    }
}

// ---------------- 设置面板 ----------------
function buildSettings() {
    const s = settings();
    const html = `
    <div id="tv-settings" class="tv-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>TavernVault 酒馆藏馆</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="tv-row"><label>服务器</label><input id="tv-url" class="text_pole" type="text" placeholder="https://vault.example.com"></div>
          <div class="tv-row"><label>密码</label><input id="tv-pass" class="text_pole" type="password" placeholder="藏馆访问密码（未设置可留空）"></div>
          <div class="tv-row">
            <div id="tv-connect" class="menu_button">${SVG(IC.link, 15)} 连接</div>
            <div id="tv-open" class="menu_button">${SVG(IC.archive, 15)} 打开藏馆</div>
          </div>
          <div id="tv-status" class="tv-status"></div>
          <label class="checkbox_label"><input id="tv-fab-toggle" type="checkbox"> 显示悬浮按钮（可拖动）</label>
          <small style="opacity:.7">也可以从左下角「魔棒」扩展菜单里打开。密码只用于换取访问令牌，不会保存明文。</small>
        </div>
      </div>
    </div>`;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    host?.insertAdjacentHTML('beforeend', html);
    const $ = (id) => document.getElementById(id);
    $('tv-url').value = s.url;
    $('tv-fab-toggle').checked = s.fab;
    const status = (msg, kind = '') => { const el = $('tv-status'); el.textContent = msg; el.className = `tv-status ${kind}`; };
    status(s.url ? (s.token ? '已保存连接信息' : '已保存地址') : '尚未配置');
    $('tv-url').addEventListener('change', () => { s.url = $('tv-url').value.trim().replace(/\/+$/, ''); save(); loadedSrc = ''; });
    $('tv-fab-toggle').addEventListener('change', () => { s.fab = $('tv-fab-toggle').checked; save(); renderFab(); });
    $('tv-open').addEventListener('click', openPanel);
    $('tv-connect').addEventListener('click', async () => {
        s.url = $('tv-url').value.trim().replace(/\/+$/, '');
        save();
        if (!s.url) { status('请填写服务器地址', 'err'); return; }
        status('连接中…');
        try {
            const health = await (await fetch(`${s.url}/api/health`, { cache: 'no-store' })).json();
            if (health.app !== 'tavern-vault') throw new Error('这个地址不是藏馆服务');
            if (health.auth) {
                const pw = $('tv-pass').value;
                if (pw) {
                    const r = await fetch(`${s.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
                    const j = await r.json();
                    if (!r.ok) throw new Error(j.error || '登录失败');
                    s.token = j.token;
                } else if (!s.token) {
                    throw new Error('该藏馆设置了密码，请填写密码');
                }
                const check = await fetch(`${s.url}/api/state`, { headers: { Authorization: `Bearer ${s.token}` } });
                if (check.status === 401) { s.token = ''; throw new Error('令牌已失效，请重新输入密码'); }
            } else {
                s.token = '';
            }
            $('tv-pass').value = '';
            save();
            loadedSrc = '';
            status(`已连接：${health.title || '酒馆藏馆'} v${health.version}`, 'ok');
        } catch (e) {
            status(`连接失败：${e.message}`, 'err');
        }
    });
}

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('tv-menu-item')) return;
    const item = document.createElement('div');
    item.id = 'tv-menu-item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<span class="tv-menu-ic">${SVG(IC.archive, 16)}</span><span>酒馆藏馆</span>`;
    item.addEventListener('click', openPanel);
    menu.append(item);
}

// ---------------- 启动 ----------------
async function init() {
    if (window.__TAURITAVERN__?.ready) {
        try { await window.__TAURITAVERN__.ready; } catch { /* ignore */ }
    }
    settings();
    buildSettings();
    addMenuItem();
    renderFab();
    // 角色列表变化时，让藏馆页面知道（用于刷新酒馆页）
    const c = ctx();
    const notify = () => iframe?.contentWindow?.postMessage({ tv: 1, kind: 'event', event: 'tavern-changed' }, vaultOrigin() || '*');
    for (const ev of ['CHARACTER_EDITED', 'CHARACTER_DELETED', 'CHARACTER_PAGE_LOADED', 'WORLDINFO_UPDATED', 'SETTINGS_UPDATED']) {
        if (c.event_types?.[ev]) c.eventSource.on(c.event_types[ev], () => { settingsCache = null; notify(); });
    }
}

jQuery(() => { init().catch((e) => console.error('[TavernVault] init failed', e)); });
