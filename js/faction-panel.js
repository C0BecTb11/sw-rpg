// Окно фракции: живая сводка о своей стороне войны.
//
// Всё приходит одним вызовом get_faction_overview (только своя фракция и
// честные цифры о враге — сколько у него планет и игроков, без армий),
// плюс лента get_faction_feed. Пока окно открыто, данные обновляются раз в
// 30 секунд, а полосы захвата и таймеры идут каждую секунду локально.
//
// Кнопка «Панель управления» видна только лидеру (сверено с БД, а не просто
// спрятана в интерфейсе — сама панель управления тоже защищена RLS-политиками
// на бэкенде). planet-request.js и faction-control.js опираются на глобальные
// currentPlayerFaction / currentPlayerIsLeader и вызов onFactionScreenReady.

var FACTION_NAMES_PANEL = {
  republic: 'Республика',
  cis: 'КНС'
};

var FACTION_FULL_NAMES_PANEL = {
  republic: 'Галактическая Республика',
  cis: 'Конфедерация независимых систем'
};

var currentPlayerFaction = null;
var currentPlayerIsLeader = false;
// Полномочия по должности в штабе: у лидера — все (см. faction-staff.js)
var currentPlayerPowers = [];

function fsHasPower(p) {
  return currentPlayerIsLeader || currentPlayerPowers.indexOf(p) >= 0;
}

var FS_REFRESH_MS = 30000;
var FS_ONLINE_MS = 5 * 60000;

var fsState = {
  open: false,
  busy: false,
  req: 0,
  data: null,
  feed: null,
  loadedAt: 0,      // локальное время прихода данных
  offset: 0,        // сервер минус локальное, мс
  ready: false,     // onFactionScreenReady уже вызван в этом открытии
  leader: null,
  refreshTimer: null,
  tickTimer: null,
  feedAll: false,
  planetsAll: false,
  refetchAt: 0
};

// ── Мелочи ─────────────────────────────────────────────────────────

function fsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fsPlural(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// 12 500 — с узким пробелом, чтобы большие суммы читались с одного взгляда
function fsNum(n) {
  n = Math.round(Number(n) || 0);
  var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (n < 0 ? '−' : '') + s;
}

function fsNow() {
  if (typeof svNow === 'function' && typeof svClock !== 'undefined' && svClock.ready) return svNow();
  return Date.now() + fsState.offset;
}

function fsAgo(iso) {
  if (!iso) return null;
  var sec = Math.max(0, Math.round((fsNow() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'только что';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин назад';
  if (sec < 86400) return Math.floor(sec / 3600) + ' ч назад';
  var d = Math.floor(sec / 86400);
  return d + ' ' + fsPlural(d, 'день', 'дня', 'дней') + ' назад';
}

function fsClockText(sec) {
  sec = Math.max(0, Math.ceil(sec));
  var m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function fsLeftText(sec) {
  if (typeof svLeftText === 'function') return svLeftText(sec);
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? h + ' ч ' + m + ' мин' : m + ' мин';
}

function fsIsOnline(m) {
  if (m.is_me) return true;
  if (!m.last_seen_at) return false;
  return fsNow() - new Date(m.last_seen_at).getTime() <= FS_ONLINE_MS;
}

function fsMoodClass(sat) {
  if (sat === null || sat === undefined) return '';
  return sat >= 60 ? 'good' : sat >= 30 ? 'mid' : 'bad';
}

// ── Шапка ──────────────────────────────────────────────────────────

function fsSetFaction(faction) {
  var box = document.getElementById('faction-screen-box');
  if (!box) return;
  box.classList.remove('fs-republic', 'fs-cis');
  if (faction === 'republic' || faction === 'cis') box.classList.add('fs-' + faction);

  // Эмблема и водяной знак подставляются стилями по классу фракции
  var full = document.getElementById('fs-fullname');
  if (full) full.textContent = FACTION_FULL_NAMES_PANEL[faction] || '';
}

function fsPaintHeader() {
  var d = fsState.data;
  var nameEl = document.getElementById('faction-screen-name');
  var leaderEl = document.getElementById('faction-screen-leader');
  var chips = document.getElementById('fs-hero-chips');
  if (!d || !nameEl) return;

  nameEl.textContent = FACTION_NAMES_PANEL[d.faction] || d.faction;
  if (d.leader) {
    leaderEl.innerHTML = '<span class="fs-crown">♛</span>' + fsEsc(d.leader.nickname || 'неизвестно') +
      (d.my_role === 'leader' ? ' <em class="fs-you">это ты</em>' : '');
  } else {
    leaderEl.textContent = 'не назначен';
  }

  var c = d.counts || {};
  var mine = 0;
  (d.members || []).forEach(function(m) { if (m.is_me) mine = m.planets; });
  chips.innerHTML =
    '<span class="fs-chip fs-chip-pay"><i>◷</i><b id="fs-payout">—</b></span>' +
    '<span class="fs-chip fs-chip-online"><i class="fs-dot on"></i>' + fsNum(c.online_own) + ' в сети</span>' +
    '<span class="fs-chip"><i>◉</i>у тебя ' + fsNum(mine) + ' ' + fsPlural(mine, 'планета', 'планеты', 'планет') + '</span>';
  fsPaintPayout();
}

function fsPaintPayout() {
  var el = document.getElementById('fs-payout');
  if (!el || !fsState.data) return;
  var next = 0;
  if (typeof svNextPayoutMs === 'function' && typeof svClock !== 'undefined' && svClock.ready) next = svNextPayoutMs();
  if (!next && fsState.data.next_payout) {
    next = new Date(fsState.data.next_payout).getTime();
    while (next && next <= fsNow()) next += 86400000;
  }
  if (!next) { el.textContent = 'выдача —'; return; }
  var at = typeof svFormatTime === 'function' ? svFormatTime(next, false) : '';
  var zone = (typeof svClock !== 'undefined' && svClock.label) ? ' ' + svClock.label : '';
  el.textContent = 'Выдача через ' + fsLeftText((next - fsNow()) / 1000) + (at ? ' · ' + at + zone : '');
}

function fsSetLive(state) {
  var el = document.getElementById('fs-live');
  if (!el) return;
  el.className = 'fs-live ' + state;
  el.lastChild.textContent = state === 'stale' ? 'нет связи' : state === 'loading' ? 'обновление' : 'в эфире';
}

// ── Кнопки действий ────────────────────────────────────────────────

function fsPaintActions() {
  var supply = document.getElementById('fs-supply-btn');
  if (supply) supply.style.display = (typeof openSupplyScreen === 'function') ? 'flex' : 'none';
  // Панель управления — лидеру и тем, кому поручены управляющие планет
  var controlBtn = document.getElementById('faction-control-open-btn');
  if (controlBtn) controlBtn.style.display = fsHasPower('planet_controllers') ? 'flex' : 'none';
  // Должности видны всем: кто за что отвечает, должен знать каждый
  var staffBtn = document.getElementById('fs-staff-btn');
  if (staffBtn) staffBtn.style.display = (currentPlayerFaction && typeof openHqRoles === 'function') ? 'flex' : 'none';
  var ecoBtn = document.getElementById('fs-economy-btn');
  if (ecoBtn) ecoBtn.style.display = (fsHasPower('economy') && typeof openHqEconomy === 'function') ? 'flex' : 'none';
}

// ── Тело экрана ────────────────────────────────────────────────────

function fsSkeleton() {
  var body = document.getElementById('fs-body');
  if (!body) return;
  body.innerHTML =
    '<div class="fs-sk fs-sk-title"></div><div class="fs-sk fs-sk-big"></div>' +
    '<div class="fs-sk-grid"><div class="fs-sk"></div><div class="fs-sk"></div><div class="fs-sk"></div><div class="fs-sk"></div></div>' +
    '<div class="fs-sk fs-sk-title"></div><div class="fs-sk fs-sk-row"></div><div class="fs-sk fs-sk-row"></div>';
}

function fsSecHead(title, meta) {
  return '<div class="fs-sec-head"><span class="fs-sec-title">' + title + '</span>' +
    (meta ? '<span class="fs-sec-meta">' + meta + '</span>' : '') + '</div>';
}

function fsRenderBalance(d) {
  var c = d.counts || {};
  var own = c.planets_own || 0, foe = c.planets_enemy || 0;
  var total = own + foe;
  var share = total ? Math.round(own * 100 / total) : 50;
  var enemyName = FACTION_NAMES_PANEL[d.enemy] || 'враг';

  var html = '<section class="fs-sec">' + fsSecHead('Баланс сил', 'о враге — только открытое');

  html += '<div class="fs-territory">' +
    '<div class="fs-tile-head"><i>◉</i>Планеты<em>' + fsNum(total) + ' всего</em></div>' +
    '<div class="fs-terr-row">' +
      '<div class="fs-terr-side own"><b data-count="' + own + '">' + fsNum(own) + '</b><span>наши</span></div>' +
      '<div class="fs-terr-mid">' + share + '%<i>галактики</i></div>' +
      '<div class="fs-terr-side foe"><b data-count="' + foe + '">' + fsNum(foe) + '</b><span>' +
        fsEsc(enemyName) + '</span></div>' +
    '</div>' +
    '<div class="fs-split"><i class="own" style="width:' + share + '%"></i><i class="foe" style="width:' + (100 - share) + '%"></i></div>' +
    '<div class="fs-terr-foot"><span>на фронте <b>' + fsNum(c.planets_front) + '</b></span>' +
      '<span>в тылу <b>' + fsNum(Math.max(0, own - (c.planets_front || 0))) + '</b></span></div>' +
  '</div>';

  var heroes = c.heroes_own || 0;
  var fighters = c.fighters_own || 0;
  var moving = c.ships_moving || 0;
  var stations = c.stations_own || 0;

  html += '<div class="fs-tiles">' +
    fsTile('players', '☍', 'Игроки', c.players_own,
      '<span class="fs-pulse-text"><i class="fs-dot on"></i>' + fsNum(c.online_own) + ' в сети</span>' +
      '<span>у врага ' + fsNum(c.players_enemy) + '</span>') +
    fsTile('troops', '⚔', 'Войска', c.units_own,
      '<span>' + fsPlural(c.units_own || 0, 'боец', 'бойца', 'бойцов') + ' на картах</span>' +
      (heroes ? '<span class="sci">' + fsNum(heroes) + ' ' + fsPlural(heroes, 'одарённый', 'одарённых', 'одарённых') + '</span>' : '')) +
    fsTile('fleet', '⟁', 'Флот', c.ships_own,
      '<span>' + fsPlural(c.ships_own || 0, 'корабль', 'корабля', 'кораблей') +
        (fighters ? ' · ' + fsNum(fighters) + '\u00a0истр.' : '') + '</span>' +
      '<span>' + fsNum(c.commanders_own) + '\u00a0' + fsPlural(c.commanders_own || 0, 'командир', 'командира', 'командиров') +
        (moving ? ' · ' + fsNum(moving) + '\u00a0в\u00a0пути'
         : stations ? ' · ' + fsNum(stations) + '\u00a0' + fsPlural(stations, 'станция', 'станции', 'станций') : '') + '</span>') +
    fsTile('income', '◈', 'Доход в сутки', c.income_day,
      '<span>кредитов с поселений</span>' +
      '<span>прошлая выдача ' + fsNum(c.income_last) + '</span>') +
  '</div>';

  html += fsRenderSettlements(c.settlements || []);
  return html + '</section>';
}

function fsTile(kind, icon, label, value, sub) {
  return '<div class="fs-tile ' + kind + '">' +
    '<div class="fs-tile-head"><i>' + icon + '</i>' + label + '</div>' +
    '<b data-count="' + (Number(value) || 0) + '">' + fsNum(value) + '</b>' +
    '<div class="fs-tile-sub">' + sub + '</div>' +
  '</div>';
}

// Уровни поселений столбиками: сразу видно, растёт ли фракция
function fsRenderSettlements(list) {
  var LEVELS = [
    { level: 1, name: 'Посёлок' }, { level: 2, name: 'Городок' },
    { level: 3, name: 'Город' }, { level: 4, name: 'Столица округа' }
  ];
  var by = {};
  var max = 1;
  list.forEach(function(s) {
    by[s.level] = s;
    if (s.count > max) max = s.count;
  });
  list.forEach(function(s) {
    var known = LEVELS.some(function(l) { return l.level === s.level; });
    if (!known) LEVELS.push({ level: s.level, name: s.name });
  });

  var total = 0;
  list.forEach(function(s) { total += s.count; });

  var cols = LEVELS.map(function(l) {
    var s = by[l.level];
    var n = s ? s.count : 0;
    var h = n ? Math.max(12, Math.round(n * 100 / max)) : 0;
    return '<div class="fs-lvl' + (n ? '' : ' none') + '">' +
      '<div class="fs-lvl-bar"><i style="height:' + h + '%"></i></div>' +
      '<b>' + n + '</b><span>' + fsEsc((s && s.name) || l.name) + '</span></div>';
  }).join('');

  return '<div class="fs-settle">' +
    '<div class="fs-tile-head"><i>⌂</i>Поселения<em>' + fsNum(total) + '</em></div>' +
    '<div class="fs-lvls">' + cols + '</div></div>';
}

var FS_CAPTURE_TEXT = {
  defend: {
    capturing: 'Враг берёт поселение',
    reverting: 'Отбиваем — полоса уходит',
    contested: 'Бой в поселении: силы равны',
    stalled: 'Враг отошёл — захват замер'
  },
  attack: {
    capturing: 'Наши берут поселение',
    reverting: 'Враг отбивается — полоса уходит',
    contested: 'Бой в поселении: силы равны',
    stalled: 'Наших нет в зоне — захват замер'
  }
};

function fsRenderFront(d) {
  var caps = d.captures || [];
  var planets = d.planets || [];
  var front = planets.filter(function(p) { return p.status === 'front'; });
  var dist = planets.filter(function(p) { return p.status === 'distribution'; });
  var meta = caps.length
    ? '<b class="hot">' + caps.length + ' ' + fsPlural(caps.length, 'захват', 'захвата', 'захватов') + '</b>'
    : fsNum(front.length) + ' на границе';

  var html = '<section class="fs-sec">' + fsSecHead('Фронт', meta);

  if (!caps.length && !front.length && !dist.length) {
    return html + '<div class="fs-empty">На границах тихо: рядом с нашими планетами нет вражеских.</div></section>';
  }

  caps.forEach(function(cp, i) {
    var role = cp.role === 'attack' ? 'attack' : 'defend';
    var txt = (FS_CAPTURE_TEXT[role] || {})[cp.status] || 'Идёт захват';
    var who = FACTION_NAMES_PANEL[cp.faction] || '';
    html += '<button type="button" class="fs-cap ' + role + ' st-' + fsEsc(cp.status) + '" data-sys="' + fsEsc(cp.system_id) + '" data-cap="' + i + '">' +
      '<div class="fs-cap-top">' +
        '<span class="fs-cap-name">' + fsEsc(cp.name) + '</span>' +
        '<span class="fs-pill ' + (role === 'attack' ? 'attack' : 'capture') + '">' + (role === 'attack' ? 'наступаем' : 'оборона') + '</span>' +
      '</div>' +
      '<div class="fs-cap-text">' + txt + (role === 'defend' && who ? ' · ' + fsEsc(who) : '') + '</div>' +
      '<div class="fs-cap-track"><i data-cap-bar="' + i + '"></i></div>' +
      '<div class="fs-cap-foot"><span data-cap-pct="' + i + '">—</span><span data-cap-left="' + i + '">—</span></div>' +
    '</button>';
  });

  dist.forEach(function(p) {
    html += '<button type="button" class="fs-row fs-dist" data-sys="' + fsEsc(p.id) + '" data-info="1">' +
      '<span class="fs-row-ico">✦</span>' +
      '<span class="fs-row-body"><b>' + fsEsc(p.name) + '</b><i>взята — ждёт распределения штабом</i></span>' +
      '<span class="fs-chev">›</span></button>';
  });

  front.forEach(function(p) {
    var foes = (p.enemy_names || []).join(', ');
    html += '<button type="button" class="fs-row fs-front-row" data-sys="' + fsEsc(p.id) + '" data-info="1">' +
      '<span class="fs-row-ico front">' + fsNum(p.enemy_neighbours) + '</span>' +
      '<span class="fs-row-body"><b>' + fsEsc(p.name) + '</b>' +
        '<i>граничит: <em>' + fsEsc(foes) + '</em></i></span>' +
      '<span class="fs-row-side">' + (p.controller ? fsEsc(p.controller) : '<em class="free">ничья</em>') + '</span>' +
      '<span class="fs-chev">›</span></button>';
  });

  return html + '</section>';
}

function fsRenderMembers(d) {
  var list = d.members || [];
  var online = 0;
  list.forEach(function(m) { if (fsIsOnline(m)) online++; });

  var html = '<section class="fs-sec">' +
    fsSecHead('Состав', fsNum(list.length) + ' · <b class="on">' + online + ' в сети</b>');

  if (!list.length) return html + '<div class="fs-empty">В фракции пока никого.</div></section>';

  html += '<div class="fs-members">';
  list.forEach(function(m) {
    var on = fsIsOnline(m);
    var seen = on ? 'в сети' : (m.last_seen_at ? 'был ' + fsAgo(m.last_seen_at) : 'давно не заходил');
    // Должность в штабе — перед отметкой «в сети»
    var role = m.role ? '<span class="fs-role">' + fsEsc(m.role) + '</span> · ' : '';
    var nick = m.nickname || 'без ника';
    html += '<div class="fs-member' + (m.is_me ? ' me' : '') + (m.is_leader ? ' leader' : '') + '">' +
      '<span class="fs-ava">' + fsEsc(nick.charAt(0).toUpperCase()) + '<i class="fs-dot' + (on ? ' on' : '') + '"></i></span>' +
      '<span class="fs-member-body">' +
        '<b>' + (m.is_leader ? '<span class="fs-crown">♛</span>' : '') + fsEsc(nick) +
          (m.is_me ? ' <em class="fs-you">ты</em>' : '') + '</b>' +
        '<i class="' + (on ? 'on' : '') + '">' + role + seen + '</i>' +
      '</span>' +
      '<span class="fs-member-pl' + (m.planets ? '' : ' zero') + '"><b>' + fsNum(m.planets) + '</b>' +
        fsPlural(m.planets || 0, 'планета', 'планеты', 'планет') + '</span>' +
    '</div>';
  });
  return html + '</div></section>';
}

var FS_STATUS = {
  capture: { cls: 'capture', text: 'захват' },
  distribution: { cls: 'dist', text: 'распределение' },
  front: { cls: 'front', text: 'фронт' },
  rear: { cls: 'rear', text: 'тыл' }
};

function fsRenderPlanets(d) {
  var list = d.planets || [];
  var LIMIT = 6;
  var html = '<section class="fs-sec">' + fsSecHead('Планеты', fsNum(list.length));

  if (!list.length) return html + '<div class="fs-empty">У фракции пока нет планет.</div></section>';

  var shown = fsState.planetsAll ? list : list.slice(0, LIMIT);
  html += '<div class="fs-planets">';
  shown.forEach(function(p) {
    var st = FS_STATUS[p.status] || FS_STATUS.rear;
    var mood = fsMoodClass(p.satisfaction);
    var bits = [];
    bits.push(p.controller ? '<span class="who">' + fsEsc(p.controller) + '</span>' : '<span class="who free">ничья</span>');
    if (p.level_name) bits.push('<span>' + fsEsc(p.level_name) + (p.upgrading ? ' <em class="up">▲</em>' : '') + '</span>');
    if (p.satisfaction !== null && p.satisfaction !== undefined) {
      bits.push('<span class="fs-mood ' + mood + '">☺ ' + p.satisfaction + '</span>');
    }
    if (p.food_short) bits.push('<span class="fs-mood bad">голод</span>');

    html += '<button type="button" class="fs-planet st-' + st.cls + '" data-sys="' + fsEsc(p.id) + '" data-info="1">' +
      '<span class="fs-planet-body">' +
        '<span class="fs-planet-top"><b>' + fsEsc(p.name) + '</b>' +
          '<span class="fs-pill ' + st.cls + '">' + st.text + '</span></span>' +
        '<span class="fs-planet-line">' + bits.join('<i>·</i>') + '</span>' +
      '</span>' +
      '<span class="fs-planet-inc' + (p.income ? '' : ' zero') + '"><b>' + (p.income ? '+' + fsNum(p.income) : '0') + '</b>кр/сут</span>' +
    '</button>';
  });
  html += '</div>';

  if (list.length > LIMIT) {
    html += '<button type="button" class="fs-more" data-act="planets">' +
      (fsState.planetsAll ? 'Свернуть' : 'Все планеты (' + list.length + ')') + '</button>';
  }
  return html + '</section>';
}

// Строка события: кто, где и что — коротко, по-человечески
function fsFeedLine(e) {
  var m = e.meta || {};
  var sys = e.system_name || '';
  switch (e.type) {
    case 'fleet_departed':
      return [(e.subject && e.subject !== sys ? fsEsc(e.subject) + ' → ' : '→ ') + fsEsc(sys), fsEsc(m.commander || e.actor_name)];
    case 'fleet_arrived':
      return [fsEsc(sys), fsEsc(m.commander || e.actor_name)];
    case 'planet_granted':
      return [fsEsc(sys), e.actor_name ? 'управляет ' + fsEsc(e.actor_name) : ''];
    case 'planet_revoked':
      return [fsEsc(sys), e.actor_name ? 'снят ' + fsEsc(e.actor_name) : ''];
    case 'planet_captured':
      return [fsEsc(sys), e.tone === 'good' && m.from_faction && FACTION_NAMES_PANEL[m.from_faction]
        ? 'отбита у ' + fsEsc(FACTION_NAMES_PANEL[m.from_faction]) : ''];
    case 'capture_started':
      return [fsEsc(sys), e.subject ? 'наступает ' + fsEsc(e.subject) : ''];
    case 'enemy_approaching':
      return [fsEsc(sys), e.subject ? fsEsc(e.subject) : ''];
    case 'settlement_level_up':
      return [fsEsc(sys), e.subject ? 'теперь ' + fsEsc(e.subject) : ''];
    case 'militia_raised':
      return [fsEsc(sys), e.amount ? 'ополченцев: ' + e.amount : ''];
    default:
      var a = [];
      if (e.subject && e.subject !== sys) a.push(fsEsc(e.subject));
      if (sys) a.push(fsEsc(sys));
      return [a.join(' · '), fsEsc(e.actor_name || '')];
  }
}

function fsRenderFeed() {
  var feed = fsState.feed;
  var LIMIT = 6;
  var html = '<section class="fs-sec">' + fsSecHead('Сводка', 'для всей фракции');

  if (feed === null) return html + '<div class="fs-empty">Сводка сейчас недоступна.</div></section>';
  if (!feed.length) return html + '<div class="fs-empty">Пока ничего не случилось — сводка появится с первыми событиями.</div></section>';

  var shown = fsState.feedAll ? feed : feed.slice(0, LIMIT);
  html += '<div class="fs-feed">';
  shown.forEach(function(e) {
    var tone = e.tone === 'good' || e.tone === 'bad' || e.tone === 'warn' ? e.tone : 'neutral';
    var line = fsFeedLine(e);
    var tag = e.system_id ? 'button type="button" data-sys="' + fsEsc(e.system_id) + '"' : 'div';
    html += '<' + tag + ' class="fs-ev tone-' + tone + '">' +
      '<span class="fs-ev-dot"></span>' +
      '<span class="fs-ev-body"><b>' + fsEsc(e.title) + '</b>' +
        (line[0] || line[1] ? '<i>' + line[0] + (line[1] ? '<em> · ' + line[1] + '</em>' : '') + '</i>' : '') +
      '</span>' +
      '<span class="fs-ev-when">' + fsEsc(fsAgo(e.created_at)) + '</span>' +
    '</' + (e.system_id ? 'button' : 'div') + '>';
  });
  html += '</div>';

  if (feed.length > LIMIT) {
    html += '<button type="button" class="fs-more" data-act="feed">' +
      (fsState.feedAll ? 'Свернуть' : 'Вся сводка (' + feed.length + ')') + '</button>';
  }
  return html + '</section>';
}

function fsRender(animate) {
  var body = document.getElementById('fs-body');
  var d = fsState.data;
  if (!body || !d) return;

  var box = document.getElementById('faction-screen-box');
  var keep = box ? box.scrollTop : 0;
  body.classList.toggle('fs-anim', !!animate);
  body.innerHTML =
    (typeof fsRenderHQ === 'function' ? fsRenderHQ() : '') +
    fsRenderBalance(d) +
    fsRenderFront(d) +
    fsRenderMembers(d) +
    fsRenderPlanets(d) +
    fsRenderFeed();
  if (box) box.scrollTop = keep;

  if (animate) fsCountUp(body);
  fsTick();
}

// Цифры «набегают» при первом показе — экран ощущается живым
function fsCountUp(root) {
  var els = root.querySelectorAll('[data-count]');
  var t0 = Date.now(), dur = 650;
  function step() {
    var k = Math.min(1, (Date.now() - t0) / dur);
    var e = 1 - Math.pow(1 - k, 3);
    for (var i = 0; i < els.length; i++) {
      var v = Number(els[i].getAttribute('data-count')) || 0;
      els[i].textContent = fsNum(v * e);
    }
    if (k < 1 && fsState.open) window.requestAnimationFrame(step);
  }
  if (window.requestAnimationFrame) window.requestAnimationFrame(step);
}

function fsRenderError(text) {
  var body = document.getElementById('fs-body');
  if (!body) return;
  body.classList.remove('fs-anim');
  body.innerHTML = '<div class="fs-error"><b>Связь со штабом прервалась</b><span>' + fsEsc(text) + '</span>' +
    '<button type="button" class="fs-more" data-act="retry">Повторить</button></div>';
}

// ── Живые полосы захвата ───────────────────────────────────────────

function fsTick() {
  if (!fsState.open || !fsState.data) return;
  fsPaintPayout();

  var caps = fsState.data.captures || [];
  var passed = (Date.now() - fsState.loadedAt) / 1000;
  var needRefetch = false;

  caps.forEach(function(cp, i) {
    var goal = cp.goal || fsState.data.capture_goal || 60;
    var rate = Number(cp.rate) || 0;
    var p = Math.max(0, Math.min(goal, (Number(cp.progress) || 0) + rate * passed));
    var pct = Math.round(p * 100 / goal);
    var bar = document.querySelector('[data-cap-bar="' + i + '"]');
    var pctEl = document.querySelector('[data-cap-pct="' + i + '"]');
    var leftEl = document.querySelector('[data-cap-left="' + i + '"]');
    if (bar) bar.style.width = pct + '%';
    if (pctEl) pctEl.textContent = 'захвачено ' + pct + '%';
    if (leftEl) {
      if (rate > 0) leftEl.textContent = 'до захвата ' + fsClockText((goal - p) / rate);
      else if (rate < 0) leftEl.textContent = 'до срыва ' + fsClockText(p / -rate);
      else leftEl.textContent = 'полоса стоит';
    }
    if ((rate > 0 && p >= goal) || (rate < 0 && p <= 0)) needRefetch = true;
  });

  // Захват закончился — переспрашиваем сервер, не дожидаясь 30 секунд
  if (needRefetch && Date.now() > fsState.refetchAt) {
    fsState.refetchAt = Date.now() + 8000;
    setTimeout(function() { if (fsState.open) fsLoad(false); }, 2500);
  }
}

// ── Загрузка ───────────────────────────────────────────────────────

function fsLoad(first) {
  if (typeof supabase === 'undefined') return;
  if (fsState.busy && !first) return;
  fsState.busy = true;
  var my = ++fsState.req;
  fsSetLive('loading');

  Promise.all([
    supabase.rpc('get_faction_overview'),
    supabase.rpc('get_faction_feed', { p_limit: 30 }),
    // Штаб: приказ дня, цели и должности. Сбой штаба не ломает сводку.
    typeof hqFetch === 'function' ? hqFetch() : Promise.resolve(null)
  ]).then(function(res) {
    if (my !== fsState.req) return;
    fsState.busy = false;
    if (!fsState.open) return;

    var ov = res[0], fd = res[1];
    if (ov.error || !ov.data) {
      fsSetLive('stale');
      if (!fsState.data) {
        fsLegacyBasics();
        fsRenderError('Сводка фракции не загрузилась. Проверь связь и попробуй ещё раз.');
      }
      return;
    }

    var d = ov.data;
    if (!d.faction) {
      fsState.data = null;
      document.getElementById('faction-screen-name').textContent = 'Фракция ещё не назначена';
      document.getElementById('faction-screen-leader').textContent = '—';
      document.getElementById('fs-hero-chips').innerHTML = '';
      document.getElementById('fs-body').innerHTML = '<div class="fs-empty">Когда администратор назначит фракцию, здесь появится сводка войны.</div>';
      fsSetLive('ok');
      return;
    }

    var firstData = !fsState.data;
    fsState.data = d;
    fsState.feed = fd.error ? (fsState.feed || null) : (fd.data || []);
    fsState.loadedAt = Date.now();
    if (d.server_now) fsState.offset = new Date(d.server_now).getTime() - Date.now();

    currentPlayerFaction = d.faction;
    var isLeader = d.my_role === 'leader';
    var hasLeader = !!d.leader;
    var powers = d.my_powers || [];
    var powersKey = powers.slice().sort().join(',');
    var changed = isLeader !== currentPlayerIsLeader || hasLeader !== fsState.leader ||
                  powersKey !== currentPlayerPowers.slice().sort().join(',');
    currentPlayerIsLeader = isLeader;
    currentPlayerPowers = powers;
    fsState.leader = hasLeader;

    fsSetFaction(d.faction);
    fsPaintHeader();
    fsPaintActions();
    fsRender(firstData);
    fsSetLive('ok');

    var box = document.getElementById('faction-screen-box');
    if (box) box.classList.add('fs-ready');
    if (!fsState.ready || changed) {
      fsState.ready = true;
      if (typeof onFactionScreenReady === 'function') {
        onFactionScreenReady(isLeader, hasLeader, fsHasPower('planet_requests'));
      }
    } else if (fsHasPower('planet_requests') && typeof refreshPlanetRequestBadge === 'function') {
      refreshPlanetRequestBadge();
    }
  }, function() {
    if (my !== fsState.req) return;
    fsState.busy = false;
    if (!fsState.open) return;
    fsSetLive('stale');
    if (!fsState.data) {
      fsLegacyBasics();
      fsRenderError('Сводка фракции не загрузилась. Проверь связь и попробуй ещё раз.');
    }
  });
}

// Запасной путь: даже без сводки игрок должен видеть фракцию и лидера,
// а кнопки запроса планеты и панели управления — работать как раньше
function fsLegacyBasics() {
  if (fsState.ready) return;
  supabase.auth.getSession().then(function(res) {
    if (!res.data.session || !fsState.open) return;
    var userId = res.data.session.user.id;

    supabase.from('profiles').select('faction').eq('id', userId).maybeSingle().then(function(profileRes) {
      if (profileRes.error || !profileRes.data || !profileRes.data.faction) return;
      var faction = profileRes.data.faction;
      currentPlayerFaction = faction;
      fsSetFaction(faction);
      document.getElementById('faction-screen-name').textContent = FACTION_NAMES_PANEL[faction] || faction;

      supabase.from('faction_leadership').select('leader_user_id').eq('faction', faction).maybeSingle().then(function(lr) {
        var leaderId = (!lr.error && lr.data) ? lr.data.leader_user_id : null;
        var leaderEl = document.getElementById('faction-screen-leader');
        currentPlayerIsLeader = !!leaderId && leaderId === userId;
        fsPaintActions();
        var box = document.getElementById('faction-screen-box');
        if (box) box.classList.add('fs-ready');
        if (!fsState.ready) {
          fsState.ready = true;
          fsState.leader = !!leaderId;
          if (typeof onFactionScreenReady === 'function') {
            onFactionScreenReady(currentPlayerIsLeader, !!leaderId, currentPlayerIsLeader);
          }
        }
        if (!leaderId) { leaderEl.textContent = 'не назначен'; return; }
        supabase.from('profiles').select('nickname').eq('id', leaderId).maybeSingle().then(function(lp) {
          leaderEl.textContent = (lp.data && lp.data.nickname) || 'неизвестно';
        });
      });
    });
  });
}

// ── Открытие и закрытие ────────────────────────────────────────────

function openFactionScreen() {
  var screen = document.getElementById('faction-screen');
  if (!screen) return;

  document.getElementById('faction-screen-name').textContent = '...';
  document.getElementById('faction-screen-leader').textContent = '...';
  document.getElementById('fs-hero-chips').innerHTML = '';
  document.getElementById('faction-control-open-btn').style.display = 'none';
  ['fs-staff-btn', 'fs-economy-btn'].forEach(function(id) {
    var b = document.getElementById(id);
    if (b) b.style.display = 'none';
  });
  // Запрос планеты и список запросов появятся, когда станет ясно, лидер ли игрок
  var prSection = document.getElementById('pr-section');
  var prReview = document.getElementById('pr-review-btn');
  if (prSection) prSection.style.display = 'none';
  if (prReview) prReview.style.display = 'none';

  fsState.open = true;
  fsState.ready = false;
  fsState.data = null;
  fsState.feed = null;
  fsState.busy = false;
  fsState.feedAll = false;
  fsState.planetsAll = false;
  if (currentPlayerFaction) fsSetFaction(currentPlayerFaction);
  var supply = document.getElementById('fs-supply-btn');
  if (supply) supply.style.display = (typeof openSupplyScreen === 'function') ? 'flex' : 'none';

  fsSkeleton();
  var box = document.getElementById('faction-screen-box');
  if (box) { box.scrollTop = 0; box.classList.remove('fs-ready'); }
  screen.style.display = 'flex';

  fsLoad(true);

  clearInterval(fsState.refreshTimer);
  clearInterval(fsState.tickTimer);
  fsState.refreshTimer = setInterval(function() {
    // Вкладка спрятана — не тратим запросы, догоним при возврате
    if (!document.hidden) fsLoad(false);
  }, FS_REFRESH_MS);
  fsState.tickTimer = setInterval(fsTick, 1000);
}

function closeFactionScreen() {
  var screen = document.getElementById('faction-screen');
  if (screen) screen.style.display = 'none';
  fsState.open = false;
  fsState.req++;
  fsState.busy = false;
  clearInterval(fsState.refreshTimer);
  clearInterval(fsState.tickTimer);
  fsState.refreshTimer = null;
  fsState.tickTimer = null;
}

// Тап по планете: закрываем окно, ведём карту к ней и открываем карточку
function fsGoTo(systemId, withInfo) {
  closeFactionScreen();
  var ok = typeof focusGalaxySystem === 'function' && focusGalaxySystem(systemId);
  if (withInfo && typeof openPlanetInfo === 'function') {
    setTimeout(function() { openPlanetInfo(systemId); }, ok ? 450 : 0);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  var factionButton = document.getElementById('panel-item-faction');
  var closeBtn = document.getElementById('faction-screen-close');
  var controlBtn = document.getElementById('faction-control-open-btn');
  var supplyBtn = document.getElementById('fs-supply-btn');
  var screen = document.getElementById('faction-screen');
  var body = document.getElementById('fs-body');

  if (factionButton) factionButton.addEventListener('click', openFactionScreen);
  if (closeBtn) closeBtn.addEventListener('click', closeFactionScreen);

  // Тап по затемнению закрывает окно — привычное поведение на телефоне
  if (screen) {
    screen.addEventListener('click', function(e) {
      if (e.target === screen) closeFactionScreen();
    });
  }

  if (controlBtn) {
    controlBtn.addEventListener('click', function() {
      if (typeof openFactionControlScreen === 'function') {
        openFactionControlScreen();
      }
    });
  }

  if (supplyBtn) {
    supplyBtn.addEventListener('click', function() {
      if (typeof openSupplyScreen !== 'function') return;
      closeFactionScreen();
      openSupplyScreen();
    });
  }

  if (body) {
    body.addEventListener('click', function(e) {
      var t = e.target;
      while (t && t !== body && !(t.getAttribute && (t.getAttribute('data-act') || t.getAttribute('data-sys')))) {
        t = t.parentNode;
      }
      if (!t || t === body) return;
      var act = t.getAttribute('data-act');
      if (act === 'feed') { fsState.feedAll = !fsState.feedAll; fsRender(false); return; }
      if (act === 'planets') { fsState.planetsAll = !fsState.planetsAll; fsRender(false); return; }
      if (act === 'retry') { fsSkeleton(); fsLoad(true); return; }
      if (act === 'hq-dir' && typeof openHqDirective === 'function') { openHqDirective(); return; }
      if (act === 'hq-targets' && typeof openHqTargets === 'function') { openHqTargets(); return; }
      var sys = t.getAttribute('data-sys');
      if (sys) fsGoTo(sys, t.getAttribute('data-info') === '1');
    });
  }

  // Вернулся во вкладку с открытым окном — сразу освежаем
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && fsState.open && fsState.data && Date.now() - fsState.loadedAt > 10000) fsLoad(false);
  });
});
