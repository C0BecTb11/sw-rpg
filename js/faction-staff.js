// Штаб фракции: приказ дня, цели на карте галактики, должности и хозяйство.
//
// Должности заводит лидер (и те, кому он дал полномочие «Должности»):
// своё название и набор полномочий. Кто чем владеет, решает сервер —
// faction_power() в базе. Клиент только прячет кнопки, которые всё равно
// не сработают, и объясняет почему.
//
// Всё открывается шторкой поверх окна фракции (#hq-sheet), чтобы не
// терять сводку под ней. Данные штаба грузятся вместе со сводкой
// (hqFetch из faction-panel.js) и рисуются разделом «Штаб» в её теле.

var HQ_POWERS = [
  { id: 'manage_roles',       name: 'Должности',   text: 'заводит должности и назначает на них' },
  { id: 'planet_requests',    name: 'Заявки',      text: 'рассматривает заявки игроков на планеты' },
  { id: 'planet_controllers', name: 'Управляющие', text: 'назначает и снимает управляющих планет' },
  { id: 'orders',             name: 'Приказы',     text: 'приказ дня и цели на карте галактики' },
  { id: 'economy',            name: 'Хозяйство',   text: 'склады, добыча и постройки всех планет' }
];

var HQ_KINDS = {
  attack: { label: 'Наступать', icon: '⚔', hint: 'чужая планета — общий удар' },
  defend: { label: 'Оборонять', icon: '⛨', hint: 'своя планета — держать любой ценой' },
  gather: { label: 'Сбор сил',  icon: '⚑', hint: 'точка сбора флотов и войск' },
  supply: { label: 'Снабжать',  icon: '⇄', hint: 'своя планета — везти ресурсы' }
};
var HQ_KIND_ORDER = ['attack', 'defend', 'gather', 'supply'];

var hqState = {
  orders: null,
  staff: null,
  powers: [],
  mode: null,       // что открыто в шторке
  busy: false,
  editRole: null,   // id должности в правке, 'new' — новая
  systems: null,    // список планет для выбора цели
  ecoOpen: {}       // раскрытые карточки хозяйства
};

// ── Мелочи ─────────────────────────────────────────────────────────

function hqEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hqHas(p) { return hqState.powers.indexOf(p) >= 0; }

function hqIsLeader() { return !!(hqState.staff && hqState.staff.is_leader); }

function hqSubset(a, b) {
  for (var i = 0; i < (a || []).length; i++) if ((b || []).indexOf(a[i]) < 0) return false;
  return true;
}

function hqPowerName(id) {
  for (var i = 0; i < HQ_POWERS.length; i++) if (HQ_POWERS[i].id === id) return HQ_POWERS[i].name;
  return id;
}

function hqAgo(iso) {
  if (typeof fsAgo === 'function') return fsAgo(iso) || '';
  return '';
}

// Своя всплывашка: #pr-toast живёт внутри шторки заявок и при закрытой
// шторке не виден — сообщения штаба пропадали бы молча
function hqToast(text, bad) {
  var t = document.getElementById('hq-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'hq-toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(hqToast.timer);
  hqToast.timer = setTimeout(function() { t.className = ''; }, 3600);
}

function hqNum(n) {
  return typeof fsNum === 'function' ? fsNum(n) : String(Math.round(Number(n) || 0));
}

// ── Загрузка ───────────────────────────────────────────────────────

function hqFetch() {
  if (typeof supabase === 'undefined') return Promise.resolve(hqState);
  return Promise.all([
    supabase.rpc('get_faction_orders'),
    supabase.rpc('get_faction_staff')
  ]).then(function(r) {
    if (!r[0].error) hqState.orders = r[0].data || null;
    if (!r[1].error) {
      hqState.staff = r[1].data || null;
      hqState.powers = (r[1].data && r[1].data.powers) || [];
    }
    return hqState;
  }, function() { return hqState; });
}

// После правки: свежие данные, сводка фракции и метки на карте
function hqAfterChange() {
  return hqFetch().then(function() {
    if (typeof fsRender === 'function' && typeof fsState !== 'undefined' && fsState.open && fsState.data) {
      fsRender(false);
      if (typeof fsPaintActions === 'function') fsPaintActions();
    }
    if (typeof loadFactionTargets === 'function') loadFactionTargets();
    if (hqState.mode) hqRenderSheet();
  });
}

// ── Раздел «Штаб» в окне фракции ───────────────────────────────────

function fsRenderHQ() {
  var o = hqState.orders;
  var st = hqState.staff;
  if (!o && !st) return '';

  var canEdit = !!(o && o.can_edit);
  var targets = (o && o.targets) || [];
  var dir = o && o.directive;
  var roles = (st && st.roles) || [];

  var html = '<section class="fs-sec fs-hq">' +
    fsSecHead('Штаб', targets.length
      ? '<b class="hot">' + targets.length + ' ' + fsPlural(targets.length, 'цель', 'цели', 'целей') + '</b>'
      : 'приказы и должности');

  // Приказ дня — главное, что должен увидеть каждый, кто открыл фракцию
  if (dir) {
    html += '<div class="hq-dir">' +
      '<div class="hq-dir-label"><i>✦</i>Приказ дня</div>' +
      '<div class="hq-dir-text">' + hqEsc(dir.text) + '</div>' +
      '<div class="hq-dir-foot"><span>' + (dir.by ? hqEsc(dir.by) : 'штаб') +
        (dir.at ? ' · ' + hqEsc(hqAgo(dir.at)) : '') + '</span>' +
        (canEdit ? '<button type="button" class="hq-link" data-act="hq-dir">изменить</button>' : '') +
      '</div>' +
    '</div>';
  } else if (canEdit) {
    html += '<button type="button" class="hq-dir hq-dir-empty" data-act="hq-dir">' +
      '<span class="hq-dir-label"><i>✦</i>Приказ дня</span>' +
      '<span class="hq-dir-text">Отдать приказ — его увидит вся фракция</span></button>';
  }

  targets.forEach(function(t) {
    var k = HQ_KINDS[t.kind] || HQ_KINDS.gather;
    html += '<button type="button" class="fs-row hq-target k-' + hqEsc(t.kind) + '" data-sys="' +
        hqEsc(t.system_id) + '" data-info="1">' +
      '<span class="fs-row-ico hq-ico k-' + hqEsc(t.kind) + '">' + k.icon + '</span>' +
      '<span class="fs-row-body"><b>' + hqEsc(t.name) + '</b>' +
        '<i>' + k.label + (t.note ? ' · <em>' + hqEsc(t.note) + '</em>' : '') + '</i></span>' +
      '<span class="fs-chev">›</span></button>';
  });

  if (canEdit) {
    html += '<button type="button" class="fs-more hq-more" data-act="hq-targets">' +
      (targets.length ? 'Цели на карте · изменить' : '+ Поставить цель на карте') + '</button>';
  } else if (!dir && !targets.length) {
    html += '<div class="fs-empty">Штаб пока молчит: приказа дня и целей нет.</div>';
  }

  // Кто за что отвечает — коротко, полный состав в шторке «Должности»
  if (roles.length) {
    html += '<div class="hq-roles-strip">';
    roles.forEach(function(r) {
      var who = (r.members || []).map(function(m) { return hqEsc(m.nickname); }).join(', ');
      html += '<div class="hq-role-line"><b>' + hqEsc(r.name) + '</b><span>' +
        (who || '<em>вакансия</em>') + '</span></div>';
    });
    html += '</div>';
  }

  return html + '</section>';
}

// ── Шторка ─────────────────────────────────────────────────────────

function hqEnsureSheet() {
  var el = document.getElementById('hq-sheet');
  if (el) return el;

  el = document.createElement('div');
  el.id = 'hq-sheet';
  el.style.display = 'none';
  el.innerHTML =
    '<div id="hq-box">' +
      '<div id="hq-head">' +
        '<div><div id="hq-title"></div><div id="hq-sub"></div></div>' +
        '<button type="button" id="hq-close" aria-label="Закрыть">✕</button>' +
      '</div>' +
      '<div id="hq-body"></div>' +
      '<div id="hq-foot"></div>' +
    '</div>';
  document.body.appendChild(el);

  el.addEventListener('click', function(e) { if (e.target === el) hqClose(); });
  document.getElementById('hq-close').addEventListener('click', hqClose);
  document.getElementById('hq-body').addEventListener('click', hqOnClick);
  document.getElementById('hq-foot').addEventListener('click', hqOnClick);
  return el;
}

function hqOpen(mode) {
  var el = hqEnsureSheet();
  hqState.mode = mode;
  hqState.editRole = null;
  var box = document.getElementById('hq-box');
  box.classList.remove('fs-republic', 'fs-cis');
  var fac = hqState.staff && hqState.staff.faction;
  if (fac === 'republic' || fac === 'cis') box.classList.add('fs-' + fac);
  box.setAttribute('data-mode', mode);

  el.style.display = 'flex';
  document.getElementById('hq-body').innerHTML = '<div class="hq-empty">Загрузка…</div>';
  document.getElementById('hq-foot').innerHTML = '';

  var loads = [hqFetch()];
  if (mode === 'targets' && !hqState.systems) loads.push(hqLoadSystems());
  if (mode === 'economy') loads.push(hqLoadEconomy());
  Promise.all(loads).then(function() { if (hqState.mode === mode) hqRenderSheet(); });
}

function hqClose() {
  var el = document.getElementById('hq-sheet');
  if (el) el.style.display = 'none';
  hqState.mode = null;
  hqState.editRole = null;
}

function hqSetHead(title, sub) {
  document.getElementById('hq-title').textContent = title;
  document.getElementById('hq-sub').textContent = sub || '';
}

function hqRenderSheet() {
  var m = hqState.mode;
  if (m === 'directive') hqRenderDirective();
  else if (m === 'targets') hqRenderTargets();
  else if (m === 'roles') hqRenderRoles();
  else if (m === 'economy') hqRenderEconomy();
}

// Все кнопки шторки идут через один обработчик по data-hq
function hqOnClick(e) {
  var t = e.target;
  while (t && t !== this && !(t.getAttribute && t.getAttribute('data-hq'))) t = t.parentNode;
  if (!t || t === this || t.disabled) return;
  var act = t.getAttribute('data-hq');
  var id = t.getAttribute('data-id');

  if (act === 'dir-save') hqSaveDirective(false);
  else if (act === 'dir-clear') hqSaveDirective(true);
  else if (act === 'kind') hqPickKind(t.getAttribute('data-kind'));
  else if (act === 'target-set') hqSaveTarget();
  else if (act === 'target-clear') hqClearTarget(id, t);
  else if (act === 'role-new') { hqState.editRole = 'new'; hqRenderRoles(); }
  else if (act === 'role-edit') { hqState.editRole = id; hqRenderRoles(); }
  else if (act === 'role-cancel') { hqState.editRole = null; hqRenderRoles(); }
  else if (act === 'role-save') hqSaveRole(id);
  else if (act === 'role-archive') hqArchiveRole(id);
  else if (act === 'assign') hqAssign(id, t);
  else if (act === 'unassign') hqUnassign(t.getAttribute('data-user'), t);
  else if (act === 'eco-toggle') { hqState.ecoOpen[id] = !hqState.ecoOpen[id]; hqRenderEconomy(); }
  else if (act === 'go') {
    hqClose();
    if (typeof fsGoTo === 'function') fsGoTo(id, true);
  }
}

function hqRun(promise, okText, done) {
  hqState.busy = true;
  return promise.then(function(res) {
    hqState.busy = false;
    if (res.error) { hqToast(res.error.message, true); if (done) done(false); return; }
    if (okText) hqToast(okText);
    if (done) done(true);
    hqAfterChange();
  }, function() {
    hqState.busy = false;
    hqToast('Нет связи со штабом — попробуй ещё раз', true);
    if (done) done(false);
  });
}

// ── Приказ дня ─────────────────────────────────────────────────────

function hqRenderDirective() {
  var o = hqState.orders || {};
  var dir = o.directive;
  hqSetHead('Приказ дня', 'его увидит вся фракция, каждому придёт уведомление');

  if (!o.can_edit) {
    document.getElementById('hq-body').innerHTML =
      '<div class="hq-empty">Приказы отдаёт лидер и те, кому он это поручил.</div>';
    document.getElementById('hq-foot').innerHTML = '';
    return;
  }

  document.getElementById('hq-body').innerHTML =
    (dir ? '<div class="hq-note">Сейчас: ' + hqEsc(dir.by || 'штаб') + ' · ' + hqEsc(hqAgo(dir.at)) + '</div>' : '') +
    '<textarea id="hq-dir-text" maxlength="280" rows="5" ' +
      'placeholder="Например: держим Набу, флоты — к Анаксесу к 20:00">' + hqEsc(dir ? dir.text : '') + '</textarea>' +
    '<div class="hq-count"><span id="hq-dir-count">0</span> / 280</div>';

  document.getElementById('hq-foot').innerHTML =
    '<div class="hq-actions">' +
      (dir ? '<button type="button" class="pr-btn ghost" data-hq="dir-clear">Снять приказ</button>' : '') +
      '<button type="button" class="pr-btn good" data-hq="dir-save">Опубликовать</button>' +
    '</div>';

  var ta = document.getElementById('hq-dir-text');
  var cnt = document.getElementById('hq-dir-count');
  var paint = function() { cnt.textContent = ta.value.length; };
  ta.addEventListener('input', paint);
  paint();
}

function hqSaveDirective(clear) {
  if (hqState.busy) return;
  var ta = document.getElementById('hq-dir-text');
  var text = clear ? '' : (ta ? ta.value.trim() : '');
  if (!clear && !text) { hqToast('Напиши приказ или сними старый', true); return; }
  if (clear && !confirm('Снять приказ дня?')) return;

  hqRun(supabase.rpc('set_faction_directive', { p_text: text }),
    clear ? 'Приказ снят' : 'Приказ опубликован — фракция получила уведомление',
    function(ok) { if (ok) hqClose(); });
}

// ── Цели на карте ──────────────────────────────────────────────────

var hqTargetDraft = { system: '', kind: '' };

function hqLoadSystems() {
  return supabase.from('systems').select('id, name, faction').eq('is_deep_space', false).order('name')
    .then(function(res) { hqState.systems = res.error ? [] : (res.data || []); });
}

function hqMyFaction() {
  return (hqState.staff && hqState.staff.faction) || (typeof currentPlayerFaction !== 'undefined' ? currentPlayerFaction : null);
}

// Какие приказы подходят планете: наступать — только на чужую,
// оборонять и снабжать — только свою, сбор — где угодно
function hqKindAllowed(kind, sys) {
  if (!sys) return false;
  var own = sys.faction === hqMyFaction();
  if (kind === 'attack') return !own;
  if (kind === 'defend' || kind === 'supply') return own;
  return true;
}

function hqRenderTargets() {
  var o = hqState.orders || {};
  var targets = o.targets || [];
  hqSetHead('Цели на карте', 'метки видны всей фракции на карте галактики');

  var body = '';
  if (targets.length) {
    body += '<div class="hq-block">Сейчас · ' + targets.length + ' из 8</div>';
    targets.forEach(function(t) {
      var k = HQ_KINDS[t.kind] || HQ_KINDS.gather;
      body += '<div class="hq-trow">' +
        '<span class="hq-ico k-' + hqEsc(t.kind) + '">' + k.icon + '</span>' +
        '<span class="hq-trow-body"><b>' + hqEsc(t.name) + '</b><i>' + k.label +
          (t.note ? ' · ' + hqEsc(t.note) : '') + '</i></span>' +
        (o.can_edit ? '<button type="button" class="hq-x-btn" data-hq="target-clear" data-id="' +
          hqEsc(t.system_id) + '">снять</button>' : '') +
      '</div>';
    });
  } else {
    body += '<div class="hq-empty">Целей пока нет.</div>';
  }

  if (!o.can_edit) {
    document.getElementById('hq-body').innerHTML = body;
    document.getElementById('hq-foot').innerHTML = '';
    return;
  }

  // Форма новой цели. Если планета уже отмечена, новая метка её заменит.
  var list = hqState.systems || [];
  var opts = '<option value="">— выбери планету —</option>';
  list.forEach(function(s) {
    var own = s.faction === hqMyFaction();
    opts += '<option value="' + hqEsc(s.id) + '"' + (hqTargetDraft.system === s.id ? ' selected' : '') + '>' +
      hqEsc(s.name) + (own ? '' : ' · чужая') + '</option>';
  });

  body += '<div class="hq-block">Новая цель</div>' +
    '<select id="hq-t-sys" class="hq-select">' + opts + '</select>' +
    '<div class="hq-kinds" id="hq-kinds"></div>' +
    '<input id="hq-t-note" class="hq-input" type="text" maxlength="80" placeholder="пояснение — например, «сбор к 20:00»">';

  document.getElementById('hq-body').innerHTML = body;
  document.getElementById('hq-foot').innerHTML =
    '<button type="button" id="hq-t-go" class="hq-go" data-hq="target-set" disabled>Выбери планету и приказ</button>';

  document.getElementById('hq-t-sys').addEventListener('change', function() {
    hqTargetDraft.system = this.value;
    hqPaintKinds();
  });
  hqPaintKinds();
}

function hqSysById(id) {
  var list = hqState.systems || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function hqPaintKinds() {
  var box = document.getElementById('hq-kinds');
  if (!box) return;
  var sys = hqSysById(hqTargetDraft.system);
  if (hqTargetDraft.kind && !hqKindAllowed(hqTargetDraft.kind, sys)) hqTargetDraft.kind = '';

  box.innerHTML = HQ_KIND_ORDER.map(function(k) {
    var d = HQ_KINDS[k];
    var ok = hqKindAllowed(k, sys);
    return '<button type="button" class="hq-kind k-' + k + (hqTargetDraft.kind === k ? ' on' : '') + '"' +
      ' data-hq="kind" data-kind="' + k + '"' + (ok ? '' : ' disabled') + '>' +
      '<i>' + d.icon + '</i><b>' + d.label + '</b><span>' + d.hint + '</span></button>';
  }).join('');

  // Предел — 8 меток; переставить метку на уже отмеченной планете можно всегда
  var targets = (hqState.orders && hqState.orders.targets) || [];
  var marked = sys && targets.some(function(t) { return t.system_id === sys.id; });
  var full = targets.length >= 8 && !marked;

  var go = document.getElementById('hq-t-go');
  if (go) {
    go.disabled = !sys || !hqTargetDraft.kind || full;
    go.textContent = full ? 'Предел 8 целей — сними старую'
      : !sys ? 'Выбери планету'
      : !hqTargetDraft.kind ? 'Выбери приказ'
      : HQ_KINDS[hqTargetDraft.kind].label + ' · ' + sys.name;
  }
}

function hqPickKind(kind) {
  hqTargetDraft.kind = kind;
  hqPaintKinds();
}

function hqSaveTarget() {
  if (hqState.busy || !hqTargetDraft.system || !hqTargetDraft.kind) return;
  var note = document.getElementById('hq-t-note');
  var go = document.getElementById('hq-t-go');
  if (go) go.disabled = true;
  hqRun(supabase.rpc('set_faction_target', {
    p_system_id: hqTargetDraft.system, p_kind: hqTargetDraft.kind, p_note: note ? note.value.trim() : null
  }), 'Цель поставлена — метка уже на карте', function(ok) {
    if (ok) { hqTargetDraft = { system: '', kind: '' }; }
    else if (go) go.disabled = false;
  });
}

function hqClearTarget(systemId, btn) {
  if (hqState.busy) return;
  btn.disabled = true;
  hqRun(supabase.rpc('set_faction_target', { p_system_id: systemId, p_kind: null, p_note: null }),
    'Метка снята', function(ok) { if (!ok) btn.disabled = false; });
}

// ── Должности ──────────────────────────────────────────────────────

// Можно ли трогать должность: лидер — любую; остальные с правом
// «Должности» — не свою и не выше своих полномочий (так же решает сервер)
function hqCanTouchRole(role) {
  var st = hqState.staff;
  if (!st) return false;
  if (st.is_leader) return true;
  if (!hqHas('manage_roles')) return false;
  if (role.id === st.my_role) return false;
  return hqSubset(role.powers, hqState.powers);
}

function hqRoleById(id) {
  var list = (hqState.staff && hqState.staff.roles) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function hqMyId() {
  return (typeof currentUserId !== 'undefined' && currentUserId) || null;
}

// Можно ли переназначить игрока: лидера — никогда; себя — только лидеру;
// того, кто уже на должности выше наших полномочий, — тоже нельзя
function hqCanTouchMember(m) {
  var st = hqState.staff;
  if (!st || m.is_leader) return false;
  if (st.is_leader) return true;
  if (!hqHas('manage_roles')) return false;
  if (m.id === hqMyId()) return false;
  var cur = m.role_id ? hqRoleById(m.role_id) : null;
  return !cur || hqSubset(cur.powers, hqState.powers);
}

function hqRenderRoles() {
  var st = hqState.staff;
  var body = document.getElementById('hq-body');
  var foot = document.getElementById('hq-foot');
  if (!st) {
    hqSetHead('Должности штаба', '');
    body.innerHTML = '<div class="hq-empty">Штаб недоступен — нет связи или фракция не назначена.</div>';
    foot.innerHTML = '';
    return;
  }

  var canManage = hqHas('manage_roles');
  var me = hqMyId();
  var roles = st.roles || [];
  var members = st.members || [];
  hqSetHead('Должности штаба', roles.length + ' из 10 · ' +
    (canManage ? 'ты управляешь должностями' : 'назначает лидер'));

  var html = '<div class="hq-leader"><span class="fs-crown">♛</span>Лидер — <b>' +
    hqEsc(st.leader ? st.leader.nickname : 'не назначен') + '</b><em>все полномочия</em></div>';

  if (hqState.editRole === 'new') html += hqRoleEditor(null);

  roles.forEach(function(r) {
    if (hqState.editRole === r.id) { html += hqRoleEditor(r); return; }

    var touch = hqCanTouchRole(r);
    html += '<div class="hq-role' + (r.id === st.my_role ? ' mine' : '') + '">' +
      '<div class="hq-role-head"><b>' + hqEsc(r.name) + '</b>' +
        (r.id === st.my_role ? '<em class="fs-you">твоя</em>' : '') +
        (touch ? '<button type="button" class="hq-link" data-hq="role-edit" data-id="' + r.id + '">изменить</button>' : '') +
      '</div>' +
      '<div class="hq-powers">' + (r.powers.length
        ? r.powers.map(function(p) { return '<span class="hq-pw">' + hqPowerName(p) + '</span>'; }).join('')
        : '<span class="hq-pw none">без полномочий — звание</span>') + '</div>';

    var holders = r.members || [];
    html += '<div class="hq-holders">';
    if (!holders.length) html += '<div class="hq-holder vacant">вакансия</div>';
    holders.forEach(function(h) {
      var hm = null;
      members.forEach(function(m) { if (m.id === h.id) hm = m; });
      var canX = touch && hm && hqCanTouchMember(hm) && h.id !== me;
      html += '<div class="hq-holder"><span>' + hqEsc(h.nickname) + '</span>' +
        (canX ? '<button type="button" class="hq-x-btn" data-hq="unassign" data-user="' + h.id + '">снять</button>' : '') +
      '</div>';
    });
    html += '</div>';

    // Назначить: кто ещё не на этой должности и кого нам можно трогать
    if (touch) {
      var cand = members.filter(function(m) {
        return !m.is_leader && m.role_id !== r.id && m.id !== me && hqCanTouchMember(m);
      });
      if (cand.length) {
        html += '<div class="hq-assign"><select class="hq-select" id="hq-as-' + r.id + '">' +
          '<option value="">— кого назначить —</option>' +
          cand.map(function(m) {
            var cur = m.role_id ? hqRoleById(m.role_id) : null;
            return '<option value="' + m.id + '">' + hqEsc(m.nickname) +
              (cur ? ' (сейчас: ' + hqEsc(cur.name) + ')' : '') + '</option>';
          }).join('') +
          '</select><button type="button" class="hq-small" data-hq="assign" data-id="' + r.id + '">Назначить</button></div>';
      }
    }
    html += '</div>';
  });

  if (!roles.length && hqState.editRole !== 'new') {
    html += '<div class="hq-empty">' + (canManage
      ? 'Должностей пока нет. Заведи первую — например, «Квартирмейстер» с полномочием «Хозяйство».'
      : 'Должностей пока нет — их заводит лидер.') + '</div>';
  }

  // Кто без должности — чтобы было видно, кого ещё можно привлечь
  var free = members.filter(function(m) { return !m.is_leader && !m.role_id; });
  if (free.length) {
    html += '<div class="hq-block">Без должности · ' + free.length + '</div>' +
      '<div class="hq-free">' + free.map(function(m) { return '<span>' + hqEsc(m.nickname) + '</span>'; }).join('') + '</div>';
  }

  body.innerHTML = html;
  // Пока открыта правка, новую должность не предлагаем — одна форма за раз
  foot.innerHTML = (canManage && !hqState.editRole && roles.length < 10)
    ? '<button type="button" class="hq-go" data-hq="role-new">+ Новая должность</button>' : '';
}

function hqRoleEditor(role) {
  var st = hqState.staff;
  var isLeader = st && st.is_leader;
  var has = role ? role.powers : [];
  var id = role ? role.id : 'new';

  var html = '<div class="hq-role edit">' +
    '<div class="hq-block">' + (role ? 'Правка должности' : 'Новая должность') + '</div>' +
    '<input id="hq-r-name" class="hq-input" type="text" maxlength="32" placeholder="название — от 2 до 32 знаков" value="' +
      hqEsc(role ? role.name : '') + '">' +
    '<div class="hq-pw-list">';

  HQ_POWERS.forEach(function(p) {
    // Чужое полномочие выдать нельзя: показываем, но не даём отметить
    var allowed = isLeader || hqHas(p.id);
    html += '<label class="hq-pw-opt' + (allowed ? '' : ' off') + '">' +
      '<input type="checkbox" value="' + p.id + '"' + (has.indexOf(p.id) >= 0 ? ' checked' : '') +
        (allowed ? '' : ' disabled') + '>' +
      '<span><b>' + p.name + '</b><i>' + (allowed ? p.text : 'нет у тебя — выдать не можешь') + '</i></span>' +
    '</label>';
  });

  html += '</div><div class="hq-actions">' +
    '<button type="button" class="pr-btn ghost" data-hq="role-cancel">Отмена</button>' +
    '<button type="button" class="pr-btn good" data-hq="role-save" data-id="' + id + '">Сохранить</button>' +
    '</div>' +
    (role ? '<button type="button" class="hq-danger" data-hq="role-archive" data-id="' + id + '">Упразднить должность</button>' : '') +
    '</div>';
  return html;
}

function hqSaveRole(id) {
  if (hqState.busy) return;
  var name = (document.getElementById('hq-r-name') || {}).value || '';
  var boxes = document.querySelectorAll('#hq-body .hq-pw-opt input:checked');
  var powers = [];
  for (var i = 0; i < boxes.length; i++) powers.push(boxes[i].value);

  hqRun(supabase.rpc('save_faction_role', {
    p_id: id === 'new' ? null : id, p_name: name.trim(), p_powers: powers
  }), id === 'new' ? 'Должность заведена' : 'Должность обновлена', function(ok) {
    if (ok) hqState.editRole = null;
  });
}

function hqArchiveRole(id) {
  var r = hqRoleById(id);
  if (!r || hqState.busy) return;
  var n = (r.members || []).length;
  if (!confirm('Упразднить должность «' + r.name + '»?' +
      (n ? '\n\n' + n + ' ' + fsPlural(n, 'игрок останется', 'игрока останутся', 'игроков останутся') + ' без должности.' : ''))) return;
  hqRun(supabase.rpc('archive_faction_role', { p_id: id }), 'Должность упразднена', function(ok) {
    if (ok) hqState.editRole = null;
  });
}

function hqAssign(roleId, btn) {
  if (hqState.busy) return;
  var sel = document.getElementById('hq-as-' + roleId);
  if (!sel || !sel.value) { hqToast('Выбери, кого назначить', true); return; }
  btn.disabled = true;
  var r = hqRoleById(roleId);
  hqRun(supabase.rpc('assign_faction_role', { p_user_id: sel.value, p_role_id: roleId }),
    'Назначен: ' + (r ? r.name : 'должность'), function(ok) { if (!ok) btn.disabled = false; });
}

function hqUnassign(userId, btn) {
  if (hqState.busy || !userId) return;
  if (!confirm('Снять игрока с должности?')) return;
  btn.disabled = true;
  hqRun(supabase.rpc('assign_faction_role', { p_user_id: userId, p_role_id: null }),
    'Снят с должности', function(ok) { if (!ok) btn.disabled = false; });
}

// ── Хозяйство фракции ──────────────────────────────────────────────

var hqEco = null;
var hqEcoErr = null;

function hqLoadEconomy() {
  return supabase.rpc('get_faction_economy').then(function(res) {
    hqEcoErr = res.error ? res.error.message : null;
    hqEco = res.error ? null : (res.data || []);
  });
}

function hqChip(c, prefix, suffix) {
  var col = c.color || '#8fa8c4';
  return '<span class="hq-res" style="border-color:' + hqEsc(col) + ';color:' + hqEsc(col) + '">' +
    hqEsc(c.name) + ' <b>' + (prefix || '') + hqNum(c.amount) + (suffix || '') + '</b></span>';
}

function hqRenderEconomy() {
  var body = document.getElementById('hq-body');
  var foot = document.getElementById('hq-foot');
  foot.innerHTML = '';

  if (hqEcoErr || !hqEco) {
    hqSetHead('Хозяйство фракции', '');
    body.innerHTML = '<div class="hq-empty">' + hqEsc(hqEcoErr || 'Нет данных') + '</div>';
    return;
  }

  var income = 0, used = 0, slots = 0;
  hqEco.forEach(function(p) { income += p.income || 0; used += p.used || 0; slots += p.slots || 0; });
  hqSetHead('Хозяйство фракции', hqEco.length + ' ' + fsPlural(hqEco.length, 'планета', 'планеты', 'планет') +
    ' · ' + hqNum(income) + ' кр/сут');

  var html = '<div class="hq-eco-sum">' +
    '<div><b>' + hqNum(income) + '</b><span>кр в сутки</span></div>' +
    '<div><b>' + used + '/' + slots + '</b><span>участков занято</span></div>' +
    '<div><b>' + hqEco.length + '</b><span>' + fsPlural(hqEco.length, 'планета', 'планеты', 'планет') + '</span></div>' +
  '</div>';

  hqEco.forEach(function(p) {
    var open = !!hqState.ecoOpen[p.id];
    var pct = p.slots ? Math.min(100, Math.round((p.used || 0) * 100 / p.slots)) : 0;
    var mood = typeof fsMoodClass === 'function' ? fsMoodClass(p.satisfaction) : '';
    var stockSum = 0;
    (p.stock || []).forEach(function(s) { stockSum += s.amount || 0; });

    html += '<div class="hq-eco' + (open ? ' open' : '') + '">' +
      '<button type="button" class="hq-eco-head" data-hq="eco-toggle" data-id="' + hqEsc(p.id) + '">' +
        '<span class="hq-eco-name"><b>' + hqEsc(p.name) + '</b>' +
          '<i>' + (p.controller ? hqEsc(p.controller) : '<em>ничья</em>') +
          (p.level_name ? ' · ' + hqEsc(p.level_name) : '') +
          (p.satisfaction != null ? ' · <span class="fs-mood ' + mood + '">☺ ' + p.satisfaction + '</span>' : '') +
          '</i></span>' +
        '<span class="hq-eco-inc"><b>' + (p.income ? '+' + hqNum(p.income) : '0') + '</b>кр/сут</span>' +
        '<span class="hq-eco-arrow">' + (open ? '▾' : '▸') + '</span>' +
      '</button>' +
      '<div class="hq-eco-slots"><span>здания ' + (p.used || 0) + ' / ' + (p.slots || 0) + '</span>' +
        '<div class="hq-bar"><i style="width:' + pct + '%"></i></div></div>';

    if ((p.per_day || []).length) {
      html += '<div class="hq-res-row"><em>добыча</em>' +
        p.per_day.map(function(c) { return hqChip(c, '+', '/сут'); }).join('') + '</div>';
    }
    html += '<div class="hq-res-row"><em>склад ' + hqNum(stockSum) + '/' + hqNum(p.cap) + '</em>' +
      ((p.stock || []).length ? p.stock.map(function(c) { return hqChip(c); }).join('') : '<span class="hq-res none">пусто</span>') +
      '</div>';

    if (open) {
      html += '<div class="hq-eco-more">';
      var bl = p.buildings || [];
      if (!bl.length) html += '<div class="hq-eco-line dim">Построек нет</div>';
      bl.forEach(function(b) {
        var stTxt = b.state === 'build' ? 'строится' : b.state === 'trophy' ? 'трофей, стоит' : 'работает';
        html += '<div class="hq-eco-line ' + b.state + '"><span>' + b.slot + '. ' + hqEsc(b.name) + '</span>' +
          '<em>' + stTxt + (b.owner ? ' · ' + hqEsc(b.owner) : '') + '</em></div>';
      });
      html += '<div class="hq-eco-line dim"><span>Очереди</span><em>найм ' + (p.orders || 0) +
        ' · наука ' + (p.research || 0) + '</em></div>' +
        '<button type="button" class="hq-small wide" data-hq="go" data-id="' + hqEsc(p.id) + '">К планете на карте ›</button>' +
      '</div>';
    }
    html += '</div>';
  });

  body.innerHTML = html;
}

// ── Входы ──────────────────────────────────────────────────────────

function openHqRoles() { hqOpen('roles'); }
function openHqEconomy() { hqOpen('economy'); }
function openHqDirective() { hqOpen('directive'); }
function openHqTargets() { hqTargetDraft = { system: '', kind: '' }; hqOpen('targets'); }

document.addEventListener('DOMContentLoaded', function() {
  var roles = document.getElementById('fs-staff-btn');
  var eco = document.getElementById('fs-economy-btn');
  if (roles) roles.addEventListener('click', openHqRoles);
  if (eco) eco.addEventListener('click', openHqEconomy);
});
