// Абордаж: приказы бойцам на палубе — ход, выстрел, «На чеку», лифт, люк,
// лаз, подкрепление. Подсветка, куда дойдёт и в кого попадёт выбранный
// боец, и разбор событий боя для анимаций (js/boarding-fx.js).
//
// Ход и выстрел — в два касания: первое показывает путь или прицел с
// шансом, второе (или кнопка в панели) отдаёт приказ. Бойца можно и
// перетащить пальцем — как на земле.

var bdPlan = null;        // { unit, x, y, path, cost } — выбранная клетка хода
var bdAim = null;         // { unit, key, target | turret } — выбранная цель
var bdFxSeen = -1;        // последнее показанное событие боя
var bdReachMemo = null;   // { key, r } — досягаемость выбранного бойца
var bdReinf = null;       // { counts: {type: n} } — открыт выбор подкрепления
var bdMoved = {};         // свои ходы, уже показанные анимацией: unit → время
var bdPendingMove = null; // { id, x, y } — ход отдан, сервер ещё не ответил
var bdFocusAfter = null;  // боец, к которому вести камеру после загрузки (лифт, люк, высадка)

// Вызов сервера, который никогда не «повисает»: обрыв связи — та же ошибка
function bdRpc(name, args) {
  return supabase.rpc(name, args).then(null, function() {
    return { data: null, error: { message: 'Нет связи с сервером' } };
  });
}

// Шаг хода и дальность огня — как на сервере: нет скорости — боец не ходит,
// нет одной из дальностей — берётся другая
function bdMr(u) { return u.mr === null || u.mr === undefined ? 4 : u.mr; }
function bdRangeOf(u) {
  var v = u.vr, w = u.wr;
  if (v === null || v === undefined) return w || 0;
  if (w === null || w === undefined) return v || 0;
  return Math.min(v, w);
}

function bdActive() { return bdState && bdState.status === 'active'; }

// Свой выбранный боец на открытой палубе, которому можно отдавать приказы
function bdActor() {
  if (!bdActive() || !bdSel) return null;
  var u = bdUnitById(bdSel);
  return u && u.mine && u.deck === bdDeck ? u : null;
}

function bdOcc(deck) {
  var o = {};
  bdUnits(deck).forEach(function(u) { o[u.x + ',' + u.y] = u.side; });
  return o;
}

function bdGeoFor(deck) {
  return bdrGeo(bdPrepDeck(bdTpl.decks[deck - 1]));
}

// Куда дойдёт боец за готовые действия (не больше двух)
function bdReachFor(u) {
  var ap = Math.min(u.ap || 0, 2), mr = bdMr(u);
  if (ap < 1 || mr <= 0) return null;
  var key = [u.id, u.deck, u.x, u.y, ap, mr, bdState.rev, bdState.units.length].join('|');
  if (bdReachMemo && bdReachMemo.key === key) return bdReachMemo.r;
  var r = bdrReach(bdGeoFor(u.deck), bdState.doors, u.x, u.y, ap * mr, bdOcc(u.deck), u.side);
  bdReachMemo = { key: key, r: r };
  return r;
}

// По кому боец может выстрелить прямо сейчас
function bdTargetsFor(u) {
  var out = [];
  var reach = u ? bdRangeOf(u) : 0;
  if (u && bdgDark(u.deck)) reach = Math.min(reach, 2);
  if (!u || (u.ap || 0) < 1 || reach <= 0 || !(u.dmg > 0)) return out;
  var arm = bdgEff().armory === u.side ? 1.15 : 1;
  var g = bdGeoFor(u.deck), acc = u.acc === null || u.acc === undefined ? 75 : u.acc;
  var ok = function(x, y) {
    return Math.max(Math.abs(x - u.x), Math.abs(y - u.y)) <= reach && bdrLos(g, bdState.doors, u.x, u.y, x, y);
  };
  bdUnits(u.deck).forEach(function(t) {
    if (t.side === u.side || !ok(t.x, t.y)) return;
    var cover = bdrCover(g, u.x, u.y, t.x, t.y);
    out.push({ key: t.id, target: t.id, x: t.x, y: t.y, cover: cover,
               chance: Math.max(5, Math.min(95, acc - (t.eva || 0))),
               dmg: Math.max(1, Math.round(Math.max(1, Math.round((u.dmg || 0) * (100 - cover) / 100)) * arm)),
               name: t.name, hp: t.hp, max: t.max_hp, image: t.image });
  });
  if (u.side === 'att') {
    (bdState.turrets || []).forEach(function(t) {
      if (t.deck !== u.deck || t.hp <= 0 || !ok(t.x, t.y)) return;
      out.push({ key: t.k, turret: t.k, x: t.x, y: t.y, cover: 0, chance: Math.max(5, Math.min(95, acc)),
                 dmg: Math.max(1, Math.round((u.dmg || 0) * arm)), name: 'Турель', hp: t.hp, max: t.max });
    });
  }
  return out;
}

// Подсветка для холста: досягаемость, путь, прицелы
function bdSyncOverlay() {
  if (typeof bdcSetOverlay !== 'function') return;
  var u = bdActor();
  if (!u || bdBusy) { bdcSetOverlay(bdAim && u ? { targets: bdTargetsFor(u), aim: bdAim.key } : null); return; }
  var r = bdReachFor(u), cells = [];
  if (r) {
    var mr = bdMr(u);
    for (var k in r.dist) {
      if (!r.dist.hasOwnProperty(k) || !r.dist[k]) continue;
      var x = k % r.w, y = (k - x) / r.w;
      if (r.occ[x + ',' + y]) continue;
      cells.push([x, y, Math.ceil(r.dist[k] / mr)]);
    }
  }
  var plan = bdPlan && bdPlan.unit === u.id ? { from: [u.x, u.y], path: bdPlan.path, cost: bdPlan.cost } : null;
  bdcSetOverlay({ reach: { cells: cells }, plan: plan, targets: bdTargetsFor(u), aim: bdAim && bdAim.unit === u.id ? bdAim.key : null });
}

function bdClearOrders() { bdPlan = null; bdAim = null; bdgVent = null; }

// ---------- касания по палубе ----------

// true — касание разобрано здесь (ход, прицел, выстрел)
function bdOrderTap(hit) {
  var u = bdActor();
  if (!u) return false;
  var key = hit.unit || hit.turret || null;
  if (key) {
    var t = null;
    bdTargetsFor(u).forEach(function(x) { if (x.key === key) t = x; });
    if (t) {
      if (bdAim && bdAim.key === key && bdAim.unit === u.id) { bdShoot(); return true; }
      bdAim = { unit: u.id, key: key, target: t.target || null, turret: t.turret || null };
      bdPlan = null;
      bdSelDoor = null;
      bdRenderHud(); bdSyncOverlay();
      bdcKeepInView([[u.x, u.y], [t.x, t.y]]);
      return true;
    }
    if (hit.turret) {
      var ts = null;
      (bdState.turrets || []).forEach(function(x) { if (x.k === hit.turret) ts = x; });
      bdToast(u.side !== 'att' ? 'Своя турель: бьёт по чужим сама'
        : ts && ts.hp <= 0 ? 'Турель разбита'
        : (u.ap || 0) < 1 ? 'Нет готовых действий'
        : 'Турель вне досягаемости: нужна линия огня и ' + (bdgDark(u.deck) ? Math.min(2, bdRangeOf(u)) + ' клет. — на палубе темно' : bdRangeOf(u) + ' клет.'));
      return true;
    }
    return false;
  }
  if (hit.cell) {
    var r = bdReachFor(u);
    var path = r ? bdrPath(r, hit.cell[0], hit.cell[1]) : null;
    if (!path) return false;
    var cost = Math.ceil(path.length / bdMr(u));
    if (bdPlan && bdPlan.unit === u.id && bdPlan.x === hit.cell[0] && bdPlan.y === hit.cell[1]) { bdGo(); return true; }
    bdPlan = { unit: u.id, x: hit.cell[0], y: hit.cell[1], path: path, cost: cost };
    bdAim = null;
    bdSelDoor = null;
    bdRenderHud(); bdSyncOverlay();
    return true;
  }
  return false;
}

// Перетаскивание бойца пальцем: тянем — путь следует за пальцем, отпустили — идём
var bdDrag = {
  start: function(cell) {
    var u = bdActor();
    return !!(u && !bdBusy && cell[0] === u.x && cell[1] === u.y && (u.ap || 0) >= 1);
  },
  move: function(cell) {
    var u = bdActor(), r = u ? bdReachFor(u) : null;
    var path = r ? bdrPath(r, cell[0], cell[1]) : null;
    if (!path) { if (bdPlan) { bdPlan = null; bdSyncOverlay(); } return; }
    if (bdPlan && bdPlan.x === cell[0] && bdPlan.y === cell[1]) return;
    bdPlan = { unit: u.id, x: cell[0], y: cell[1], path: path, cost: Math.ceil(path.length / bdMr(u)) };
    bdAim = null;
    bdSyncOverlay();
  },
  end: function(cell) {
    if (bdPlan && bdPlan.x === cell[0] && bdPlan.y === cell[1]) bdGo();
    else { bdPlan = null; bdRenderHud(); bdSyncOverlay(); }
  },
  cancel: function() { bdPlan = null; bdSyncOverlay(); }
};

// ---------- приказы ----------

function bdOrderDone(res, okText) {
  bdBusy = false;
  if (res.error) { bdToast(res.error.message, true); bdClearOrders(); bdLoad(true); return false; }
  if (okText) bdToast(okText);
  return true;
}

function bdGo() {
  var u = bdActor();
  if (!u || !bdPlan || bdBusy) return;
  var plan = bdPlan;
  bdBusy = true;
  // Сразу ведём бойца по пути — ответ сервера не ждём
  bdMoved[u.id] = Date.now();
  bdPendingMove = { id: u.id, x: plan.x, y: plan.y };
  var from = [u.x, u.y];
  u.x = plan.x; u.y = plan.y;
  bdcAnimMove(u.id, [from].concat(plan.path));
  bdClearOrders();
  bdRenderHud(); bdSyncOverlay();
  bdcKeepInView([[plan.x, plan.y]]);
  bdRpc('boarding_move', { p_boarding_id: bdId, p_unit_id: u.id, p_path: plan.path }).then(function(res) {
    bdPendingMove = null;
    if (!bdOrderDone(res)) return;
    bdLoad(true);
  });
}

function bdShoot() {
  var u = bdActor();
  if (!u || !bdAim || bdBusy) return;
  var aim = bdAim;
  bdBusy = true;
  bdRpc('boarding_shoot', { p_boarding_id: bdId, p_unit_id: u.id, p_target: aim.target, p_turret: aim.turret }).then(function(res) {
    if (!bdOrderDone(res)) return;
    var r = res.data || {};
    bdToast(!r.hit ? 'Промах · ' + (r.chance || 0) + '%' : r.killed ? (aim.turret ? 'Турель разбита' : 'Цель уничтожена') + ' · −' + r.dmg : 'Попадание · −' + r.dmg + (r.cover ? ' · цель в укрытии' : ''), !r.hit);
    // Цель жива и всё ещё на прицеле — оставляем прицел для следующего выстрела
    if (r.killed) bdAim = null;
    bdLoad(true);
  });
}

function bdWatch(on) {
  var u = bdActor();
  if (!u || bdBusy) return;
  bdBusy = true;
  bdRpc('boarding_watch', { p_boarding_id: bdId, p_unit_id: u.id, p_on: !!on }).then(function(res) {
    if (!bdOrderDone(res, on ? 'На чеку: ударит по первому врагу на линии огня' : 'Снят с дежурства')) return;
    bdLoad(true);
  });
}

function bdPass(kind, deck) {
  var u = bdActor();
  if (!u || bdBusy) return;
  bdBusy = true;
  bdRpc('boarding_pass', { p_boarding_id: bdId, p_unit_id: u.id, p_kind: kind, p_deck: deck || null }).then(function(res) {
    if (!bdOrderDone(res)) return;
    var r = res.data || {};
    bdClearOrders();
    bdFocusAfter = u.id;
    if (r.deck && r.deck !== bdDeck) {
      bdToast((kind === 'lift' ? 'Лифт' : 'Люк') + ': ' + u.name + ' на П' + r.deck);
      bdDeck = r.deck;
      bdLoad(false);
    } else {
      bdToast('Лаз пройден');
      bdLoad(true);
    }
  });
}

function bdReinforce() {
  if (!bdReinf || bdBusy) return;
  var party = Object.keys(bdReinf.counts).filter(function(k) { return bdReinf.counts[k] > 0; })
    .map(function(k) { return { type: k, n: bdReinf.counts[k] }; });
  if (!party.length) return;
  bdBusy = true;
  bdRpc('boarding_reinforce', { p_boarding_id: bdId, p_party: party }).then(function(res) {
    if (!bdOrderDone(res)) return;
    bdToast('В шлюзе подкрепление: ' + res.data);
    bdReinf = null;
    bdDeck = bdPortDeck();
    bdSel = null; bdSelDoor = null;
    bdLoad(false);
  });
}

// ---------- панель приказов ----------

// Что можно сделать с клеткой, где стоит боец: лифт, люк, лаз
function bdPassOptions(u) {
  var dk = bdPrepDeck(bdTpl.decks[u.deck - 1]), out = [];
  var z = bdZoneAt(dk, u.x, u.y);
  if (z && z.kind === 'lift') {
    bdTpl.decks.forEach(function(d2, i) {
      if (i + 1 === u.deck) return;
      if ((d2.lifts || []).some(function(l) { return l.code === z.area; })) out.push({ kind: 'lift', deck: i + 1, cost: 1, label: 'Лифт → П' + (i + 1) });
    });
  }
  (dk.hatches || []).forEach(function(h) {
    if (h.x !== u.x || h.y !== u.y || !h.to) return;
    var welded = bdgWelded(h.id);
    out.push({ kind: 'hatch', deck: h.to[0], cost: 2, dis: welded, sub: welded ? 'заварен' : null,
               label: 'Люк ' + (h.to[0] < u.deck ? '↑' : '↓') + ' П' + h.to[0] });
  });
  (dk.ducts || []).forEach(function(d) {
    if ((d.a[0] === u.x && d.a[1] === u.y) || (d.b[0] === u.x && d.b[1] === u.y)) out.push({ kind: 'duct', cost: 2, label: 'Лаз' });
  });
  return out;
}

function bdOrdersHtml(u) {
  if (!bdActive() || !u.mine) return '';
  if (u.deck !== bdDeck) {
    return '<div class="bd-tools"><button class="bd-btn" data-act="to-deck" data-deck="' + u.deck + '">К бойцу · П' + u.deck +
      '<small>приказы — на его палубе</small></button></div>';
  }
  var ap = u.ap || 0, h = '';
  if (bdPlan && bdPlan.unit === u.id) {
    h += '<div class="bd-order go">' +
      '<div class="bd-order-txt"><b>Ход</b><span>' + bdPlan.path.length + ' клет. · ' + bdPlan.cost + ' д.</span></div>' +
      '<button class="bd-btn" data-act="plan-x">Отмена</button>' +
      '<button class="bd-btn go" data-act="go"' + (bdPlan.cost > ap ? ' disabled' : '') + '>Идти</button></div>';
  } else if (bdAim && bdAim.unit === u.id) {
    var t = null;
    bdTargetsFor(u).forEach(function(x) { if (x.key === bdAim.key) t = x; });
    if (t) {
      h += '<div class="bd-order fire">' +
        '<span class="bd-order-pic">' + (t.image ? '<img src="../' + bdEsc(t.image) + '" alt="">' : '<i class="tur"></i>') + '</span>' +
        '<div class="bd-order-txt"><b>' + bdEsc(t.name) + '</b><span>' + t.chance + '% · урон ≈' + t.dmg +
          (t.cover ? ' · укрытие −' + t.cover + '%' : '') + ' · ' + t.hp + '/' + t.max + '</span></div>' +
        '<button class="bd-btn" data-act="aim-x">Отмена</button>' +
        '<button class="bd-btn hot" data-act="fire"' + (ap < 1 ? ' disabled' : '') + '>Огонь</button></div>';
    }
  }
  var tools = '<button class="bd-btn' + (u.watch ? ' on' : '') + '" data-act="watch" data-on="' + (u.watch ? 0 : 1) + '"' +
    (!u.watch && (bdRangeOf(u) <= 0 || !(u.dmg > 0)) ? ' disabled' : '') + '>' + (u.watch ? 'Снять «На чеку»' : 'На чеку') + '<small>' + (u.watch ? 'ждёт врага' : 'свободно') + '</small></button>';
  bdPassOptions(u).forEach(function(o) {
    tools += '<button class="bd-btn" data-act="pass" data-kind="' + o.kind + '" data-deck="' + (o.deck || '') + '"' +
      (o.cost > ap || o.dis ? ' disabled' : '') + '>' + bdEsc(o.label) + '<small>' + bdEsc(o.sub || o.cost + ' д.') + '</small></button>';
  });
  tools += bdgUnitToolsHtml(u);
  h += '<div class="bd-tools">' + tools + '</div>';
  if (bdgVent && bdgVent.unit === u.id) return h + bdgVentHtml(u);
  if (!bdPlan && !bdAim) {
    var n = bdTargetsFor(u).length;
    h += '<div class="bd-hint">' + (ap < 1 ? 'Действия на перезарядке' :
      'Коснись подсвеченной клетки — ход' + (n ? ', врага в рамке — выстрел (' + n + ')' : '') + '. Бойца можно тянуть пальцем.') + '</div>';
  }
  return h;
}

// Подкрепление: пехота из своего трюма в свободные клетки шлюза
// Сколько бойцов можно досылать: только готовые типы из трюма (без тех, кто ещё в обучении)
function bdReinfAvail() {
  var n = 0;
  (bdState.reserve_types || []).forEach(function(r) { n += r.n || 0; });
  return n;
}

// После загрузки: выбор не больше, чем есть в трюме и места в шлюзе
function bdReinfClamp() {
  if (!bdReinf || !bdState) return;
  if (!bdActive() || bdState.side !== 'att' || !(bdState.reserve_types || []).length) { bdReinf = null; return; }
  var left = bdState.lock_free || 0, c = {};
  bdState.reserve_types.forEach(function(r) {
    var k = Math.min(bdReinf.counts[r.type] || 0, r.n || 0, left);
    if (k > 0) { c[r.type] = k; left -= k; }
  });
  bdReinf.counts = c;
}

function bdReinfHtml() {
  var s = bdState;
  if (!bdActive() || s.side !== 'att' || !(s.reserve_types || []).length) return '';
  if (!bdReinf) {
    var free = s.lock_free || 0;
    return '<button class="bd-reinf-open" data-act="reinf"' + (free ? '' : ' disabled') + '>Подкрепление · в трюме ' + bdReinfAvail() +
      '<small>' + (free ? 'в шлюзе свободно ' + free : 'шлюз занят — выведи бойцов из шлюза') + '</small></button>';
  }
  var n = 0;
  Object.keys(bdReinf.counts).forEach(function(k) { n += bdReinf.counts[k]; });
  var h = '<div class="bd-sec">Подкрепление · в шлюзе свободно ' + (s.lock_free || 0) + '</div>';
  s.reserve_types.forEach(function(r) {
    var k = bdReinf.counts[r.type] || 0;
    h += '<div class="bd-rrow' + (k ? ' on' : '') + '">' +
      '<span class="bd-rpic">' + (r.image ? '<img src="../' + bdEsc(r.image) + '" alt="">' : '') + '</span>' +
      '<span class="bd-rname">' + bdEsc(r.name) + (r.hero ? ' ★' : '') + '<i>в трюме ' + r.n + '</i></span>' +
      '<button class="bd-step" data-act="rstep" data-t="' + bdEsc(r.type) + '" data-d="-1"' + (k <= 0 ? ' disabled' : '') + '>−</button>' +
      '<span class="bd-rk">' + k + '</span>' +
      '<button class="bd-step" data-act="rstep" data-t="' + bdEsc(r.type) + '" data-d="1"' + (k >= r.n || n >= (s.lock_free || 0) ? ' disabled' : '') + '>+</button>' +
    '</div>';
  });
  h += '<div class="bd-acts"><button class="bd-btn" data-act="reinf-x">Закрыть</button>' +
       '<button class="bd-btn go" data-act="reinf-go"' + (n ? '' : ' disabled') + '>Высадить ' + (n || '') + '</button></div>';
  return h;
}

// Кнопки панели; true — разобрано здесь
function bdOrdersClick(b) {
  var act = b.getAttribute('data-act');
  if (act === 'go') { bdGo(); return true; }
  if (act === 'to-deck') {
    var u = bdSel ? bdUnitById(bdSel) : null;
    if (!u) return true;
    bdDeck = u.deck; bdSelDoor = null; bdClearOrders();
    bdPaint(true);
    bdcFocusUnit(u);
    return true;
  }
  if (act === 'fire') { bdShoot(); return true; }
  if (act === 'plan-x' || act === 'aim-x') { bdClearOrders(); bdRenderHud(); bdSyncOverlay(); return true; }
  if (act === 'watch') { bdWatch(b.getAttribute('data-on') === '1'); return true; }
  if (act === 'pass') { bdPass(b.getAttribute('data-kind'), +b.getAttribute('data-deck') || null); return true; }
  if (act === 'reinf') { bdReinf = { counts: {} }; bdRenderHud(); return true; }
  if (act === 'reinf-x') { bdReinf = null; bdRenderHud(); return true; }
  if (act === 'reinf-go') { bdReinforce(); return true; }
  if (act === 'rstep') {
    var ty = b.getAttribute('data-t'), d = +b.getAttribute('data-d');
    bdReinf.counts[ty] = Math.max(0, (bdReinf.counts[ty] || 0) + d);
    bdRenderHud();
    return true;
  }
  return false;
}

// ---------- события боя → анимации ----------

function bdFactionOf(side) {
  var s = bdState;
  var f = side === 'att' ? (s.attacker || {}).faction : (s.defender || {}).faction;
  return f === 'republic' || f === 'cis' ? f : 'other';
}

// Новые события после очередной загрузки. prev — бойцы до загрузки (для смертей и ходов)
function bdPlayFx(s, prevById) {
  var list = s.fx || [];
  if (bdFxSeen < 0) { bdFxSeen = s.seq || 0; return; }
  var fresh = list.filter(function(e) { return e.s > bdFxSeen; });
  if (!fresh.length) return;
  bdFxSeen = Math.max(bdFxSeen, fresh[fresh.length - 1].s);
  // Давнее 20 секунд — не показываем: вкладка спала, а бой шёл
  var stale = Date.now() + (bdOffset || 0) - 20000;
  var delay = 0, lost = [];
  fresh.forEach(function(e) {
    if (e.at && e.at < stale) return;
    if (e.k === 'sh') {
      bdcFxShot(e, bdFactionOf(e.side), delay);
      delay += 140;
      if (e.kill && e.tside === s.side && e.tu) {
        var p = prevById[e.tu];
        lost.push(p ? p.name : 'боец');
      }
    } else if (e.k === 'mv') {
      // Свой ход уже показан сразу после приказа
      if (bdMoved[e.u] && Date.now() - bdMoved[e.u] < 6000) { delete bdMoved[e.u]; return; }
      // Ход на другой палубе не рисуем; чужой — только по видимым клеткам
      if (e.d !== bdDeck || !e.p || e.p.length < 2) return;
      var p = e.p;
      if (e.side !== s.side) {
        var dk = bdPrepDeck(bdTpl.decks[e.d - 1]), seen = {};
        (s.visible || []).forEach(function(v) { if (v.deck === e.d) seen[v.zone] = true; });
        var i0 = 0;
        while (i0 < p.length) { var z = bdZoneAt(dk, p[i0][0], p[i0][1]); if (z && seen[z.id]) break; i0++; }
        p = p.slice(i0);
      }
      if (p.length > 1) bdcAnimMove(e.u, p);
    } else if (e.k === 'tp') {
      bdcFxWarp(e.d, e.f[0], e.f[1], delay);
      bdcFxWarp(e.d2, e.t[0], e.t[1], delay + 150);
    } else if (e.k === 'vt') {
      bdgFx(e, s, delay);
      delay += 300;
      (e.hits || []).forEach(function(h) {
        if (h.kill && h.side === s.side) { var p = prevById[h.u]; lost.push(p ? p.name : 'боец'); }
      });
    } else if (e.k === 'cg' || e.k === 'hl' || e.k === 'wd') {
      bdgFx(e, s, delay);
    }
  });
  if (lost.length) bdToast(lost.length === 1 ? 'Погиб: ' + lost[0] : 'Погибли: ' + lost.length, true);
}
