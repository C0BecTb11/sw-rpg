// Абордаж: палубы цели, бойцы на борту, двери и тревога.
//
// Страница одна на обе стороны: атакующий видит свою группу в шлюзе,
// защитник — свою пехоту в трюме. Чужих бойцов видно только в отсеках,
// где стоят свои, и за открытыми дверями (туман считает сервер).
// План палуб — из deck_templates, тот же, что в документе. На телефоне
// корабль стоит носом вверх: левый борт слева, правый справа.

var bdId = null;          // абордаж
var bdState = null;       // ответ get_boarding
var bdTpl = null;         // { id, decks: [...] }
var bdDeck = 1;           // открытая палуба
var bdSel = null;         // выбранный боец (id)
var bdSelDoor = null;     // выбранная дверь (id) — подсветка на плане
var bdOffset = 0;         // серверное время минус локальное
var bdDk = null;          // открытая палуба из шаблона + разобранная сетка
var bdBusy = false;
var bdSeq = 0;
var bdFirst = true;
var bdToastTimer = null;
var bdShownEnd = false;

var BD_ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
var BD_DOOR_STATE = { open: 'открыта', closed: 'закрыта', locked: 'заперта', broken: 'выбита' };

function bdEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bdNow() { return Date.now() + bdOffset; }

function bdMine() { return bdState ? bdState.side : null; }

function bdUnits(deck) {
  if (!bdState) return [];
  return bdState.units.filter(function(u) { return deck === undefined || u.deck === deck; });
}

function bdUnitById(id) {
  if (!bdState) return null;
  for (var i = 0; i < bdState.units.length; i++) if (bdState.units[i].id === id) return bdState.units[i];
  return null;
}

// ---------- разбор шаблона ----------

function bdPrepDeck(dk) {
  if (dk._ready) return dk;
  // Зона и отсек каждой клетки — из строк сетки (буква = номер зоны)
  dk._zone = [];
  for (var y = 0; y < dk.h; y++) {
    var row = [];
    var line = dk.grid[y] || '';
    for (var x = 0; x < dk.w; x++) {
      var i = BD_ALPH.indexOf(line.charAt(x));
      row.push(i >= 0 ? i : -1);
    }
    dk._zone.push(row);
  }
  dk._zoneById = {};
  dk.zones.forEach(function(z, i) { z._i = i; dk._zoneById[z.id] = z; });
  dk._doorById = {};
  dk._edge = {};
  dk.doors.forEach(function(d) {
    dk._doorById[d.id] = d;
    dk._edge[bdEdgeKey(d.c1, d.c2)] = d;
  });
  dk._solid = {};
  (dk.blocks || []).forEach(function(b) {
    for (var bx = b[0]; bx < b[0] + b[2]; bx++) for (var by = b[1]; by < b[1] + b[3]; by++) dk._solid[bx + ':' + by] = 'block';
  });
  (dk.cover || []).forEach(function(c) { dk._solid[c[0] + ':' + c[1]] = 'cover'; });
  (dk.turrets || []).forEach(function(c) { dk._solid[c[0] + ':' + c[1]] = 'turret'; });
  (dk.hatches || []).forEach(function(h) { dk._solid[h.x + ':' + h.y] = dk._solid[h.x + ':' + h.y] || 'hatch'; });
  dk._ready = true;
  return dk;
}

function bdEdgeKey(a, b) {
  var p = a[0] + ',' + a[1], q = b[0] + ',' + b[1];
  return p < q ? p + '|' + q : q + '|' + p;
}

function bdZoneAt(dk, x, y) {
  if (y < 0 || y >= dk.h || x < 0 || x >= dk.w) return null;
  var i = dk._zone[y][x];
  return i >= 0 ? dk.zones[i] : null;
}

function bdAreaAt(dk, x, y) {
  var z = bdZoneAt(dk, x, y);
  return z ? z.area : null;
}

// ---------- отрисовка палубы ----------

function bdVisibleSet() {
  var s = {};
  (bdState.visible || []).forEach(function(v) { s[v.deck + ':' + v.zone] = true; });
  return s;
}

function bdDoorTitle(dk, d) {
  var z1 = dk._zoneById[d.z1], z2 = dk._zoneById[d.z2];
  var name = function(z) { return z && z.label ? z.label : (z && z.kind === 'lock' ? 'шлюз' : 'коридор'); };
  if (d.kind === 'lock') return 'Дверь шлюза';
  if (d.kind === 'blast') {
    var goal = (z1 && z1.kind === 'goal') ? z1 : (z2 && z2.kind === 'goal') ? z2 : null;
    return goal ? 'Бронедверь: ' + goal.label : 'Переборка коридора';
  }
  var a = name(z1), b = name(z2);
  if (a === b) return 'Дверь: ' + a;
  return 'Дверь: ' + a + ' — ' + b;
}

function bdDoorState(d) {
  if (d.kind === 'lift') return 'open';
  return (bdState.doors && bdState.doors[d.id]) || 'open';
}

// План палубы рисует js/boarding-deck.js. place: 'mine' — камера к своим бойцам
function bdRender(place) {
  if (!bdState || !bdTpl) return;
  bdDk = bdPrepDeck(bdTpl.decks[bdDeck - 1]);
  var foe = bdState.defender || {};
  bdcSetDeck(bdDk, foe.faction || 'other', place || null);
  bdSyncOverlay();
  bdcDirty();
}

// После загрузки: выбранная клетка и цель ещё годятся?
function bdCheckOrders() {
  var u = bdActor();
  if (!u) { bdClearOrders(); return; }
  if (bdPlan) {
    var r = bdPlan.unit === u.id ? bdReachFor(u) : null, path = r ? bdrPath(r, bdPlan.x, bdPlan.y) : null;
    if (!path) bdPlan = null;
    else { bdPlan.path = path; bdPlan.cost = Math.ceil(path.length / bdMr(u)); }
  }
  if (bdAim) {
    var ok = bdAim.unit === u.id && bdTargetsFor(u).some(function(t) { return t.key === bdAim.key; });
    if (!ok) bdAim = null;
  }
}

// ---------- шапка, вкладки, нижняя панель ----------

// Где группа атакующих: 'in' — кто-то уже прошёл на борт, 'open' — все в шлюзе,
// но его дверь открыта или выбита, 'lock' — заперты в шлюзе
function bdAttWhere() {
  var where = 'lock';
  bdState.units.forEach(function(x) {
    if (x.side !== 'att' || where === 'in') return;
    var dk = bdPrepDeck(bdTpl.decks[x.deck - 1]), z = bdZoneAt(dk, x.x, x.y);
    if (!z || z.kind !== 'lock') { where = 'in'; return; }
    (dk.doors || []).forEach(function(d) {
      if (d.kind !== 'lock' || bdDoorState(d) === 'closed' || bdDoorState(d) === 'locked') return;
      if (bdZoneAt(dk, d.c1[0], d.c1[1]) === z || bdZoneAt(dk, d.c2[0], d.c2[1]) === z) where = 'open';
    });
  });
  return where;
}

function bdPortDeck() {
  for (var i = 0; i < bdTpl.decks.length; i++) if ((bdTpl.decks[i].ports || []).length) return i + 1;
  return 1;
}

function bdHoldDeck() {
  for (var i = 0; i < bdTpl.decks.length; i++) {
    if (bdTpl.decks[i].zones.some(function(z) { return z.role === 'hold'; })) return i + 1;
  }
  return bdTpl.decks.length;
}

function bdRenderTop() {
  var top = document.getElementById('bd-top');
  var s = bdState, att = s.side === 'att';
  var foe = att ? s.defender : s.attacker;
  var own = att ? s.attacker : s.defender;
  var left = Math.max(0, Math.floor((new Date(s.ends_at).getTime() - bdNow()) / 1000));
  var active = s.status === 'active';
  top.className = 'bd-top ' + (att ? 'att' : 'def');
  top.innerHTML =
    '<div class="bd-top-row">' +
      '<span class="bd-side">' + (att ? 'Абордаж · атака' : 'Абордаж · оборона') + '</span>' +
      (active && s.alarm ? '<span class="bd-alarm">Тревога</span>' : '') +
      '<span class="bd-timer' + (left < 300 && active ? ' warn' : '') + '" id="bd-timer">' + (active ? bdClock(left) : 'окончен') + '</span>' +
    '</div>' +
    bdgTopHtml() +
    '<div class="bd-ships">' +
      '<div class="bd-ship own">' + bdShipPic(own) + '<div><b>' + bdEsc(own.name) + '</b><i>' + bdEsc(own.player || '') + '</i></div></div>' +
      '<span class="bd-vs">⟫⟪</span>' +
      '<div class="bd-ship foe">' + bdShipPic(foe) + '<div><b>' + bdEsc(foe.name) + '</b><i>' + bdEsc(foe.player || '') + '</i></div></div>' +
    '</div>';
}

function bdShipPic(sh) {
  return sh && sh.image ? '<span class="bd-ship-pic"><img src="../' + bdEsc(sh.image) + '" alt=""></span>' : '<span class="bd-ship-pic"></span>';
}

function bdClock(sec) {
  var m = Math.floor(sec / 60), s = sec % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function bdRenderTabs() {
  var tabs = document.getElementById('bd-tabs');
  var pd = bdPortDeck(), hd = bdHoldDeck();
  var html = '';
  bdTpl.decks.forEach(function(dk, i) {
    var n = i + 1;
    var mine = 0, foe = 0;
    bdState.units.forEach(function(u) {
      if (u.deck !== n) return;
      if (u.side === bdMine()) mine++; else foe++;
    });
    var tag = n === pd ? 'шлюзы' : n === hd ? 'трюм' : '';
    html += '<button class="bd-tab' + (n === bdDeck ? ' active' : '') + '" data-deck="' + n + '">' +
      '<span class="bd-tab-n">П' + n + '</span>' +
      '<span class="bd-tab-name">' + bdEsc(dk.name) + (tag ? ' · ' + tag : '') + '</span>' +
      '<span class="bd-tab-dots">' + (mine ? '<i class="m">' + mine + '</i>' : '') + (foe ? '<i class="f">' + foe + '</i>' : '') + '</span>' +
    '</button>';
  });
  tabs.innerHTML = html;
}

function bdAdjDoors(u) {
  var dk = bdPrepDeck(bdTpl.decks[u.deck - 1]);
  return dk.doors.filter(function(d) {
    if (d.kind === 'lift') return false;
    return (d.c1[0] === u.x && d.c1[1] === u.y) || (d.c2[0] === u.x && d.c2[1] === u.y);
  });
}

// Что этот боец может сделать с дверью: [{ act, label, cost }]
function bdDoorActs(d, u) {
  var st = bdDoorState(d), side = bdMine(), acts = [];
  if (st === 'broken') return acts;
  if (d.kind === 'door') {
    if (st === 'open') { acts.push({ act: 'close', label: 'Закрыть', cost: 1 }); acts.push({ act: 'lock', label: 'Запереть', cost: 1 }); }
    if (st === 'closed') { acts.push({ act: 'open', label: 'Открыть', cost: 0 }); acts.push({ act: 'lock', label: 'Запереть', cost: 1 }); }
    if (st === 'locked') {
      if (side === 'def') acts.push({ act: 'open', label: 'Отпереть', cost: 1 });
      acts.push({ act: 'breach', label: 'Выбить', cost: 1 });
    }
  } else {
    if (side === 'def') {
      if (st === 'locked') acts.push({ act: 'open', label: 'Открыть', cost: 1 });
      if (st === 'open') acts.push({ act: 'close', label: 'Запереть', cost: 1 });
    } else if (st === 'locked') {
      acts.push({ act: 'breach', label: d.kind === 'lock' ? 'Вскрыть' : 'Взломать', cost: u && u.engineer ? 1 : 2 });
    }
  }
  return acts;
}

function bdApDots(u) {
  var max = u.ap_max || 2, ap = u.ap || 0, s = '';
  for (var i = 0; i < max; i++) s += '<i class="' + (i < ap ? 'on' : '') + '"></i>';
  return s;
}

function bdRenderHud() {
  var hud = document.getElementById('bd-hud');
  var s = bdState, att = s.side === 'att';
  var u = bdSel ? bdUnitById(bdSel) : null;
  var html = '';

  if (u && u.mine) {
    var pct = u.max_hp ? Math.round(100 * u.hp / u.max_hp) : 100;
    html += '<div class="bd-card mine">' +
      '<span class="bd-card-pic">' + (u.image ? '<img src="../' + bdEsc(u.image) + '" alt="">' : '') + '</span>' +
      '<div class="bd-card-body">' +
        '<div class="bd-card-name">' + bdEsc(u.name) + '</div>' +
        '<div class="bd-card-sub">' + bdEsc(u.engineer && att ? 'Инженер · взлом за 1 действие' : u.type_name) + ' · П' + u.deck + '</div>' +
        '<div class="bd-card-hp"><span>' + u.hp + ' / ' + u.max_hp + '</span><i><b style="width:' + pct + '%"></b></i></div>' +
        '<div class="bd-card-ap"><span class="bd-dots">' + bdApDots(u) + '</span><em id="bd-ap-next">' + bdApText(u) + '</em></div>' +
      '</div>' +
      '<button class="bd-x" data-act="unsel" aria-label="Закрыть">✕</button>' +
    '</div>';

    html += bdOrdersHtml(u);

    var doors = bdAdjDoors(u);
    if (doors.length && s.status === 'active') {
      html += '<div class="bd-sec">Двери рядом</div>';
      doors.forEach(function(d) {
        var dk = bdPrepDeck(bdTpl.decks[u.deck - 1]);
        var st = bdDoorState(d), acts = bdDoorActs(d, u);
        html += '<div class="bd-door-row' + (bdSelDoor === d.id ? ' sel' : '') + '" data-door-row="' + d.id + '">' +
          '<div class="bd-door-name"><i class="bd-door-ico k-' + d.kind + ' s-' + st + '"></i>' + bdEsc(bdDoorTitle(dk, d)) +
            '<em>' + BD_DOOR_STATE[st] + '</em></div>' +
          '<div class="bd-door-acts">' + (acts.length ? acts.map(function(a) {
            var short = a.cost > (u.ap || 0);
            return '<button class="bd-btn' + (a.act === 'breach' ? ' hot' : '') + '"' + (short ? ' disabled' : '') +
              ' data-act="door" data-door="' + d.id + '" data-do="' + a.act + '">' + a.label +
              '<small>' + (a.cost ? a.cost + ' д.' : 'свободно') + '</small></button>';
          }).join('') : '<span class="bd-door-none">' + (st === 'broken' ? 'не закрывается' : 'не твоя дверь') + '</span>') + '</div>' +
        '</div>';
      });
    }
  } else if (u) {
    var pct2 = u.max_hp ? Math.round(100 * u.hp / u.max_hp) : 100;
    html += '<div class="bd-card foe">' +
      '<span class="bd-card-pic">' + (u.image ? '<img src="../' + bdEsc(u.image) + '" alt="">' : '') + '</span>' +
      '<div class="bd-card-body">' +
        '<div class="bd-card-name">' + bdEsc(u.name) + '</div>' +
        '<div class="bd-card-sub">' + (u.side === bdMine() ? 'Союзник' : 'Противник') + ' · ' + bdEsc(u.type_name) + ' · П' + u.deck + '</div>' +
        '<div class="bd-card-hp"><span>' + u.hp + ' / ' + u.max_hp + '</span><i><b style="width:' + pct2 + '%"></b></i></div>' +
      '</div>' +
      '<button class="bd-x" data-act="unsel" aria-label="Закрыть">✕</button>' +
    '</div>';
  } else {
    var mineN = s.units.filter(function(x) { return x.side === s.side; }).length;
    var seen = s.units.filter(function(x) { return x.side !== s.side; }).length;
    html += '<div class="bd-sum">' +
      '<div class="bd-stat"><b>' + mineN + '</b><span>' + (att ? 'в абордаже' : 'защитников') + '</span></div>' +
      (att ? '<div class="bd-stat"><b>' + s.reserve + '</b><span>в своём трюме</span></div>' : '') +
      '<div class="bd-stat ' + (seen ? 'foe' : '') + '"><b>' + seen + '</b><span>врагов видно</span></div>' +
      (!att && s.vehicles ? '<div class="bd-stat dim"><b>' + s.vehicles + '</b><span>техника стоит</span></div>' : '') +
    '</div>';
    if (s.status === 'active') {
      var where = att ? bdAttWhere() : '';
      html += '<div class="bd-note">' + (att
        ? (where === 'in' || !mineN
          ? 'Группа на борту. Коснись бойца: зелёные клетки — ход за одно действие, жёлтые — за два, враг в рамке — выстрел.'
          : where === 'open'
            ? 'Дверь шлюза вскрыта. Коснись бойца и клетки за дверью — группа пойдёт на борт.'
            : 'Группа в шлюзе. Внутренняя дверь заперта по тревоге — коснись бойца у двери и вскрой её.')
        : 'Держи мостик и реактор: враг на мостике 3 минуты — корабль его, заряд в реакторе не сняли за 5 — корабль взорван. Турели бьют по чужим сами.') +
        '</div>';
    }
    html += bdgDefHtml();
    html += bdReinfHtml();
    html += bdgPanelHtml();
  }

  if (s.status === 'active' && att) {
    html += '<button class="bd-retreat" data-act="retreat">Отход · вернуть бойцов в трюм</button>';
  }
  hud.innerHTML = html;
  bdLayout();
}

function bdApText(u) {
  if (!u || u.ap === null || u.ap === undefined) return '';
  if (u.ap >= (u.ap_max || 2)) return 'действия готовы';
  var left = Math.max(0, (u._nextAt || 0) - Date.now());
  return '+1 через ' + Math.ceil(left / 1000) + ' с';
}

// Высоты шапки и панели — карте остаётся середина.
// Телефон боком: панель уходит вправо на всю высоту, карта — слева
function bdLayout() {
  var view = document.getElementById('bd-view');
  var top = document.getElementById('bd-top'), tabs = document.getElementById('bd-tabs'), hud = document.getElementById('bd-hud');
  var land = window.innerWidth > window.innerHeight && window.innerHeight < 560;
  document.body.classList.toggle('bd-land', land);
  var hudW = land ? Math.round(Math.min(340, Math.max(260, window.innerWidth * 0.4))) : 0;
  document.body.style.setProperty('--bd-hud-w', hudW + 'px');
  tabs.style.top = Math.round(top.getBoundingClientRect().bottom + (land ? 4 : 6)) + 'px';
  var t = tabs.getBoundingClientRect().bottom + 4;
  var b = land ? 0 : hud.getBoundingClientRect().height + 4;
  view.style.top = Math.round(t) + 'px';
  view.style.bottom = Math.round(b) + 'px';
  view.style.right = hudW + 'px';
  var zoom = document.getElementById('bd-zoom');
  if (zoom) { zoom.style.bottom = Math.round(b + 10) + 'px'; zoom.style.right = (hudW + 14) + 'px'; }
  var toast = document.getElementById('bd-toast');
  if (toast) toast.style.bottom = Math.round(b + 14) + 'px';
  bdcResize();
}

// ---------- загрузка и обновления ----------

function bdLoad(keepView) {
  var my = ++bdSeq;
  return supabase.rpc('get_boarding', { p_id: bdId }).then(function(res) {
    if (my !== bdSeq) return;
    if (res.error || !res.data) { bdFail(res.error ? res.error.message : 'Абордаж не найден'); return; }
    var s = res.data;
    var prevById = {};
    if (bdState) bdState.units.forEach(function(u) { prevById[u.id] = u; });
    bdOffset = new Date(s.server_now).getTime() - Date.now();
    s.units.forEach(function(u) {
      if (u.next_in !== null && u.next_in !== undefined) u._nextAt = Date.now() + u.next_in * 1000;
    });
    bdState = s;
    // Ход уже показан, ответ сервера ещё в пути — не дёргаем бойца назад
    if (bdPendingMove) {
      var pu = bdUnitById(bdPendingMove.id);
      if (pu) { pu.x = bdPendingMove.x; pu.y = bdPendingMove.y; }
    }
    if (bdSel && !bdUnitById(bdSel)) { bdSel = null; bdSelDoor = null; }
    var ready = bdTpl && bdTpl.id === s.template ? Promise.resolve() : bdLoadTemplate(s.template);
    return ready.then(function() {
      if (!bdTpl) return;
      if (bdFirst) {
        bdFirst = false;
        var mine = s.units.filter(function(u) { return u.side === s.side; });
        bdDeck = mine.length ? mine[0].deck : (s.side === 'att' ? bdPortDeck() : bdHoldDeck());
        bdSetLoaderName(s);
      }
      bdCheckOrders();
      bdReinfClamp();
      bdgDefClamp();
      bdPaint(!keepView);
      if (bdFocusAfter) {
        var fu = bdUnitById(bdFocusAfter);
        if (fu && fu.deck === bdDeck) { bdcFocusUnit(fu); bdFocusAfter = null; }
        else if (!fu) bdFocusAfter = null;
      }
      bdPlayFx(s, prevById);
      if (window.sceneLoader) sceneLoader.mark('state');
      if (s.status !== 'active') bdShowEnd();
    });
  });
}

function bdLoadTemplate(id) {
  return supabase.from('deck_templates').select('id, decks').eq('id', id).maybeSingle().then(function(res) {
    if (res.error || !res.data) { bdFail('План палуб не загрузился'); return; }
    bdTpl = res.data;
    if (window.sceneLoader) sceneLoader.mark('plan');
  });
}

function bdSetLoaderName(s) {
  var el = document.querySelector('#scene-loader .sl-name');
  if (el) el.textContent = '«' + (s.side === 'att' ? s.defender.name : s.attacker.name) + '»';
  var pic = document.querySelector('#scene-loader .bd-sl-ship');
  var sh = s.side === 'att' ? s.defender : s.attacker;
  if (pic && sh && sh.image) pic.style.backgroundImage = 'url(../' + sh.image + ')';
  var ld = document.getElementById('scene-loader');
  if (ld) ld.classList.add(s.side === 'att' ? 'sl-cis' : 'sl-republic');
}

// toMine: камера к своим бойцам на открытой палубе (первый вход, смена палубы)
function bdPaint(toMine) {
  bdRenderTop();
  bdRenderTabs();
  bdRenderHud();
  bdRender(toMine ? 'mine' : null);
}

function bdFail(msg) {
  if (window.sceneLoader) sceneLoader.hide();
  var box = document.getElementById('bd-end');
  box.innerHTML = '<div class="bd-end-card">' +
    '<div class="bd-end-kicker">Абордаж</div>' +
    '<div class="bd-end-title">' + bdEsc(msg) + '</div>' +
    '<button class="bd-btn wide" data-act="galaxy">На карту галактики</button></div>';
  box.classList.add('open');
}

var BD_END = {
  withdrawn: { att: ['Отход', 'Бойцы вернулись в свой трюм.'], def: ['Абордаж отбит', 'Противник отступил со всей группой.'] },
  timeout:   { att: ['Время вышло', 'Тридцать минут прошли — группа вернулась в трюм.'], def: ['Абордаж отбит', 'Время вышло, противник отошёл.'] },
  repelled:  { att: ['Абордаж отбит', 'Вся абордажная группа погибла на борту.'], def: ['Абордаж отбит', 'Группа противника уничтожена.'] },
  captured:  { att: ['Корабль захвачен', 'Мостик удержан — корабль теперь твой трофей.'], def: ['Корабль потерян', 'Противник удержал мостик: корабль ушёл к нему, экипаж и всё в трюме погибли.'] },
  destroyed: { att: ['Корабль взорван', 'Заряд в реакторе сработал. Кто не успел в шлюз — погиб вместе с кораблём.'], def: ['Корабль погиб', 'Заряд в реакторе не сняли — корабль взорван вместе с экипажем.'] },
  broken:    { att: ['Абордаж прерван', ''], def: ['Абордаж прерван', ''] }
};

function bdShowEnd() {
  if (bdShownEnd) return;
  bdShownEnd = true;
  var s = bdState;
  var t = (BD_END[s.status] || BD_END.broken)[s.side];
  var why = s.status === 'broken'
    ? (s.result === 'target_lost' ? 'Корабль-цель уничтожен.' : s.result === 'attacker_lost' ? 'Корабль атакующего уничтожен.' : 'Корабли расцепились.')
    : t[1];
  var good = (s.side === 'def' && (s.status === 'withdrawn' || s.status === 'timeout' || s.status === 'repelled'))
          || (s.side === 'att' && (s.status === 'captured' || s.status === 'destroyed'));
  var trophy = s.status === 'captured' && s.side === 'att'
    ? '<div class="bd-end-trophy"><b>Трофей «' + bdEsc(s.defender.name) + '»</b>' +
      '<span>Корпус не выше 25%, щиты выключены, ход и урон вдвое ниже, прыжки закрыты на 12 часов. ' +
      'Ремонт в своём доке снимет всё это, но обойдётся дороже обычного; на верфи трофей можно разобрать на 40% сырья.' +
      (s.defender.faction !== s.attacker.faction ? ' Чужую модель в бой вводить можно, улучшать — нет.' : '') + '</span></div>'
    : '';
  var box = document.getElementById('bd-end');
  box.innerHTML = '<div class="bd-end-card ' + (good ? 'good' : '') + ' ' + bdEsc(s.status) + '">' +
    '<div class="bd-end-kicker">Абордаж окончен</div>' +
    '<div class="bd-end-title">' + bdEsc(t[0]) + '</div>' +
    '<div class="bd-end-text">' + bdEsc(why) + '</div>' +
    bdgStatsHtml(s) + trophy +
    '<button class="bd-btn wide" data-act="orbit">' + (s.status === 'captured' && s.side === 'att' ? 'К трофею на орбиту' : 'На орбиту') + '</button></div>';
  box.classList.add('open');
}

function bdToast(msg, bad) {
  var el = document.getElementById('bd-toast');
  el.textContent = msg;
  el.className = 'show' + (bad ? ' bad' : '');
  if (bdToastTimer) clearTimeout(bdToastTimer);
  bdToastTimer = setTimeout(function() { el.className = ''; }, 2600);
}

function bdOrbitUrl() {
  var s = bdState;
  if (!s) return 'galaxy-map.html';
  var own = s.side === 'att' ? s.attacker : s.defender;
  var ship = own && own.ship_id;
  // После захвата — к трофею; потерянного корабля на орбите уже нет
  if (s.status === 'captured' && s.side === 'att') ship = s.defender.ship_id;
  if ((s.status === 'captured' || s.status === 'destroyed') && s.side === 'def') ship = null;
  return 'space-battle.html?system=' + encodeURIComponent(s.system_id) +
    (ship ? '&ship=' + encodeURIComponent(ship) : '');
}

// ---------- приказы ----------

function bdDoor(doorId, act) {
  if (bdBusy || !bdSel) return;
  bdBusy = true;
  var u = bdUnitById(bdSel);
  bdRpc('boarding_door', { p_boarding_id: bdId, p_unit_id: bdSel, p_door: doorId, p_action: act }).then(function(res) {
    bdBusy = false;
    if (res.error) { bdToast(res.error.message, true); bdLoad(true); return; }
    var word = { broken: act === 'breach' ? 'Дверь вскрыта' : 'Выбита', open: 'Открыта', closed: 'Закрыта', locked: 'Заперта', timeout: 'Время вышло' }[res.data] || 'Готово';
    bdToast(word + (u ? ' · ' + u.name : ''));
    bdLoad(true);
  });
}

function bdRetreat() {
  var s = bdState;
  var n = s.units.filter(function(u) { return u.side === 'att'; }).length;
  var go = function() {
    if (bdBusy) return;
    bdBusy = true;
    bdRpc('boarding_withdraw', { p_id: bdId }).then(function(res) {
      bdBusy = false;
      if (res.error) { bdToast(res.error.message, true); return; }
      bdLoad(true);
    });
  };
  if (typeof gameConfirm !== 'function') { go(); return; }
  gameConfirm({
    tone: 'danger',
    kicker: 'Отход',
    title: 'Вернуть бойцов в трюм?',
    image: s.defender.image ? '../' + s.defender.image : null,
    sub: '«' + s.defender.name + '» · на борту ' + n,
    note: 'Бойцы у шлюза вернутся в свой трюм, абордаж закончится. Начать новый можно сразу.',
    ok: 'Отходим', cancel: 'Остаёмся'
  }, go);
}

// Касание плана (js/boarding-deck.js): { unit } | { door } | { cell }
function bdOnMapTap(hit) {
  if (!bdState || !bdTpl) return;
  // Ход и выстрел выбранного бойца
  if (bdOrderTap(hit)) return;
  if (hit.turret) {
    var ts = null;
    (bdState.turrets || []).forEach(function(t) { if (t.k === hit.turret) ts = t; });
    bdToast(ts && ts.hp <= 0 ? 'Турель разбита' : 'Турель защиты · ' + (ts ? ts.hp + '/' + ts.max : '') + ' · бьёт на 5 клеток');
    return;
  }
  if (hit.unit) {
    var id = hit.unit;
    bdSel = bdSel === id ? null : id;
    bdSelDoor = null;
    bdClearOrders();
    bdRenderHud(); bdSyncOverlay();
    if (bdSel) bdcFocusUnit(bdUnitById(bdSel));
    return;
  }
  if (hit.door) {
    var did = hit.door;
    var u = bdSel ? bdUnitById(bdSel) : null;
    var near = u && u.mine && bdAdjDoors(u).some(function(d) { return d.id === did; });
    var dk = bdPrepDeck(bdTpl.decks[bdDeck - 1]);
    var d = dk._doorById[did];
    if (!near) {
      bdToast(bdDoorTitle(dk, d) + ' · ' + BD_DOOR_STATE[bdDoorState(d)] + (u && u.mine ? ' · боец не у двери' : ''));
      return;
    }
    bdSelDoor = did;
    bdClearOrders();
    bdRenderHud(); bdSyncOverlay();
    return;
  }
  if (bdPlan || bdAim) { bdClearOrders(); bdRenderHud(); bdSyncOverlay(); return; }
  if (bdSel) { bdSel = null; bdSelDoor = null; bdRenderHud(); bdSyncOverlay(); }
}

function bdHudClick(e) {
  var b = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!b || b.disabled) return;
  if (bdOrdersClick(b)) return;
  if (bdgClick(b)) return;
  var act = b.getAttribute('data-act');
  if (act === 'unsel') { bdSel = null; bdSelDoor = null; bdClearOrders(); bdRenderHud(); bdSyncOverlay(); }
  else if (act === 'door') bdDoor(b.getAttribute('data-door'), b.getAttribute('data-do'));
  else if (act === 'retreat') bdRetreat();
  else if (act === 'orbit') location.href = bdOrbitUrl();
  else if (act === 'galaxy') location.href = 'galaxy-map.html';
}

// Каждую секунду: часы и «+1 через N с» у выбранного бойца
function bdTick() {
  if (!bdState) return;
  bdgTick();
  var el = document.getElementById('bd-timer');
  if (el && bdState.status === 'active') {
    var left = Math.max(0, Math.floor((new Date(bdState.ends_at).getTime() - bdNow()) / 1000));
    el.textContent = bdClock(left);
    el.classList.toggle('warn', left < 300);
    if (left === 0) bdLoad(true);
  }
  var u = bdSel ? bdUnitById(bdSel) : null;
  if (u && u.mine && u.ap < (u.ap_max || 2)) {
    if (u._nextAt && Date.now() >= u._nextAt) {
      // Действие восстановилось — перечитываем, сервер даст точное число
      u._nextAt = null; bdLoad(true); return;
    }
    var t = document.getElementById('bd-ap-next');
    if (t) t.textContent = bdApText(u);
  }
}

function bdInit() {
  var qs = new URLSearchParams(location.search);
  bdId = qs.get('id');
  document.getElementById('bd-back').addEventListener('click', function() { location.href = bdOrbitUrl(); });
  bdcInit(document.getElementById('bd-view'), bdOnMapTap);
  BDC.onDrag = bdDrag;
  document.getElementById('bd-hud').addEventListener('click', bdHudClick);
  document.getElementById('bd-end').addEventListener('click', bdHudClick);
  document.getElementById('bd-tabs').addEventListener('click', function(e) {
    var b = e.target.closest ? e.target.closest('[data-deck]') : null;
    if (!b) return;
    var n = +b.getAttribute('data-deck');
    if (n === bdDeck) return;
    bdDeck = n;
    bdSelDoor = null;
    bdClearOrders();
    bdPaint(true);
  });
  // Вся палуба ↔ крупно к своим
  document.getElementById('bd-zoom').addEventListener('click', function() {
    if (!bdState || !bdTpl) return;
    bdcToggleZoom();
  });
  var rt = null;
  window.addEventListener('resize', function() {
    if (rt) clearTimeout(rt);
    rt = setTimeout(function() { if (bdState && bdTpl) { bdPaint(false); bdcResize(); } }, 150);
  });

  if (!bdId) { bdFail('Абордаж не указан'); return; }
  if (window.sceneLoader) sceneLoader.expect([['plan', 'План палуб'], ['state', 'Бойцы на борту']]);

  sbSessionGate().then(function() {
    bdLoad(false);
    // Двери, тревога, итог: сервер меняет строку абордажа — перечитываем
    var soon = null;
    supabase.channel('boarding-' + bdId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'boardings', filter: 'id=eq.' + bdId }, function() {
        if (soon) clearTimeout(soon);
        soon = setTimeout(function() { bdLoad(true); }, 200);
      })
      .subscribe();
    // Запасной опрос: реалтайм мог уснуть вместе со вкладкой
    setInterval(function() { if (!document.hidden && bdState && bdState.status === 'active') bdLoad(true); }, 15000);
    document.addEventListener('visibilitychange', function() { if (!document.hidden) bdLoad(true); });
    setInterval(bdTick, 1000);
  });
}

document.addEventListener('DOMContentLoaded', bdInit);
