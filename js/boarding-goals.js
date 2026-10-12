// Абордаж: цели и отсеки корабля.
//
// Мостик: атакующие одни внутри 3 минуты подряд (флагман — 5) — корабль становится их трофеем.
// Реактор: инженер атакующего ставит заряд вплотную к реактору; не сняли за
// 5 минут — корабль взорван. Остальные отсеки с ролью что-то дают тому, кто
// их держит (чьи бойцы внутри одни): щиты, батареи и ангар цели в космосе,
// тьма на палубе, обзор всего корабля, урон, лечение, продувка отсека.
// Здесь же тревога защитника, сварка люка, подкрепление защитнику с соседнего
// корабля и итоговая сводка боя. Решает всё сервер (boarding_sync).

// who: 'att' — эффект работает, когда отсек держит атакующий; 'any' — любая сторона
var BDG_ROLE = {
  bridge:       { name: 'Мостик',            goal: true },
  reactor:      { name: 'Реакторный зал',    goal: true },
  shields:      { name: 'Генератор щитов',   who: 'att', eff: 'щиты корабля погашены' },
  battery_port: { name: 'Батарея ЛБ',        who: 'att', eff: 'левый борт не стреляет' },
  battery_star: { name: 'Батарея ПБ',        who: 'att', eff: 'правый борт не стреляет' },
  battery:      { name: 'Орудийный пост',    who: 'att', eff: 'борта не стреляют' },
  hangar:       { name: 'Ангар',             who: 'att', eff: 'машины не взлетают' },
  engine:       { name: 'Машинное',          who: 'att', eff: 'ход и прыжок заглушены' },
  comms:        { name: 'Узел связи',        who: 'att', eff: 'тревога снята, новой не будет' },
  power:        { name: 'Энергоузел',        who: 'att', eff: 'палуба во тьме, турели молчат' },
  tactical:     { name: 'Тактический центр', who: 'any', eff: 'виден весь корабль' },
  armory:       { name: 'Арсенал',           who: 'any', eff: 'урон +15%' },
  medbay:       { name: 'Медотсек',          who: 'any', eff: 'свои внутри лечатся' },
  pumps:        { name: 'Насосная',          who: 'any', eff: 'продувка отсека раз в 5 мин' }
};
var BDG_ORDER = ['bridge', 'reactor', 'shields', 'battery_port', 'battery_star', 'battery', 'hangar',
                 'engine', 'comms', 'power', 'tactical', 'armory', 'medbay', 'pumps'];

var bdgVent = null;      // { unit } — выбор отсека для продувки
var bdgDef = null;       // { ship, counts } — подкрепление защитнику

// Отсеки с ролью из шаблона: [{ role, deck, area, label }]
function bdgList() {
  if (!bdTpl) return [];
  if (bdTpl._roles) return bdTpl._roles;
  var seen = {}, out = [];
  bdTpl.decks.forEach(function(dk, i) {
    dk.zones.forEach(function(z) {
      if (!z.role || !BDG_ROLE[z.role] || seen[z.role]) return;
      seen[z.role] = true;
      out.push({ role: z.role, deck: i + 1, area: z.area, label: z.label || BDG_ROLE[z.role].name });
    });
  });
  out.sort(function(a, b) { return BDG_ORDER.indexOf(a.role) - BDG_ORDER.indexOf(b.role); });
  bdTpl._roles = out;
  return out;
}

function bdgRoleOf(deck, area) {
  var r = null;
  bdgList().forEach(function(x) { if (x.deck === deck && x.area === area) r = x.role; });
  return r;
}

function bdgHolder(role) {
  var h = bdState && bdState.hold && bdState.hold[role];
  return h ? h.side : null;
}

// Эффект отсека сейчас работает
function bdgOn(role) {
  var d = BDG_ROLE[role], h = bdgHolder(role);
  if (!d || !h || !d.who) return false;
  return d.who === 'any' || d.who === h;
}

function bdgEff() { return (bdState && bdState.status === 'active' && bdState.eff) || {}; }

// Палуба во тьме (энергоузел у атакующего) — дальность не больше 2 клеток
function bdgDark(deck) { return bdgEff().dark === deck; }

// Сколько держать мостик: у флагмана дольше, сервер присылает цифру
function bdgNeedSec() { return (bdState && (bdState.bridge_need || (bdState.bridge && bdState.bridge.need))) || 180; }
function bdgNeedText() {
  var sec = bdgNeedSec(), m = Math.floor(sec / 60), r = sec % 60;
  if (!r && m) return m + (m === 1 ? ' минуту' : m < 5 ? ' минуты' : ' минут');
  return sec + ' с';
}

function bdgBridgeLeft() {
  var b = bdState && bdState.status === 'active' && bdState.bridge;
  if (!b) return null;
  return Math.max(0, Math.ceil(b.need - (bdNow() - b.since) / 1000));
}

function bdgChargeLeft() {
  var ch = bdState && bdState.status === 'active' && bdState.charge;
  if (!ch) return null;
  return Math.max(0, Math.ceil((ch.ends - bdNow()) / 1000));
}

function bdgChargeTotal() {
  var ch = bdState && bdState.charge;
  return ch ? Math.max(1, Math.round((ch.ends - ch.at) / 1000)) : 300;
}

// ---------- шапка: мостик и заряд ----------

function bdgTopHtml() {
  var s = bdState;
  if (s.status !== 'active') return '';
  var h = '', att = s.side === 'att';
  var bl = bdgBridgeLeft(), cl = bdgChargeLeft();
  if (bl !== null) {
    // Удержание не успеет до конца боя — честно говорим об этом
    var late = s.bridge.since + s.bridge.need * 1000 > new Date(s.ends_at).getTime();
    h += '<div class="bd-goal ' + (att ? 'good' : 'bad') + '">' +
      '<i class="bd-goal-ico br"></i>' +
      '<span>' + (late ? (att ? 'Мостик наш · до конца боя не успеть' : 'Враг на мостике · но время на нашей стороне')
                       : (att ? 'Мостик наш · захват через' : 'Враг на мостике · корабль уйдёт через')) + '</span>' +
      '<b id="bd-g-bridge">' + bdClock(bl) + '</b>' +
      '<em><u id="bd-g-bridge-bar" style="width:' + Math.round(100 * (1 - bl / s.bridge.need)) + '%"></u></em></div>';
  }
  if (cl !== null) {
    h += '<div class="bd-goal ' + (att ? 'good' : 'bad') + ' charge">' +
      '<i class="bd-goal-ico ch"></i>' +
      '<span>' + (att ? 'Заряд в реакторе · взрыв через' : 'Заряд в реакторе! Снять за') + '</span>' +
      '<b id="bd-g-charge">' + bdClock(cl) + '</b>' +
      '<em><u id="bd-g-charge-bar" style="width:' + Math.round(100 * (1 - cl / bdgChargeTotal())) + '%"></u></em></div>';
  }
  return h;
}

// ---------- панель: отсеки ----------

// Кого видно в отсеке: свои и чужие (чужих — только на виду)
function bdgCount(r) {
  var dk = bdPrepDeck(bdTpl.decks[r.deck - 1]), n = { own: 0, foe: 0 };
  bdUnits(r.deck).forEach(function(u) {
    var z = bdZoneAt(dk, u.x, u.y);
    if (!z || z.area !== r.area) return;
    if (u.side === bdState.side) n.own++; else n.foe++;
  });
  return n;
}

function bdgRoomText(r) {
  var s = bdState, d = BDG_ROLE[r.role], who = bdgHolder(r.role);
  var mine = who === s.side;
  if (!who) {
    var n = bdgCount(r);
    if (n.own && n.foe) return 'идёт бой · наших ' + n.own + ', врагов ' + n.foe;
  }
  if (r.role === 'bridge') {
    var bl = bdgBridgeLeft();
    if (bl !== null) return (mine ? 'захват' : 'потеря') + ' через <b data-g="bridge">' + bdClock(bl) + '</b>';
    if (who) return mine ? 'держим' : 'держит враг';
    return s.side === 'att' ? 'цель: удержать ' + bdgNeedText() : 'не пускай врага';
  }
  if (r.role === 'reactor') {
    var cl = bdgChargeLeft();
    if (cl !== null) return 'заряд · <b data-g="charge">' + bdClock(cl) + '</b>';
    return s.side === 'att' ? 'заряд инженера' : (who === 'att' ? 'враг у реактора' : 'чисто');
  }
  if (bdgOn(r.role)) return d.eff + (d.who === 'any' ? (mine ? ' · нам' : ' · врагу') : '');
  if (who) return mine ? 'держим' : 'держит враг';
  return d.who === 'att' ? (s.side === 'att' ? 'захвати: ' + d.eff : 'не отдавай') : 'пусто';
}

function bdgPanelHtml() {
  var list = bdgList();
  if (!list.length || bdState.status !== 'active') return '';
  var s = bdState;
  var h = '<div class="bd-sec">Отсеки корабля</div><div class="bd-rooms">';
  list.forEach(function(r) {
    var who = bdgHolder(r.role), cnt = who ? null : bdgCount(r);
    var cls = who ? (who === s.side ? 'own' : 'foe') : (cnt.own && cnt.foe ? 'fight' : 'none');
    if (BDG_ROLE[r.role].goal) cls += ' goal';
    if (bdgOn(r.role)) cls += ' on';
    if ((r.role === 'bridge' && bdgBridgeLeft() !== null) || (r.role === 'reactor' && bdgChargeLeft() !== null)) cls += ' hot';
    h += '<button class="bd-room ' + cls + '" data-act="room" data-room="' + r.role + '">' +
      '<span class="bd-room-name"><i></i>' + bdEsc(r.label) + '<em>П' + r.deck + '</em></span>' +
      '<span class="bd-room-eff">' + bdgRoomText(r) + '</span></button>';
  });
  return h + '</div>';
}

// Защитник: новая тревога и подкрепление с соседнего корабля
function bdgDefHtml() {
  var s = bdState;
  if (s.status !== 'active' || s.side !== 'def') return '';
  var h = '';
  var comms = !!bdgEff().comms, cd = s.alarm_cd || 0;
  h += '<button class="bd-alarm-btn" data-act="alarm"' + (comms || cd > 0 ? ' disabled' : '') + '>Объявить тревогу' +
    '<small id="bd-g-alarm">' + (comms ? 'узел связи у врага — тревогу не объявить'
      : cd > 0 ? 'новая тревога через ' + bdClock(cd)
      : 'переборки, бронедвери и шлюзы, кроме выбитых, запрутся') + '</small></button>';
  var hs = s.helpers || [];
  if (!hs.length) return h;
  if (!bdgDef) {
    var total = 0;
    hs.forEach(function(x) { (x.types || []).forEach(function(t) { total += t.n; }); });
    return h + '<button class="bd-reinf-open def" data-act="dreinf"' + (s.lock_free ? '' : ' disabled') + '>' +
      'Подкрепление · с кораблей рядом ' + total +
      '<small>' + (s.lock_free ? 'через свободный шлюз · мест ' + s.lock_free : 'свободный шлюз занят') + '</small></button>';
  }
  var ship = null;
  hs.forEach(function(x) { if (x.ship_id === bdgDef.ship) ship = x; });
  if (!ship) { ship = hs[0]; bdgDef.ship = ship.ship_id; bdgDef.counts = {}; }
  var n = 0;
  Object.keys(bdgDef.counts).forEach(function(k) { n += bdgDef.counts[k]; });
  h += '<div class="bd-sec">Подкрепление · мест в шлюзе ' + (s.lock_free || 0) + '</div>';
  if (hs.length > 1) {
    h += '<div class="bd-ship-pick">' + hs.map(function(x) {
      return '<button class="bd-btn' + (x.ship_id === ship.ship_id ? ' on' : '') + '" data-act="dship" data-ship="' + bdEsc(x.ship_id) + '">' + bdEsc(x.name) + '</button>';
    }).join('') + '</div>';
  }
  (ship.types || []).forEach(function(r) {
    var k = bdgDef.counts[r.type] || 0;
    h += '<div class="bd-rrow' + (k ? ' on' : '') + '">' +
      '<span class="bd-rpic">' + (r.image ? '<img src="../' + bdEsc(r.image) + '" alt="">' : '') + '</span>' +
      '<span class="bd-rname">' + bdEsc(r.name) + (r.hero ? ' ★' : '') + '<i>на «' + bdEsc(ship.name) + '» ' + r.n + '</i></span>' +
      '<button class="bd-step" data-act="dstep" data-t="' + bdEsc(r.type) + '" data-d="-1"' + (k <= 0 ? ' disabled' : '') + '>−</button>' +
      '<span class="bd-rk">' + k + '</span>' +
      '<button class="bd-step" data-act="dstep" data-t="' + bdEsc(r.type) + '" data-d="1"' + (k >= r.n || n >= (s.lock_free || 0) ? ' disabled' : '') + '>+</button>' +
    '</div>';
  });
  h += '<div class="bd-acts"><button class="bd-btn" data-act="dreinf-x">Закрыть</button>' +
       '<button class="bd-btn go" data-act="dreinf-go"' + (n ? '' : ' disabled') + '>Высадить ' + (n || '') + '</button></div>';
  return h;
}

// Выбор не больше, чем есть на корабле и места в шлюзе; корабль ушёл — закрываем
function bdgDefClamp() {
  if (!bdgDef || !bdState) return;
  var hs = bdState.helpers || [];
  if (bdState.status !== 'active' || bdState.side !== 'def' || !hs.length) { bdgDef = null; return; }
  var ship = null;
  hs.forEach(function(x) { if (x.ship_id === bdgDef.ship) ship = x; });
  if (!ship) { bdgDef = { ship: hs[0].ship_id, counts: {} }; return; }
  var left = bdState.lock_free || 0, c = {};
  (ship.types || []).forEach(function(r) {
    var k = Math.min(bdgDef.counts[r.type] || 0, r.n || 0, left);
    if (k > 0) { c[r.type] = k; left -= k; }
  });
  bdgDef.counts = c;
}

// ---------- приказы бойца: заряд, снять заряд, продувка, сварка ----------

function bdgNearReactor(dk, u) {
  return (dk.props || []).some(function(p) {
    return p.k === 'reactor' && u.x >= p.x - 1 && u.x <= p.x + p.w && u.y >= p.y - 1 && u.y <= p.y + p.h;
  });
}

function bdgHatchAt(dk, u) {
  var h = null;
  (dk.hatches || []).forEach(function(x) { if (x.x === u.x && x.y === u.y) h = x; });
  return h;
}

function bdgWelded(id) { return !!(bdState && bdState.doors && bdState.doors[id] === 'welded'); }

// Кнопки для панели бойца: [{ act, label, cost, hot, dis, sub }]
function bdgUnitActs(u) {
  var s = bdState, out = [];
  // В учении ни заряда, ни насосов, ни сварки — цель одна: мостик
  if (s.status !== 'active' || !u.mine || s.drill) return out;
  var dk = bdPrepDeck(bdTpl.decks[u.deck - 1]), z = bdZoneAt(dk, u.x, u.y);
  var role = z ? z.role : null, ch = s.charge;
  if (s.side === 'att' && u.engineer && role === 'reactor' && !ch) {
    var near = bdgNearReactor(dk, u);
    // Заряду нужно 5 минут: если бой кончится раньше, взрыва не будет
    var late = new Date(s.ends_at).getTime() - bdNow() < 300000;
    out.push({ act: 'charge', label: 'Заряд', cost: 2, hot: true, dis: !near || late,
               sub: late ? 'до конца боя < 5 мин' : near ? '2 д. · 5 мин' : 'вплотную к реактору' });
  }
  if (s.side === 'def' && ch && ch.deck === u.deck && Math.max(Math.abs(ch.x - u.x), Math.abs(ch.y - u.y)) <= 1) {
    out.push({ act: 'defuse', label: 'Снять заряд', cost: u.engineer ? 1 : 2, hot: true });
  }
  if (role === 'pumps') {
    var cd = s.vent_cd || 0, mine = bdgEff().pumps === s.side;
    out.push({ act: 'vent', label: 'Продуть отсек', cost: 1, dis: !mine || cd > 0,
               sub: !mine ? 'в насосной враг' : cd > 0 ? 'насосы через ' + bdClock(cd) : '1 д. · урон всем' });
  }
  var h = bdgHatchAt(dk, u);
  if (s.side === 'def' && u.engineer && h && !bdgWelded(h.id)) {
    out.push({ act: 'weld', label: 'Заварить люк', cost: 1, sub: '1 д. · до конца боя' });
  }
  return out;
}

function bdgUnitToolsHtml(u) {
  var ap = u.ap || 0;
  return bdgUnitActs(u).map(function(a) {
    return '<button class="bd-btn' + (a.hot ? ' hot' : '') + '" data-act="g-' + a.act + '"' +
      (a.dis || a.cost > ap ? ' disabled' : '') + '>' + bdEsc(a.label) +
      '<small>' + bdEsc(a.sub || a.cost + ' д.') + '</small></button>';
  }).join('');
}

// Выбор отсека для продувки: комнаты палубы насосной, кроме неё самой
function bdgVentHtml(u) {
  if (!bdgVent || bdgVent.unit !== u.id) return '';
  var dk = bdPrepDeck(bdTpl.decks[u.deck - 1]);
  var here = bdZoneAt(dk, u.x, u.y);
  var seen = {}, rows = [];
  dk.zones.forEach(function(z) {
    if (seen[z.area] || (z.kind !== 'room' && z.kind !== 'goal') || (here && z.area === here.area)) return;
    seen[z.area] = true;
    var own = 0, foe = 0;
    bdUnits(u.deck).forEach(function(x) {
      var zz = bdZoneAt(dk, x.x, x.y);
      if (!zz || zz.area !== z.area) return;
      if (x.side === bdState.side) own++; else foe++;
    });
    rows.push({ area: z.area, label: z.label || 'Отсек', own: own, foe: foe });
  });
  rows.sort(function(a, b) { return (b.foe - b.own) - (a.foe - a.own); });
  var h = '<div class="bd-sec">Продуть отсек · урон ' + 40 + ' всем внутри</div><div class="bd-vents">';
  rows.forEach(function(r) {
    h += '<button class="bd-vent" data-act="g-vent-go" data-area="' + bdEsc(r.area) + '">' +
      '<span>' + bdEsc(r.label) + '</span>' +
      (r.foe ? '<i class="f">' + r.foe + '</i>' : '') + (r.own ? '<i class="m">' + r.own + '</i>' : '') + '</button>';
  });
  return h + '</div><div class="bd-hint">Видно только тех, кто на виду. Свои внутри тоже получат урон.</div>' +
    '<div class="bd-acts"><button class="bd-btn" data-act="g-vent-x">Отмена</button></div>';
}

// ---------- запросы ----------

function bdgCall(name, args, ok) {
  if (bdBusy) return;
  bdBusy = true;
  bdRpc(name, args).then(function(res) {
    bdBusy = false;
    if (res.error) { bdToast(res.error.message, true); bdLoad(true); return; }
    if (ok) ok(res.data);
    bdLoad(true);
  });
}

function bdgClick(b) {
  var act = b.getAttribute('data-act');
  var u = bdActor();
  if (act === 'room') {
    var r = null, role = b.getAttribute('data-room');
    bdgList().forEach(function(x) { if (x.role === role) r = x; });
    if (!r) return true;
    if (bdDeck !== r.deck) { bdDeck = r.deck; bdSelDoor = null; bdClearOrders(); bdPaint(false); }
    var g = bdcGeom(bdPrepDeck(bdTpl.decks[r.deck - 1])), a = g.areas[r.area];
    if (a) bdcFly(a.big[0] + a.big[2] / 2, a.big[1] + a.big[3] / 2, Math.max(BDC.cam.s, bdcTacS()));
    return true;
  }
  if (act === 'g-charge') {
    if (!u) return true;
    bdgCall('boarding_charge', { p_boarding_id: bdId, p_unit_id: u.id, p_action: 'plant' }, function() {
      bdToast('Заряд заложен · 5 минут. Не дай его снять');
    });
    return true;
  }
  if (act === 'g-defuse') {
    if (!u) return true;
    bdgCall('boarding_charge', { p_boarding_id: bdId, p_unit_id: u.id, p_action: 'defuse' }, function() {
      bdToast('Заряд снят — реактор цел');
    });
    return true;
  }
  if (act === 'g-weld') {
    if (!u) return true;
    bdgCall('boarding_weld', { p_boarding_id: bdId, p_unit_id: u.id }, function() {
      bdToast('Люк заварен до конца боя — с обеих палуб');
    });
    return true;
  }
  if (act === 'g-vent') {
    if (!u) return true;
    bdClearOrders();
    bdgVent = { unit: u.id };
    bdRenderHud(); bdSyncOverlay();
    return true;
  }
  if (act === 'g-vent-x') { bdgVent = null; bdRenderHud(); return true; }
  if (act === 'g-vent-go') {
    if (!u) return true;
    var area = b.getAttribute('data-area');
    var dk = bdPrepDeck(bdTpl.decks[u.deck - 1]);
    var label = (dk.zones.filter(function(z) { return z.area === area; })[0] || {}).label || 'отсек';
    var go = function() {
      bdgVent = null;
      bdgCall('boarding_vent', { p_boarding_id: bdId, p_unit_id: u.id, p_area: area }, function(r) {
        r = r || {};
        if (r.ended) return;
        bdToast('«' + label + '» продут · задето ' + (r.hits || 0) + (r.killed ? ' · погибло ' + r.killed : ''));
      });
    };
    if (typeof gameConfirm !== 'function') { go(); return true; }
    gameConfirm({
      tone: 'danger', kicker: 'Насосная', title: 'Продуть «' + label + '»?',
      sub: 'Урон 40 каждому внутри', note: 'Свои в этом отсеке тоже получат урон. Следующая продувка — через 5 минут.',
      ok: 'Продуть', cancel: 'Отмена'
    }, go);
    return true;
  }
  if (act === 'alarm') {
    bdgCall('boarding_alarm', { p_boarding_id: bdId }, function(n) {
      bdToast(n ? 'Тревога: заперто дверей — ' + n : 'Тревога объявлена: запирать уже нечего');
    });
    return true;
  }
  if (act === 'dreinf') {
    var hs = bdState.helpers || [];
    bdgDef = { ship: hs.length ? hs[0].ship_id : null, counts: {} };
    bdRenderHud();
    return true;
  }
  if (act === 'dreinf-x') { bdgDef = null; bdRenderHud(); return true; }
  if (act === 'dship') { bdgDef = { ship: b.getAttribute('data-ship'), counts: {} }; bdRenderHud(); return true; }
  if (act === 'dstep') {
    if (!bdgDef) return true;
    var ty = b.getAttribute('data-t'), d = +b.getAttribute('data-d');
    bdgDef.counts[ty] = Math.max(0, (bdgDef.counts[ty] || 0) + d);
    bdRenderHud();
    return true;
  }
  if (act === 'dreinf-go') {
    if (!bdgDef) return true;
    var party = Object.keys(bdgDef.counts).filter(function(k) { return bdgDef.counts[k] > 0; })
      .map(function(k) { return { type: k, n: bdgDef.counts[k] }; });
    if (!party.length) return true;
    var ship = bdgDef.ship;
    bdgCall('boarding_reinforce_def', { p_boarding_id: bdId, p_ship_id: ship, p_party: party }, function(n) {
      bdToast('В свободном шлюзе подкрепление: ' + n);
      bdgDef = null;
      bdDeck = bdPortDeck();
    });
    return true;
  }
  return false;
}

// ---------- события боя ----------

function bdgFx(e, s, delay) {
  var own = e.side === s.side;
  if (e.k === 'cg') {
    bdcFxAdd({ k: 'charge', d: e.d, x: e.f[0], y: e.f[1], act: e.act, dur: 1600, delay: delay });
    if (!own) bdToast(e.act === 'plant' ? 'Враг заложил заряд в реактор! Снять за 5 минут' : 'Защитник снял заряд', true);
  } else if (e.k === 'vt') {
    bdcFxAdd({ k: 'vent', d: e.d, area: e.area, dur: 1900, delay: delay, seed: e.s || 0 });
    (e.hits || []).forEach(function(h, i) {
      bdcFxAdd({ k: 'float', d: e.d, x: h.x, y: h.y, text: h.kill ? 'УНИЧТОЖЕН' : '−' + h.dmg, kind: h.kill ? 'kill' : 'dmg',
                 dur: 1600, delay: delay + 500 + i * 60 });
    });
    if (!own) {
      var dk = bdPrepDeck(bdTpl.decks[e.d - 1]);
      var lab = (dk.zones.filter(function(z) { return z.area === e.area; })[0] || {}).label || 'отсек';
      bdToast('Насосная продула «' + lab + '»', true);
    }
  } else if (e.k === 'hl') {
    (e.pts || []).forEach(function(p, i) {
      bdcFxAdd({ k: 'float', d: e.d, x: p[0], y: p[1], text: '+' + p[2], kind: 'heal', dur: 1400, delay: delay + i * 80 });
    });
  } else if (e.k === 'wd') {
    bdcFxAdd({ k: 'weld', d: e.d, x: e.f[0], y: e.f[1], dur: 1100, delay: delay, seed: e.s || 0 });
    if (!own) bdToast('Защитник заварил люк', true);
  }
}

// ---------- каждую секунду: отсчёты ----------

function bdgTick() {
  var s = bdState;
  if (!s || s.status !== 'active') return;
  var bl = bdgBridgeLeft(), cl = bdgChargeLeft();
  var set = function(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; };
  var bar = function(id, pct) { var el = document.getElementById(id); if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%'; };
  if (bl !== null) {
    set('bd-g-bridge', bdClock(bl)); bar('bd-g-bridge-bar', 100 * (1 - bl / s.bridge.need));
    var nb = document.querySelectorAll('[data-g="bridge"]');
    for (var i = 0; i < nb.length; i++) nb[i].textContent = bdClock(bl);
  }
  if (cl !== null) {
    set('bd-g-charge', bdClock(cl)); bar('bd-g-charge-bar', 100 * (1 - cl / bdgChargeTotal()));
    var nc = document.querySelectorAll('[data-g="charge"]');
    for (var j = 0; j < nc.length; j++) nc[j].textContent = bdClock(cl);
  }
  // Отсчёт дошёл до нуля — сервер решит исход при чтении
  if ((bl === 0 || cl === 0) && !bdgTick.asked) { bdgTick.asked = true; bdLoad(true); }
  if (bl !== 0 && cl !== 0) bdgTick.asked = false;
  if (s.side === 'def' && s.alarm_cd > 0) {
    s.alarm_cd--;
    var el = document.getElementById('bd-g-alarm');
    if (el && !bdgEff().comms) {
      if (s.alarm_cd > 0) el.textContent = 'новая тревога через ' + bdClock(s.alarm_cd);
      else bdRenderHud();
    }
  }
  if (s.vent_cd > 0) {
    s.vent_cd--;
    if (!s.vent_cd && bdSel) bdRenderHud();
  }
}

// ---------- итог боя ----------

function bdgStatsHtml(s) {
  var st = s.stats || {}, me = st[s.side] || {}, foe = st[s.side === 'att' ? 'def' : 'att'] || {};
  var acc = me.shots ? Math.round(100 * (me.hits || 0) / me.shots) : null;
  var mins = s.finished_at && s.started_at
    ? Math.max(1, Math.round((new Date(s.finished_at).getTime() - new Date(s.started_at).getTime()) / 60000)) : null;
  var cell = function(v, t, cls) { return '<div class="bd-end-stat' + (cls ? ' ' + cls : '') + '"><b>' + v + '</b><span>' + t + '</span></div>'; };
  var h = '<div class="bd-end-stats">' +
    cell(me.kills || 0, 'врагов уничтожено', 'good') +
    cell(me.lost || 0, 'своих потеряно', (me.lost ? 'bad' : '')) +
    cell(acc === null ? '—' : acc + '%', 'точность · ' + (me.shots || 0) + ' выстр.') +
    (s.side === 'att'
      ? cell(me.turrets || 0, 'турелей разбито') + cell(me.breach || 0, 'дверей взломано')
      : cell(foe.lost || 0, 'врагов на борту пало') + cell(me.welds || 0, 'люков заварено')) +
    cell(mins === null ? '—' : mins + ' мин', 'длился бой') +
  '</div>';
  var extra = [];
  if (me.reinforced) extra.push('подкрепление: ' + me.reinforced);
  if (me.vents) extra.push('продувок: ' + me.vents);
  if (s.side === 'def' && me.defused) extra.push('снято зарядов: ' + me.defused);
  if (s.side === 'def' && me.alarms) extra.push('тревог: ' + me.alarms);
  if (s.side === 'def' && me.gone) extra.push('списано из трюма: ' + me.gone);
  if (extra.length) h += '<div class="bd-end-extra">' + bdEsc(extra.join(' · ')) + '</div>';
  return h;
}
