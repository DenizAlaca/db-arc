import { ERView } from './er.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};
const fmt = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const PALETTE = ['#22d3ee', '#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#60a5fa', '#fb7185', '#a3e635', '#2dd4bf', '#c084fc', '#f97316', '#38bdf8', '#e879f9', '#facc15', '#4ade80', '#818cf8', '#fda4af', '#5eead4'];
const ROLE_TR = { core: 'çekirdek', entity: 'varlık', junction: 'ara tablo', lookup: 'sözlük', log: 'log', system: 'sistem', detail: 'detay', view: 'view' };

const state = { model: null, knowledge: null, events: [], selectedEvent: null, roleFilter: null };
const colors = new Map();
const er = new ERView($('#er'), $('#minimap'));
er.onSelect = (name) => showTable(name);
er.onBackground = () => clearHighlight();

const graphOpts = () => ({
  colors,
  showInferred: $('#showInferred').checked,
  showHubs: $('#showHubs').checked,
  hideSystem: $('#hideSystem').checked,
  expandAll: $('#expandAll').checked,
});

async function load() {
  const { model, knowledge, project } = await api('/api/model');
  state.model = model;
  state.knowledge = knowledge;
  document.title = `dbscope · ${project.split('/').pop()}`;
  renderSources();
  if (!model) {
    $('#empty').classList.remove('hidden');
    $('#empty').innerHTML = `<div><h2>Henüz analiz yok</h2><p>Yukarıdan bir veri kaynağı seçip <b>↻ Analiz</b>'e basın ya da<br><code>dbscope analyze --db &lt;bağlantı&gt;</code> çalıştırın.<br><br>Bağlanılamayan veri depoları için Claude <code>submit_schema</code> aracıyla şemayı gönderebilir.</p></div>`;
    return;
  }
  $('#empty').classList.add('hidden');
  model.modules.forEach((m, i) => colors.set(m.id, PALETTE[i % PALETTE.length]));
  er.setModel(model, graphOpts());
  state.events = await api('/api/events');
  renderHeader();
  renderOverview();
  renderTables();
  renderFeed();
  renderUsage();
}

function renderHeader() {
  const m = state.model;
  $('#dbname').textContent = `${m.dialect} · ${m.database}`;
  const e = economy();
  $('#kpis').innerHTML = [
    ['tablo', m.stats.tables], ['ilişki', m.stats.relations], ['çıkarımsal', m.stats.inferredRelations],
    ['tam şema tok', '≈' + fmt(m.fullSchemaTokens), 'accent'],
    ['ort. bağlam tok', e.matched ? '≈' + fmt(e.injected / e.matched) : '–', 'accent'],
    ['bağlam tasarrufu', e.baseline ? `%${Math.round((1 - e.injected / e.baseline) * 100)}` : '–', 'good'],
  ].map(([k, v, c]) => `<div class="kpi ${c ?? ''}"><b>${esc(v)}</b><span>${k}</span></div>`).join('');
}

async function renderSources() {
  const list = await api('/api/sources').catch(() => []);
  $('#sources').innerHTML = `<option value="">Kaynak: otomatik</option>` + list.map((s) => `<option value="${s.i}">${esc(s.label)} — ${esc(s.via)}</option>`).join('');
}

function economy() {
  const prompts = state.events.filter((e) => e.type === 'prompt');
  const matched = prompts.filter((e) => e.primary?.length);
  const injected = matched.reduce((a, e) => a + (e.injectedTokens ?? 0), 0);
  const baseline = matched.reduce((a, e) => a + (e.baselineTokens ?? e.injectedTokens ?? 0), 0);
  const reused = matched.reduce((a, e) => a + (e.reusedTables?.length ?? 0), 0);
  return { prompts: prompts.length, matched: matched.length, injected, baseline, reused, skipped: prompts.length - matched.length };
}

function renderOverview() {
  const m = state.model;
  $('#summary').innerHTML = esc(m.purpose.summary).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  $('#summaryTag').textContent = m.purpose.auto ? 'otomatik' : 'Claude / sen';
  $('#summaryEdit').value = state.knowledge?.projectSummary ?? '';
  $('#domains').innerHTML = m.purpose.domains.map((d) => `
    <div class="dom"><div class="dom-h"><span>${esc(d.name)}</span><span>${Math.round(d.confidence * 100)}%</span></div>
    <div class="bar"><i style="width:${Math.round(d.confidence * 100)}%"></i></div><small>${d.evidence.slice(0, 5).map(esc).join(' · ')}</small></div>`).join('');
  const e = economy();
  $('#economy').innerHTML = `
    <div><b>${e.prompts}</b><span>izlenen prompt</span></div>
    <div><b>${e.matched}</b><span>bağlam eklenen</span></div>
    <div><b>${fmt(e.injected)}</b><span>gönderilen token</span></div>
    <div><b>${fmt(e.baseline)}</b><span>kırpma/tekrar önleme olmadan</span></div>
    <div><b class="good">${e.baseline ? '%' + Math.round((1 - e.injected / e.baseline) * 100) : '–'}</b><span>bağlam tasarrufu</span></div>
    <div><b>${e.reused}</b><span>tekrar gönderilmeyen tablo</span></div>
    <div class="wide"><span>${e.skipped} prompt DB ile ilgisiz bulundu → hiç token eklenmedi. Gerçek oturum tüketimi için <b>Tüketim</b> sekmesi.</span></div>`;
  $('#modules').innerHTML = m.modules.map((mod) => `
    <li data-mod="${mod.id}"><span class="sw" style="background:${colors.get(mod.id)};color:${colors.get(mod.id)}"></span>
    <div>${esc(mod.label ?? mod.name)}${mod.description ? `<small>${esc(mod.description)}</small>` : ''}</div><span class="n">${mod.tables.length}</span></li>`).join('');
}

function renderTables() {
  const f = $('#tableSearch').value.toLowerCase();
  const roles = [...new Set(state.model.tables.map((t) => t.role))];
  $('#roleFilters').innerHTML = `<button data-role="" class="${!state.roleFilter ? 'on' : ''}">tümü</button>` + roles.map((r) => `<button data-role="${r}" class="${state.roleFilter === r ? 'on' : ''}">${ROLE_TR[r] ?? r}</button>`).join('');
  const rows = state.model.tables
    .filter((t) => !state.roleFilter || t.role === state.roleFilter)
    .filter((t) => !f || t.name.toLowerCase().includes(f) || (t.description ?? '').toLowerCase().includes(f) || (t.aliases ?? []).some((a) => a.toLowerCase().includes(f)))
    .sort((a, b) => b.importance - a.importance);
  $('#tableList').innerHTML = rows.map((t) => `<li data-table="${esc(t.name)}"><span class="sw" style="width:8px;height:8px;background:${colors.get(t.module)};color:${colors.get(t.module)}"></span>${esc(t.name)}${t.description || t.aliases?.length ? ' <span class="d" title="açıklama/takma ad var">●</span>' : ''}<span class="r">${ROLE_TR[t.role] ?? t.role} · ${fmt(t.rows)}</span></li>`).join('');
}

const SRC = { hook: 'Claude prompt', mcp: 'Claude araç', ui: 'Simülatör', cli: 'CLI' };
const newTablesOf = (e) => e.newTables ?? [...(e.primary ?? []).map((p) => ({ table: p.table, mode: 'full' })), ...(e.neighbors ?? []).map((n) => ({ table: n.table, mode: 'keys' }))];

function feedItem(e, isNew) {
  if (e.type === 'prompt') {
    const newT = newTablesOf(e);
    const base = e.baselineTokens ?? e.injectedTokens;
    const pct = base ? Math.max(0, Math.round((1 - e.injectedTokens / base) * 100)) : 0;
    return `<li data-ev="${e.id}" class="${isNew ? 'new' : ''}">
      <div class="meta"><span class="src ${e.source}">${SRC[e.source] ?? e.source}</span><span>${new Date(e.ts).toLocaleTimeString()}</span>${e.sessionId ? `<span title="oturum">#${esc(e.sessionId.slice(0, 6))}</span>` : ''}</div>
      <p class="p">${esc(e.prompt)}</p>
      ${e.primary?.length ? `<div class="chips">${newT.map((t) => `<span class="t ${t.mode}">${esc(t.table)}</span>`).join('')}${(e.reusedTables ?? []).map((t) => `<span class="t reused" title="bu oturumda zaten gönderildi">${esc(t)}</span>`).join('')}</div>
      <div class="tokbar"><div class="tb"><i style="width:${base ? Math.max(2, (e.injectedTokens / base) * 100) : 0}%"></i></div>
      <div class="tl"><span>${e.injectedTokens} / ${base} tok</span><b>%${pct} tasarruf</b></div></div>` : '<span class="ev">DB ile ilgisi bulunamadı — bağlam eklenmedi (0 token)</span>'}
    </li>`;
  }
  const label = {
    analyze: `Şema analiz edildi: <b>${e.stats?.tables}</b> tablo, <b>${e.stats?.relations}</b> ilişki`,
    tool: `Claude aracı: <b>${esc(e.tool)}</b>${e.query ? ` "${esc(e.query)}"` : ''}`,
    annotate: `Tablo açıklandı: <b>${esc(e.table)}</b> (${esc(e.by)})`,
    summary: `Proje özeti güncellendi (${esc(e.by)})`,
    learn: `Öğrenildi: "${esc(e.prompt)}"`,
    bench: `Benchmark: ${e.tasks} görev · input ${fmt(e.total?.without?.input)} → ${fmt(e.total?.with?.input)}`,
  }[e.type] ?? esc(e.type);
  return `<li data-ev="${e.id}" class="${isNew ? 'new' : ''}"><div class="meta"><span class="src">${esc(e.type)}</span><span>${new Date(e.ts).toLocaleTimeString()}</span></div>
    <div class="ev">${label}</div>${e.tables?.length ? `<div class="chips" style="margin-top:6px">${e.tables.map((t) => `<span class="t plain">${esc(t)}</span>`).join('')}</div>` : ''}</li>`;
}

function renderFeed() {
  $('#feed').innerHTML = [...state.events].reverse().slice(0, 200).map((e) => feedItem(e)).join('');
  $('#promptCount').textContent = state.events.filter((e) => e.type === 'prompt').length;
}

function highlightEvent(e) {
  state.selectedEvent = e;
  er.insetRight = e.type === 'prompt' && e.primary?.length ? 260 : 0;
  document.querySelectorAll('#feed li').forEach((li) => li.classList.toggle('sel', li.dataset.ev === e.id));
  if (e.type === 'prompt') {
    const newT = newTablesOf(e);
    er.highlight({ primary: newT.filter((t) => t.mode === 'full').map((t) => t.table), neighbor: newT.filter((t) => t.mode === 'keys').map((t) => t.table), reused: e.reusedTables ?? [] });
    showHud(e);
  } else if (e.tables) er.highlight({ primary: e.tables });
}

function showHud(e) {
  if (!e.primary?.length) { $('#hud').classList.add('hidden'); er.insetRight = 0; return; }
  const base = e.baselineTokens ?? e.injectedTokens;
  $('#hud').classList.remove('hidden');
  $('#hud').innerHTML = `<h4>Prompt bağlamı</h4><div class="q">${esc(e.prompt)}</div>
    <div class="kv"><span>gönderilen</span><b>${e.injectedTokens} tok</b></div>
    <div class="kv"><span>naif bağlam</span><b>${base} tok</b></div>
    <div class="kv"><span>tam şema</span><b>${e.fullSchemaTokens} tok</b></div>
    <div class="kv"><span>tasarruf</span><b class="good">%${base ? Math.max(0, Math.round((1 - e.injectedTokens / base) * 100)) : 0}</b></div>
    <div class="kv"><span>yeni / bağlamda</span><b>${newTablesOf(e).length} / ${(e.reusedTables ?? []).length}</b></div>`;
}

function clearHighlight() {
  state.selectedEvent = null;
  document.querySelectorAll('#feed li.sel').forEach((li) => li.classList.remove('sel'));
  er.clearHighlight();
  er.select(null);
  $('#hud').classList.add('hidden');
  er.insetRight = 0;
}

async function renderUsage() {
  const u = await api('/api/usage').catch(() => null);
  if (!u?.sessions?.length) {
    $('#usageSummary').innerHTML = `<span class="hint" style="grid-column:1/-1">Bu proje için henüz Claude Code oturum kaydı yok.</span>`;
    $('#sessions').innerHTML = '';
    return;
  }
  const w = u.summary.with, wo = u.summary.without;
  const cell = (v) => (v == null ? '–' : fmt(v));
  $('#usageSummary').innerHTML = `
    <span></span><span class="h w">dbscope ile</span><span class="h">dbscope'suz</span>
    <span class="h">oturum</span><span class="w">${w.sessions}</span><span>${wo.sessions}</span>
    <span class="h">input / prompt</span><span class="w">${cell(w.perPromptInput)}</span><span>${cell(wo.perPromptInput)}</span>
    <span class="h">output / prompt</span><span class="w">${cell(w.perPromptOutput)}</span><span>${cell(wo.perPromptOutput)}</span>
    <span class="h">tur / prompt</span><span class="w">${w.perPromptTurns ?? '–'}</span><span>${wo.perPromptTurns ?? '–'}</span>
    <span class="h">read+grep / prompt</span><span class="w">${w.perPromptExplore ?? '–'}</span><span>${wo.perPromptExplore ?? '–'}</span>`;
  $('#sessions').innerHTML = u.sessions.slice(0, 30).map((s) => `<li>
    <div class="sh"><span class="${s.dbscope ? 'on' : ''}">${s.dbscope ? '◆ dbscope' : '· dbscope yok'}</span><span>${esc((s.first ?? '').replace('T', ' ').slice(0, 16))}</span></div>
    <div class="nums"><span>prompt <b>${s.prompts}</b></span><span>tur <b>${s.turns}</b></span><span>in <b>${fmt(s.totalIn)}</b></span><span>out <b>${fmt(s.usage.output)}</b></span><span>read/grep <b>${s.explore}</b></span>${s.dbTools ? `<span>dbscope araç <b>${s.dbTools}</b></span>` : ''}</div></li>`).join('');
}

async function showTable(name) {
  const t = state.model.tables.find((x) => x.name === name);
  if (!t) return;
  const refs = new Map(t.refs.map((r) => [r.column, r]));
  const mod = state.model.modules.find((m) => m.id === t.module);
  $('#drawer').classList.remove('hidden');
  const refBy = [...new Map(t.referencedBy.map((r) => [r.table + r.column, r])).values()];
  $('#drawerBody').innerHTML = `
    <h2>${esc(t.name)}</h2>
    <div class="sub"><span style="color:${colors.get(t.module)}">■ ${esc(mod?.label ?? mod?.name)}</span><span>${ROLE_TR[t.role] ?? t.role}</span><span>${fmt(t.rows)} satır</span><span>${t.columns.length} kolon</span><span>önem ${t.importance}</span></div>
    <h4>Bu tablo ne işe yarar? <span class="flow-to-claude">↳ Claude'a gider + eşleştirmede kullanılır</span></h4>
    <textarea id="descEdit" rows="3" placeholder="örn: Siparişlerin satır kalemleri; her satır bir ürün ve adet içerir">${esc(t.description ?? '')}</textarea>
    <h4>Takma adlar <span class="flow-to-claude">↳ prompt'ta geçince bu tablo seçilir</span></h4>
    <input id="aliasEdit" placeholder="virgülle: sipariş kalemi, sepet satırı, line item" value="${esc((t.aliases ?? []).join(', '))}">
    <div class="row"><button id="saveAnn" class="btn primary">Kaydet</button><span id="annState" class="saved"></span></div>
    <h4>Kolonlar</h4>
    <table class="cols">${t.columns.map((c) => {
      const r = refs.get(c.name);
      const vals = t.samples?.[c.name];
      return `<tr><td class="${c.pk ? 'k' : r ? 'fk' : ''}">${c.pk ? '<span class="badge pk">PK</span>' : r ? '<span class="badge fk">FK</span>' : ''}${esc(c.name)}</td><td class="ty">${esc(c.type)}${c.nullable === false ? ' ·nn' : ''}</td>
        <td>${r ? `<a data-goto="${esc(r.table)}">${esc(r.table)}</a>${r.inferred ? ' <span class="ty" title="isimlendirmeden çıkarıldı">?</span>' : ''}` : ''}${vals ? `<div class="vals">{${vals.slice(0, 8).map(esc).join(', ')}}</div>` : ''}</td></tr>`;
    }).join('')}</table>
    <h4>Referans verenler (${refBy.length})</h4>
    <ul class="rels">${refBy.map((r) => `<li><a data-goto="${esc(r.table)}">${esc(r.table)}</a>.${esc(r.column)}</li>`).join('') || '<li class="ty">—</li>'}</ul>
    <h4>Claude'a giden hali <span class="flow-to-claude" id="ctxTok"></span></h4>
    <div class="ctx" id="tblCtx">…</div>`;
  api(`/api/format?table=${encodeURIComponent(t.name)}`).then((f) => {
    $('#tblCtx').textContent = `${f.full}\n\n— komşu olarak (sadece anahtarlar):\n${f.keys}`;
    $('#ctxTok').textContent = `≈${f.fullTokens} tok · anahtarlar ≈${f.keysTokens} tok`;
  });
  $('#saveAnn').onclick = async () => {
    await api('/api/annotate', { table: t.name, description: $('#descEdit').value.trim(), aliases: $('#aliasEdit').value.split(',').map((s) => s.trim()).filter(Boolean) });
    const { model, knowledge } = await api('/api/model');
    state.model = model;
    state.knowledge = knowledge;
    renderTables();
    await showTable(t.name);
    $('#annState').textContent = '✓ kaydedildi — sonraki prompt\'larda kullanılacak';
  };
  $('#drawerBody').querySelectorAll('[data-goto]').forEach((a) => (a.onclick = () => { er.focus(a.dataset.goto); showTable(a.dataset.goto); }));
  er.select(t.name);
}

document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'usage') renderUsage();
}));
$('#feed').onclick = (e) => { const li = e.target.closest('li[data-ev]'); if (!li) return; const ev = state.events.find((x) => x.id === li.dataset.ev); if (ev) highlightEvent(ev); };
$('#modules').onclick = (e) => { const li = e.target.closest('li[data-mod]'); if (!li) return; er.highlight({ primary: state.model.modules.find((m) => m.id === li.dataset.mod).tables }); };
$('#tableList').onclick = (e) => { const li = e.target.closest('li[data-table]'); if (!li) return; const t = state.model.tables.find((x) => x.name === li.dataset.table); er.highlight({ primary: [t.name], neighbor: t.neighbors }); showTable(t.name); };
$('#roleFilters').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.roleFilter = b.dataset.role || null; renderTables(); };
$('#tableSearch').oninput = renderTables;
$('#closeDrawer').onclick = () => { $('#drawer').classList.add('hidden'); er.select(null); };
$('#fit').onclick = () => er.fit();
$('#zoomIn').onclick = () => er.zoomBy(1.3);
$('#zoomOut').onclick = () => er.zoomBy(1 / 1.3);
$('#clearHl').onclick = clearHighlight;
for (const id of ['showInferred', 'showHubs', 'hideSystem', 'expandAll']) $('#' + id).onchange = () => er.setOptions(graphOpts());
$('#spot').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase();
  const hits = state.model.tables.filter((t) => t.name.toLowerCase().includes(q) || (t.aliases ?? []).some((a) => a.toLowerCase().includes(q)));
  if (!hits.length) return;
  er.highlight({ primary: hits.map((t) => t.name) });
  if (hits.length === 1) showTable(hits[0].name);
};
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#spot').focus(); }
  if (e.key === 'Escape') clearHighlight();
});
$('#saveSummary').onclick = async () => { await api('/api/summary', { summary: $('#summaryEdit').value.trim() }); await load(); };
$('#tryBtn').onclick = async () => {
  const prompt = $('#tryPrompt').value.trim();
  if (!prompt) return;
  const r = await api('/api/match', { prompt });
  $('#drawer').classList.remove('hidden');
  $('#drawerBody').innerHTML = `<h2>Prompt bağlamı</h2><div class="sub"><span>${r.tokens} token gönderilir</span><span>naif ${r.baselineTokens ?? '–'}</span><span>tam şema ${state.model.fullSchemaTokens}</span></div>
    <h4>Claude'a eklenecek blok</h4><div class="ctx">${esc(r.text || '(DB ile ilgisi bulunamadı — hiçbir şey eklenmez)')}</div>
    ${r.match?.primary.length ? `<h4>Eşleşme nedenleri</h4><table class="cols">${r.match.primary.map((p) => `<tr><td>${esc(p.table)}</td><td class="ty">${p.score}</td><td class="ty">${esc(p.why.join(', '))}</td></tr>`).join('')}</table>
    <h4>Doğru tablolar bunlar mı?</h4><p class="hint">Onaylarsan bu kelimeler → bu tablolar eşleşmesi öğrenilir.</p><button id="learnBtn" class="btn primary">✓ Onayla ve öğret</button>` : ''}`;
  $('#learnBtn')?.addEventListener('click', async () => { await api('/api/learn', { prompt, tables: r.match.primary.map((p) => p.table) }); $('#learnBtn').textContent = 'Öğrenildi ✓'; });
};
$('#tryPrompt').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#tryBtn').click(); };
$('#reanalyze').onclick = async () => {
  const b = $('#reanalyze');
  b.disabled = true;
  b.textContent = 'Analiz ediliyor…';
  try {
    const v = $('#sources').value;
    await api('/api/analyze', v === '' ? {} : { sourceIndex: +v });
    await load();
  } catch (e) { alert('Analiz başarısız: ' + e.message); }
  finally { b.disabled = false; b.textContent = '↻ Analiz'; }
};

function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => $('#live').classList.add('on');
  es.onerror = () => $('#live').classList.remove('on');
  es.addEventListener('event', (msg) => {
    const e = JSON.parse(msg.data);
    if (state.events.some((x) => x.id === e.id)) return;
    state.events.push(e);
    $('#feed').insertAdjacentHTML('afterbegin', feedItem(e, true));
    $('#promptCount').textContent = state.events.filter((x) => x.type === 'prompt').length;
    renderHeader();
    renderOverview();
    if (e.type === 'prompt' && e.primary?.length) highlightEvent(e);
  });
  let t;
  es.addEventListener('model', () => { clearTimeout(t); t = setTimeout(load, 400); });
}

load().then(() => {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  if (q) { document.querySelector('[data-tab="live"]').click(); $('#tryPrompt').value = q; $('#tryBtn').click(); }
  if (params.has('last')) {
    const last = [...state.events].reverse().find((e) => e.type === 'prompt' && e.primary?.length);
    if (last) { document.querySelector('[data-tab="live"]').click(); highlightEvent(last); }
  }
  if (params.has('table')) showTable(params.get('table'));
  if (!params.has('nostream')) connect();
});
