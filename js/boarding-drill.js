// Учебный абордаж: бой на палубах малого корабля целиком в браузере.
//
// Сервер отдаёт только копии бойцов из трюма (get_boarding_drill) — ничего
// не пишет: настоящие бойцы остаются на месте, корабль ничем не занят,
// потерь и наград нет. Дальше этот файл играет за сервер: принимает те же
// приказы, что и boarding_move / boarding_shoot / boarding_door /
// boarding_pass, по тем же правилам (js/boarding-rules.js), и отвечает
// снимком в виде get_boarding — страница абордажа не замечает разницы.
//
// Цель — брошенный транспорт на плане малого корабля. Турели отключены,
// тревоги нет. Охрана — три слабых бойца с половиной здоровья: стоят на
// местах и стреляют, только когда видят бойца. Подсказки ведут по шагам:
// шлюз, выстрел, дверь, переборка, лифт, люк, мостик (удержание — 30 с).

var BDD = null;            // идущее учение
var BDD_TICK = 400;        // шаг движка, мс
var BDD_FOE_REACT = 1500;  // охрана замечает бойца не сразу
var BDD_FOE_EVERY = 9000;  // и стреляет не чаще раза в 9 с
var BDD_FOE_AIM = 10;      // и мажет чаще обычного
var BDD_MINUTES = 20;

// Охрана: место на плане и подпись в подсказке
var BDD_FOES = [
  { id: 'drill-foe-1', deck: 1, x: 21, y: 6 },   // орудийный пост, видно из коридора у шлюза
  { id: 'drill-foe-2', deck: 2, x: 15, y: 9 },   // коридор у лифта на П2
  { id: 'drill-foe-3', deck: 2, x: 35, y: 10 }   // цех, у люка на мостик
];

// Двери на старте. Остальные обычные двери открыты, переборки заперты.
// Обходы заклинены: к лифту — только через дверь и переборку коридора,
// к мостику — только лифтом и люком
var BDD_DOORS = { s1d6: 'open', s1d4: 'closed', s1d16: 'closed', s1d14: 'closed', s2b3: 'open', s2b4: 'open',
                  s1d15: 'locked', s1d17: 'locked', s1d3: 'locked', s1d10: 'locked' };
var BDD_JAM = { s1b3: true, s1b4: true, s1d15: true, s1d17: true, s1d3: true, s1d10: true };

var BDD_STEPS = [
  { k: 'out', tag: 'ВЫХОД', title: 'Выход из шлюза',
    text: 'Коснись бойца, затем клетки за дверью шлюза. Зелёные клетки — ход за 1 действие, жёлтые — за 2; второе касание — «Идти».' },
  { k: 'shot', tag: 'ЦЕЛЬ', title: 'Огонь',
    text: 'В орудийном посту охрана. Подойди к двери поста, коснись врага в рамке и жми «Огонь». Выстрел — 1 действие, действия копятся сами.' },
  { k: 'door', tag: 'ДВЕРЬ', title: 'Открыть дверь',
    text: 'Встань вплотную к двери в коридор и нажми «Открыть» в панели бойца — это бесплатно.' },
  { k: 'breach', tag: 'ПЕРЕБОРКА', title: 'Взлом переборки',
    text: 'Встань у переборки в конце коридора и нажми «Взломать»: инженеру нужно 1 действие, остальным — 2.' },
  { k: 'lift', tag: 'ЛИФТ', title: 'Лифт на П2',
    text: 'Заведи бойца в кабину «Л» и нажми «Лифт → П2». Палубы переключаются вкладками П1 / П2 над планом.' },
  { k: 'hatch', tag: 'ЛЮК', title: 'Люк на мостик',
    text: 'Коридором и через цех — к люку «↑ мостик», охрана по пути. Встань на люк и нажми «Люк ↑ П1» — 2 действия.' },
  { k: 'bridge', tag: 'МОСТИК', title: 'Удержать мостик',
    text: 'Мостик твой, пока в нём нет врагов. Держи его {need} с — в настоящем бою 3 минуты, и защитник будет выбивать.' }
];

function bddOk(data) { return Promise.resolve({ data: data, error: null }); }
function bddErr(msg) { return Promise.resolve({ data: null, error: { message: msg } }); }
function bddIso(ms) { return new Date(ms).toISOString(); }

// ---------- старт ----------

function bddStart(shipId) {
  return Promise.all([
    supabase.rpc('get_boarding_drill', { p_ship_id: shipId }),
    supabase.from('deck_templates').select('id, decks, spawn').eq('id', 'small').maybeSingle()
  ]).then(function(r) {
    if (r[0].error || !r[0].data) { bdFail(r[0].error ? r[0].error.message : 'Учение не началось'); return false; }
    if (r[1].error || !r[1].data) { bdFail('План палуб не загрузился'); return false; }
    var d = r[0].data, tpl = r[1].data;
    if (!(d.party || []).length) {
      bdFail('В трюме нет готовой пехоты: учению нужен хотя бы один боец не на обучении — техника на палубы не ходит');
      return false;
    }
    try {
      bddBuild(d, tpl);
    } catch (e) {
      BDD = null;
      bdFail('Учение не собралось: ' + (e && e.message ? e.message : 'ошибка плана'));
      return false;
    }
    return true;
  }, function() { bdFail('Нет связи с сервером'); return false; });
}

function bddBuild(d, tpl) {
  var now = Date.now();
  var spawn = (tpl.spawn && tpl.spawn.att_n) || [];
  var units = [];
  d.party.forEach(function(p, i) {
    var c = spawn[i] || spawn[0];
    units.push(bddUnit(p, 'drill-' + (i + 1), 'att', c[0], c[1], c[2], p.max_hp, now));
  });
  BDD_FOES.forEach(function(f) {
    var u = bddUnit(d.foe, f.id, 'def', f.deck, f.x, f.y, d.foe.hp, now);
    u.nextShot = 0; u.aware = 0;
    units.push(u);
  });
  var doors = {};
  tpl.decks.forEach(function(dk) {
    (dk.doors || []).forEach(function(x) {
      if (x.kind === 'lift') return;
      doors[x.id] = x.kind === 'door' ? 'open' : 'locked';
    });
  });
  Object.keys(BDD_DOORS).forEach(function(k) { doors[k] = BDD_DOORS[k]; });
  BDD = {
    data: d, tpl: tpl, units: units, doors: doors,
    cd: Math.max(4, d.action_seconds || 6) * 1000,
    need: Math.max(10, d.bridge_seconds || 30),
    t0: now, ends: now + BDD_MINUTES * 60000, begun: false, finished: null,
    status: 'active', result: null, since: null, hold: {},
    seq: 0, fx: [], rev: 1,
    stats: { att: {}, def: {} },
    done: {}, step: 0, flash: 0, coachOpen: true,
    timer: null, reloadAt: 0
  };
  bdTpl = { id: tpl.id, decks: tpl.decks };
  if (window.sceneLoader) sceneLoader.mark('plan');
  bddCheck();
}

function bddUnit(p, id, side, deck, x, y, hp, now) {
  return {
    id: id, side: side, deck: deck, x: x, y: y, watch: false,
    type: p.type, type_name: p.type_name, name: p.name, image: p.image,
    hero: !!p.hero, engineer: !!p.engineer, hull: p.hull,
    hp: hp, max_hp: p.max_hp, mr: p.mr, wr: p.wr, vr: p.vr, acc: p.acc, eva: p.eva, dmg: p.dmg,
    ap: 2, apAt: now
  };
}

// Игрок прочитал вступление — пошли часы
function bddBegin() {
  if (!BDD || BDD.begun) return;
  var now = Date.now();
  BDD.begun = true;
  BDD.t0 = now;
  BDD.ends = now + BDD_MINUTES * 60000;
  BDD.units.forEach(function(u) { u.apAt = now; });
  BDD.timer = setInterval(bddStep, BDD_TICK);
  bddRefresh();
}

// ---------- правила ----------

function bddDk(n) { return bdPrepDeck(BDD.tpl.decks[n - 1]); }
function bddGeo(n) { return bdrGeo(bddDk(n)); }

function bddZone(u) { return bdZoneAt(bddDk(u.deck), u.x, u.y); }

function bddById(id) {
  for (var i = 0; i < BDD.units.length; i++) if (BDD.units[i].id === id) return BDD.units[i];
  return null;
}

function bddAp(u, now) {
  if (!BDD.begun) return u.ap;
  return Math.min(2, u.ap + Math.floor((now - u.apAt) / BDD.cd));
}

function bddNextIn(u, now) {
  if (bddAp(u, now) >= 2 || !BDD.begun) return 0;
  return Math.ceil((BDD.cd - ((now - u.apAt) % BDD.cd)) / 1000);
}

// Как spend_unit_action: полный запас — отсчёт заново, иначе — с прошлой метки
function bddSpend(u, n, now) {
  for (var i = 0; i < n; i++) {
    var gain = Math.floor((now - u.apAt) / BDD.cd), eff = Math.min(2, u.ap + gain);
    u.apAt = eff >= 2 ? now : u.apAt + gain * BDD.cd;
    u.ap = eff - 1;
  }
}

function bddReach(u) {
  var v = u.vr, w = u.wr;
  if (v === null || v === undefined) return w || 0;
  if (w === null || w === undefined) return v || 0;
  return Math.min(v, w);
}

function bddOcc(deck, except) {
  var o = {};
  BDD.units.forEach(function(x) { if (x.deck === deck && x.id !== except) o[x.x + ',' + x.y] = x.side; });
  return o;
}

function bddStat(side, key, n) {
  var s = BDD.stats[side];
  s[key] = (s[key] || 0) + (n === undefined ? 1 : n);
}

function bddFx(e) {
  BDD.seq++;
  e.s = BDD.seq;
  e.at = Date.now();
  BDD.fx.push(e);
  if (BDD.fx.length > 40) BDD.fx.shift();
}

// Выстрел: тот же расчёт, что boarding_shoot + boarding_apply_shot
function bddFire(a, t, src, aimPenalty) {
  var g = bddGeo(a.deck);
  var cover = bdrCover(g, a.x, a.y, t.x, t.y);
  var chance = Math.max(5, Math.min(95, (a.acc || 75) - (t.eva || 0) - (aimPenalty || 0)));
  var dmg = Math.max(1, Math.round((a.dmg || 0) * (100 - cover) / 100));
  var hit = Math.random() * 100 < chance;
  var dealt = 0, kill = false;
  if (hit) {
    dealt = Math.min(dmg, t.hp);
    t.hp = Math.max(0, t.hp - dmg);
    kill = t.hp <= 0;
  }
  if (src !== 't') {
    bddStat(a.side, 'shots');
    if (hit) bddStat(a.side, 'hits');
  }
  if (kill) {
    bddStat(a.side, 'kills');
    bddStat(t.side, 'lost');
    BDD.units = BDD.units.filter(function(x) { return x.id !== t.id; });
  }
  bddFx({ k: 'sh', side: a.side, tside: t.side, src: src, u: a.id, tu: t.id, d: a.deck,
          f: [a.x, a.y], t: [t.x, t.y], hit: hit, dmg: dealt, kill: kill });
  return { hit: hit, dmg: dealt, killed: kill, chance: chance, cover: cover };
}

function bddCanSee(a, t) {
  if (a.deck !== t.deck) return false;
  var r = bddReach(a);
  if (r <= 0 || !(a.dmg > 0)) return false;
  if (Math.max(Math.abs(a.x - t.x), Math.abs(a.y - t.y)) > r) return false;
  return bdrLos(bddGeo(a.deck), BDD.doors, a.x, a.y, t.x, t.y);
}

// Ближайшая цель на линии огня: сперва ближе, потом слабее
function bddPick(a, side) {
  var best = null, bd = 0;
  BDD.units.forEach(function(t) {
    if (t.side !== side || !bddCanSee(a, t)) return;
    var dd = Math.max(Math.abs(a.x - t.x), Math.abs(a.y - t.y)) * 1000 + t.hp;
    if (!best || dd < bd) { best = t; bd = dd; }
  });
  return best;
}

// ---------- такт: охрана, «На чеку», мостик, время ----------

function bddStep() {
  if (!BDD || BDD.status !== 'active') return;
  var now = Date.now(), changed = false;

  BDD.units.slice().forEach(function(f) {
    if (f.side !== 'def' || !bddById(f.id) || BDD.status !== 'active') return;
    var t = bddPick(f, 'att');
    if (!t) { f.aware = 0; return; }
    if (!f.aware) { f.aware = now + BDD_FOE_REACT; return; }
    if (now < f.aware || now < f.nextShot) return;
    f.nextShot = now + BDD_FOE_EVERY;
    bddFire(f, t, 'w', BDD_FOE_AIM);
    changed = true;
  });

  BDD.units.slice().forEach(function(u) {
    if (u.side !== 'att' || !u.watch || !bddById(u.id) || BDD.status !== 'active') return;
    if (bddAp(u, now) < 1) return;
    var t = bddPick(u, 'def');
    if (!t) return;
    bddSpend(u, 1, now);
    bddFire(u, t, 'w', 0);
    changed = true;
  });

  if (bddCheck()) changed = true;
  if (BDD.status === 'active' && now >= BDD.ends) { bddFinish('timeout', null); changed = true; }
  if (changed) bddRefresh();
}

// Отсеки, мостик, шаги подсказки; true — что-то изменилось
function bddCheck() {
  var before = JSON.stringify([BDD.hold, BDD.since, BDD.done, BDD.status]);
  var now = Date.now();
  var hold = {};
  BDD.tpl.decks.forEach(function(dk, i) {
    var n = i + 1, pd = bddDk(n), seen = {};
    pd.zones.forEach(function(z) {
      if (!z.role || seen[z.area]) return;
      seen[z.area] = true;
      var sides = {};
      BDD.units.forEach(function(u) {
        if (u.deck !== n) return;
        var uz = bdZoneAt(pd, u.x, u.y);
        if (uz && uz.area === z.area) sides[u.side] = true;
      });
      var k = Object.keys(sides);
      if (k.length === 1) hold[z.role] = { side: k[0], deck: n, area: z.area };
    });
  });
  BDD.hold = hold;

  if (BDD.status === 'active') {
    if (hold.bridge && hold.bridge.side === 'att') { if (!BDD.since) BDD.since = now; }
    else BDD.since = null;
    if (!BDD.units.some(function(u) { return u.side === 'att'; })) bddFinish('repelled', 'all_down');
    else if (BDD.since && now - BDD.since >= BDD.need * 1000) bddFinish('captured', 'bridge');
  }

  // Шаги подсказки
  var d = BDD.done;
  var att = BDD.units.filter(function(u) { return u.side === 'att'; });
  if (att.some(function(u) { var z = bddZone(u); return !z || z.kind !== 'lock'; })) d.out = true;
  if (!bddById(BDD_FOES[0].id)) d.shot = true;
  if (BDD.doors.s1d4 === 'open' || BDD.doors.s1d16 === 'open') d.door = true;
  if (BDD.doors.s1b1 === 'broken' || BDD.doors.s1b2 === 'broken') d.breach = true;
  if (att.some(function(u) { return u.deck === 2; })) d.lift = true;
  if (hold.bridge && hold.bridge.side === 'att') d.hatch = true;
  if (BDD.status === 'captured') d.bridge = true;
  // Шаг — следующий за самым дальним пройденным: кто обошёл охрану
  // или нашёл путь короче, не застревает на пропущенной подсказке
  var step = 0;
  BDD_STEPS.forEach(function(x, i) { if (d[x.k]) step = i + 1; });
  if (step !== BDD.step) { BDD.step = step; BDD.flash = now; BDD.coachOpen = true; }

  return before !== JSON.stringify([BDD.hold, BDD.since, BDD.done, BDD.status]);
}

function bddFinish(status, result) {
  if (BDD.status !== 'active') return;
  BDD.status = status;
  BDD.result = result;
  BDD.finished = Date.now();
  if (BDD.timer) { clearInterval(BDD.timer); BDD.timer = null; }
  if (status === 'captured') {
    BDD.done.bridge = true;
    try { localStorage.setItem('bd-drill-done', '1'); } catch (e) {}
  }
}

// Страница перечитывает снимок — как после реалтайма
function bddRefresh() {
  BDD.rev++;
  if (typeof bdLoad === 'function') bdLoad(true);
}

// ---------- снимок как у get_boarding ----------

function bddVisible() {
  var mine = {}, out = {};
  BDD.units.forEach(function(u) {
    if (u.side !== 'att') return;
    var z = bddZone(u);
    if (z) mine[u.deck + ':' + z.id] = true;
  });
  Object.keys(mine).forEach(function(k) { out[k] = true; });
  BDD.tpl.decks.forEach(function(dk, i) {
    var n = i + 1;
    (dk.doors || []).forEach(function(x) {
      var st = BDD.doors[x.id] || 'open';
      if (x.kind !== 'lift' && st !== 'open' && st !== 'broken') return;
      if (mine[n + ':' + x.z1]) out[n + ':' + x.z2] = true;
      if (mine[n + ':' + x.z2]) out[n + ':' + x.z1] = true;
    });
  });
  return out;
}

function bddSnap() {
  var now = Date.now(), vis = bddVisible();
  var units = [];
  BDD.units.forEach(function(u) {
    var z = bddZone(u), zid = z ? z.id : null;
    var own = u.side === 'att';
    if (!own && !vis[u.deck + ':' + zid]) return;
    units.push({
      id: u.id, side: u.side, mine: own, deck: u.deck, x: u.x, y: u.y, zone: zid, watch: own && u.watch,
      type: u.type, type_name: u.type_name, name: u.name, image: u.image, hero: u.hero, engineer: u.engineer,
      hp: u.hp, max_hp: u.max_hp, mr: u.mr, wr: u.wr, vr: u.vr, acc: u.acc, eva: u.eva, dmg: u.dmg, hull: u.hull,
      ap: own ? bddAp(u, now) : null, ap_max: own ? 2 : null, next_in: own ? bddNextIn(u, now) : null
    });
  });
  var visible = Object.keys(vis).map(function(k) { var p = k.split(':'); return { deck: +p[0], zone: p[1] }; });
  var turrets = [];
  BDD.tpl.decks.forEach(function(dk, i) {
    (dk.turrets || []).forEach(function(t) {
      turrets.push({ k: (i + 1) + ':' + t[0] + ':' + t[1], deck: i + 1, x: t[0], y: t[1], hp: 0, max: 150, off: true });
    });
  });
  var doors = {};
  Object.keys(BDD.doors).forEach(function(k) { doors[k] = BDD.doors[k]; });
  // Отсеки — как отдаёт сервер атакующему: свои, мостик, реактор и то, что на виду
  var hold = {};
  Object.keys(BDD.hold).forEach(function(role) {
    var h = BDD.hold[role], seen = h.side === 'att' || role === 'bridge' || role === 'reactor';
    if (!seen) {
      bddDk(h.deck).zones.forEach(function(z) { if (z.area === h.area && vis[h.deck + ':' + z.id]) seen = true; });
    }
    if (seen) hold[role] = h;
  });
  var d = BDD.data;
  return {
    id: 'drill', drill: true, status: BDD.status, result: BDD.result, side: 'att',
    template: BDD.tpl.id, port: 'n', alarm: false, doors: doors, jam: BDD_JAM, rev: BDD.rev,
    system_id: d.system_id, started_at: bddIso(BDD.t0), ends_at: bddIso(BDD.ends),
    finished_at: BDD.finished ? bddIso(BDD.finished) : null, server_now: bddIso(now),
    attacker: d.attacker, defender: d.defender,
    units: units, visible: visible, turrets: turrets, fx: BDD.fx.slice(), seq: BDD.seq,
    reserve: 0, reserve_types: [], lock_free: 0, vehicles: 0,
    hold: hold, eff: {},
    bridge: BDD.since ? { since: BDD.since, need: BDD.need } : null,
    charge: null, alarm_cd: null, vent_cd: null,
    stats: BDD.stats, helpers: [], bridge_need: BDD.need
  };
}

function bddGet() { return bddOk(bddSnap()); }

// ---------- приказы ----------

function bddRpc(name, a) {
  if (!BDD) return bddErr('Учение не началось');
  if (name === 'boarding_withdraw') {
    bddFinish('withdrawn', null);
    BDD.rev++;
    return bddOk('withdrawn');
  }
  if (BDD.status !== 'active') return bddErr('Учение уже окончено');
  if (!BDD.begun) return bddErr('Сначала прочитай задание');
  var u = bddById(a.p_unit_id);
  if (!u || u.side !== 'att') return bddErr('Этого бойца нет на борту');
  var now = Date.now(), res;
  if (name === 'boarding_move') res = bddMove(u, a.p_path, now);
  else if (name === 'boarding_shoot') res = bddShoot(u, a.p_target, now);
  else if (name === 'boarding_door') res = bddDoor(u, a.p_door, a.p_action, now);
  else if (name === 'boarding_pass') res = bddPass(u, a.p_kind, a.p_deck, now);
  else if (name === 'boarding_watch') {
    if (a.p_on && (bddReach(u) <= 0 || !(u.dmg > 0))) res = { error: 'Этот боец не вооружён' };
    else { u.watch = !!a.p_on; res = { data: u.watch }; }
  } else res = { error: 'В учении это не нужно — цель одна: мостик' };
  if (res.error) return bddErr(res.error);
  BDD.rev++;
  bddCheck();
  // Охрана отвечает в следующем такте — не в этом же ответе
  return bddOk(res.data);
}

function bddMove(u, path, now) {
  if (!path || !path.length) return { error: 'Путь не задан' };
  var mr = u.mr || 0;
  if (mr <= 0) return { error: 'Боец не может ходить' };
  if (path.length > mr * 2) return { error: 'Слишком далеко: за два действия не больше ' + mr * 2 + ' клеток' };
  var cost = Math.ceil(path.length / mr), ap = bddAp(u, now);
  if (ap < cost) return { error: 'Нужно действий: ' + cost + ', готово: ' + ap };
  var g = bddGeo(u.deck), occ = bddOcc(u.deck, u.id);
  var cx = u.x, cy = u.y;
  for (var i = 0; i < path.length; i++) {
    var nx = path[i][0], ny = path[i][1];
    if (!bdrStepOk(g, BDD.doors, cx, cy, nx, ny)) return { error: 'Путь перекрыт: стена, закрытая дверь или предмет' };
    var o = occ[nx + ',' + ny];
    if (o && (o !== u.side || i === path.length - 1)) return { error: 'Клетка занята' };
    cx = nx; cy = ny;
  }
  bddSpend(u, cost, now);
  bddFx({ k: 'mv', side: u.side, u: u.id, d: u.deck, p: [[u.x, u.y]].concat(path) });
  u.x = cx; u.y = cy; u.watch = false;
  return { data: { x: cx, y: cy, cost: cost } };
}

function bddShoot(u, target, now) {
  if (bddReach(u) <= 0 || !(u.dmg > 0)) return { error: 'Этот боец не вооружён' };
  if (bddAp(u, now) < 1) return { error: 'Нужно действий: 1, готово: 0' };
  var t = target ? bddById(target) : null;
  if (!t) return { error: 'Цель уже не на борту' };
  if (t.side === u.side) return { error: 'Это свой боец' };
  if (t.deck !== u.deck) return { error: 'Цель на другой палубе' };
  var gap = Math.max(Math.abs(t.x - u.x), Math.abs(t.y - u.y)), r = bddReach(u);
  if (gap > r) return { error: 'Слишком далеко: бьёт на ' + r + ' клет., до цели ' + gap };
  if (!bdrLos(bddGeo(u.deck), BDD.doors, u.x, u.y, t.x, t.y)) return { error: 'Нет линии огня: мешает стена, дверь или предмет' };
  bddSpend(u, 1, now);
  u.watch = false;
  return { data: bddFire(u, t, 'u', 0) };
}

function bddDoor(u, id, act, now) {
  var dk = bddDk(u.deck), d = dk._doorById[id];
  if (!d) return { error: 'Двери нет на плане' };
  if (!((d.c1[0] === u.x && d.c1[1] === u.y) || (d.c2[0] === u.x && d.c2[1] === u.y))) return { error: 'Боец должен стоять вплотную к двери' };
  if (d.kind === 'lift') return { error: 'Проём лифта не закрывается' };
  if (BDD_JAM[id]) return { error: 'Заклинило: в учении к мостику ведут лифт и люк' };
  var st = BDD.doors[id] || 'open', nw = null, cost = 0;
  if (st === 'broken') return { error: 'Дверь выбита — её больше не закрыть' };
  if (d.kind === 'door') {
    if (act === 'close' && st === 'open') { nw = 'closed'; cost = 1; }
    else if (act === 'open' && st === 'closed') { nw = 'open'; cost = 0; }
    else if (act === 'lock' && (st === 'open' || st === 'closed')) { nw = 'locked'; cost = 1; }
    else if (act === 'breach' && st === 'locked') { nw = 'broken'; cost = 1; }
  } else if (act === 'breach' && st === 'locked') {
    nw = 'broken'; cost = u.engineer ? 1 : 2;
  }
  if (!nw) return { error: 'Так с этой дверью сейчас нельзя' };
  var ap = bddAp(u, now);
  if (cost > ap) return { error: 'Нужно действий: ' + cost + ', готово: ' + ap };
  if (cost) bddSpend(u, cost, now);
  BDD.doors[id] = nw;
  u.watch = false;
  if (nw === 'broken') bddStat('att', 'breach');
  return { data: nw };
}

// Ближайшая свободная клетка у выхода (как boarding_free_near)
function bddFreeNear(n, x, y, r, except) {
  var g = bddGeo(n), occ = bddOcc(n, except), best = null, bd = 0, zone = g.zone[y * g.w + x];
  for (var dy = -r; dy <= r; dy++) {
    for (var dx = -r; dx <= r; dx++) {
      var cx = x + dx, cy = y + dy;
      if (!bdrFree(g, cx, cy) || occ[cx + ',' + cy] || g.zone[cy * g.w + cx] !== zone) continue;
      var dd = Math.max(Math.abs(dx), Math.abs(dy)) * 10 + Math.abs(dx) + Math.abs(dy);
      if (!best || dd < bd) { best = [cx, cy]; bd = dd; }
    }
  }
  return best;
}

function bddPass(u, kind, deck, now) {
  var dk = bddDk(u.deck), cost, to, tx, ty, i;
  if (kind === 'lift') {
    cost = 1;
    var z = bdZoneAt(dk, u.x, u.y);
    if (!z || z.kind !== 'lift') return { error: 'Боец не в кабине лифта' };
    to = deck;
    if (!to || to === u.deck || to < 1 || to > BDD.tpl.decks.length) return { error: 'Выбери палубу' };
    var box = null;
    (BDD.tpl.decks[to - 1].lifts || []).forEach(function(l) { if (l.code === z.area) box = l.box; });
    if (!box) return { error: 'Лифт не идёт на П' + to };
    var g2 = bddGeo(to), occ = bddOcc(to, u.id), best = null, bd = 0;
    for (i = 0; i < 4; i++) {
      var lx = box[0] + (i % 2), ly = box[1] + Math.floor(i / 2);
      if (occ[lx + ',' + ly] || g2.solid[ly * g2.w + lx] !== 0) continue;
      var dd = Math.abs(lx - u.x) + Math.abs(ly - u.y);
      if (!best || dd < bd) { best = [lx, ly]; bd = dd; }
    }
    if (!best) return { error: 'Кабина на П' + to + ' занята' };
    tx = best[0]; ty = best[1];
  } else if (kind === 'hatch' || kind === 'duct') {
    cost = 2;
    var hit = null;
    if (kind === 'hatch') {
      (dk.hatches || []).forEach(function(h) { if (h.x === u.x && h.y === u.y && h.to) hit = { to: h.to[0], x: h.to[1], y: h.to[2] }; });
      if (!hit) return { error: 'Боец не у люка' };
    } else {
      (dk.ducts || []).forEach(function(d) {
        if (d.a[0] === u.x && d.a[1] === u.y) hit = { to: u.deck, x: d.b[0], y: d.b[1] };
        else if (d.b[0] === u.x && d.b[1] === u.y) hit = { to: u.deck, x: d.a[0], y: d.a[1] };
      });
      if (!hit) return { error: 'Боец не у лаза' };
    }
    to = hit.to;
    var foeAt = BDD.units.some(function(x) { return x.deck === to && x.side !== u.side && x.x === hit.x && x.y === hit.y; });
    if (foeAt) return { error: 'Выход занят противником' };
    var f = bddFreeNear(to, hit.x, hit.y, 2, u.id);
    if (!f) return { error: 'По ту сторону всё занято' };
    tx = f[0]; ty = f[1];
  } else {
    return { error: 'Неизвестный переход' };
  }
  var ap = bddAp(u, now);
  if (ap < cost) return { error: 'Нужно действий: ' + cost + ', готово: ' + ap };
  bddSpend(u, cost, now);
  bddFx({ k: 'tp', via: kind, side: u.side, u: u.id, d: u.deck, f: [u.x, u.y], d2: to, t: [tx, ty] });
  u.deck = to; u.x = tx; u.y = ty; u.watch = false;
  return { data: { deck: to, x: tx, y: ty, cost: cost } };
}

// ---------- подсказки ----------

function bddCoachStep() {
  if (!BDD || BDD.status !== 'active' || !BDD.begun) return null;
  return BDD_STEPS[BDD.step] || null;
}

// Куда показывать: палуба и точка на плане
function bddMark(st) {
  if (!st) return null;
  var area = function(deck, id) {
    var z = bddDk(deck)._zoneById[id];
    return z ? { deck: deck, x: z.box[0] + z.box[2] / 2, y: z.box[1] + z.box[3] / 2 } : null;
  };
  var door = function(deck, id) {
    var d = bddDk(deck)._doorById[id];
    return d ? { deck: deck, x: (d.c1[0] + d.c2[0]) / 2 + 0.5, y: (d.c1[1] + d.c2[1]) / 2 + 0.5 } : null;
  };
  if (st.k === 'out') return { deck: 1, x: 16.5, y: 6.5 };
  if (st.k === 'shot') {
    var f = bddById(BDD_FOES[0].id);
    return f ? { deck: f.deck, x: f.x + 0.5, y: f.y + 0.5 } : null;
  }
  if (st.k === 'door') return door(1, 's1d4');
  if (st.k === 'breach') return { deck: 1, x: 14, y: 9 };
  if (st.k === 'lift') return { deck: 1, x: 10, y: 7 };
  if (st.k === 'hatch') return { deck: 2, x: 36.5, y: 8.5 };
  if (st.k === 'bridge') return area(1, 'brg');
  return null;
}

function bddCoachDeck() {
  var m = bddMark(bddCoachStep());
  return m ? m.deck : null;
}

function bddCoachHtml() {
  var st = bddCoachStep();
  if (!st) return '';
  var n = BDD.step + 1, total = BDD_STEPS.length, dots = '';
  for (var i = 0; i < total; i++) {
    var k = BDD_STEPS[i].k;
    dots += '<i class="' + (i < BDD.step ? (BDD.done[k] ? 'done' : 'skip') : i === BDD.step ? 'now' : '') + '"></i>';
  }
  var m = bddMark(st);
  var where = m && m.deck !== bdDeck ? '<span class="bd-coach-deck">на П' + m.deck + '</span>' : '';
  return '<div class="bd-coach' + (BDD.coachOpen ? '' : ' shut') + '" data-act="coach">' +
    '<div class="bd-coach-head">' +
      '<span class="bd-coach-n">Шаг ' + n + ' / ' + total + '</span>' +
      '<b>' + bdEsc(st.title) + '</b>' + where +
      '<span class="bd-coach-dots">' + dots + '</span>' +
      '<i class="bd-coach-fold" aria-hidden="true"></i>' +
    '</div>' +
    '<div class="bd-coach-text">' + bdEsc(st.text.replace('{need}', BDD.need)) + '</div>' +
  '</div>';
}

function bddCoachRender() {
  var box = document.getElementById('bd-coach-box');
  if (!BDD) { if (box) box.innerHTML = ''; return; }
  if (!box) {
    box = document.createElement('div');
    box.id = 'bd-coach-box';
    document.body.appendChild(box);
    box.addEventListener('click', function(e) {
      var b = e.target.closest ? e.target.closest('[data-act="coach"]') : null;
      if (!b || !BDD) return;
      BDD.coachOpen = !BDD.coachOpen;
      bddCoachRender();
    });
  }
  // Перерисовываем, только когда текст поменялся: иначе вспышка нового шага
  // запускалась бы заново с каждым снимком
  var html = bddCoachHtml();
  if (box.getAttribute('data-html') !== html) {
    box.innerHTML = html;
    box.setAttribute('data-html', html);
    var stepNow = String(BDD.step);
    if (box.getAttribute('data-step') !== stepNow) {
      var el = box.firstChild;
      if (el && box.getAttribute('data-step') !== null) el.classList.add('fresh');
      box.setAttribute('data-step', stepNow);
    }
  }
  bddCoachPlace();
}

// Над планом, слева от мини-карты
function bddCoachPlace() {
  var box = document.getElementById('bd-coach-box'), view = document.getElementById('bd-view');
  if (!box || !view) return;
  var r = view.getBoundingClientRect();
  var mini = (typeof BDC !== 'undefined' && BDC && BDC.miniRect) ? BDC.miniRect.w + 22 : 84;
  box.style.top = Math.round(r.top + 8) + 'px';
  box.style.left = Math.round(r.left + 8) + 'px';
  box.style.width = Math.max(180, Math.round(r.width - 16 - mini)) + 'px';
}

// Маяк на плане: кольцо у цели шага, у края — стрелка, если цель за экраном
function bddBeacon(c, dk, s, T) {
  if (!BDD) return;
  var m = bddMark(bddCoachStep());
  if (!m || m.deck !== dk.n) return;
  // Мостик уже наш — над ним и так отсчёт захвата
  if (BDD.since) return;
  var p = bdcToScreen(m.x, m.y), vw = BDC.vw, vh = BDC.vh, pad = 26;
  var st = bddCoachStep(), still = BDC.reduce;
  var gold = '#f0d48a';
  c.save();
  var inside = p[0] > pad && p[0] < vw - pad && p[1] > pad && p[1] < vh - pad;
  if (inside) {
    var R = Math.max(14, s * 0.85);
    for (var i = 0; i < (still ? 1 : 2); i++) {
      var ph = still ? 0.35 : ((T * 0.9 + i * 0.5) % 1);
      c.strokeStyle = bdcAlpha(gold, 0.9 * (1 - ph));
      c.lineWidth = 2;
      c.beginPath(); c.arc(p[0], p[1], R * (0.7 + ph * 0.9), 0, 7); c.stroke();
    }
    c.fillStyle = gold; c.beginPath(); c.arc(p[0], p[1], 3, 0, 7); c.fill();
    bddTag(c, st.tag, p[0], p[1] - R - 14, gold);
  } else {
    var cx = vw / 2, cy = vh / 2, dx = p[0] - cx, dy = p[1] - cy;
    var k = Math.min((vw / 2 - pad) / Math.max(1, Math.abs(dx)), (vh / 2 - pad) / Math.max(1, Math.abs(dy)));
    var ex = cx + dx * k, ey = cy + dy * k, a = Math.atan2(dy, dx);
    var bob = still ? 0 : Math.sin(T * 4) * 3;
    c.translate(ex - Math.cos(a) * bob, ey - Math.sin(a) * bob);
    c.rotate(a);
    c.fillStyle = 'rgba(40,30,8,0.92)'; c.strokeStyle = gold; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(12, 0); c.lineTo(-8, -10); c.lineTo(-3, 0); c.lineTo(-8, 10); c.closePath();
    c.fill(); c.stroke();
    c.setTransform(BDC.dpr, 0, 0, BDC.dpr, 0, 0);
    var tx = Math.max(40, Math.min(vw - 40, ex - Math.cos(a) * 30)), ty = Math.max(18, Math.min(vh - 18, ey - Math.sin(a) * 26));
    bddTag(c, st.tag, tx, ty, gold);
  }
  c.restore();
}

function bddTag(c, txt, x, y, col) {
  c.font = 'bold 10px "Courier New", monospace';
  var w = c.measureText(txt).width + 14;
  c.fillStyle = 'rgba(40,30,8,0.92)'; bdcRR(c, x - w / 2, y - 8, w, 16, 8); c.fill();
  c.strokeStyle = col; c.lineWidth = 1; c.stroke();
  c.fillStyle = col; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(txt, x, y + 0.5);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
}

// ---------- вступление и итог ----------

function bddIntro() {
  var d = BDD.data, box = document.getElementById('bd-end');
  var pics = d.party.map(function(p) {
    return '<span class="bd-drill-pic' + (p.hero ? ' hero' : '') + '" title="' + bdEsc(p.name) + '">' +
      (p.image ? '<img src="../' + bdEsc(p.image) + '" alt="">' : '') + '</span>';
  }).join('');
  var real = Math.round((d.battle_action_seconds || 30));
  box.innerHTML = '<div class="bd-end-card drill">' +
    '<div class="bd-end-kicker">Учебный абордаж</div>' +
    '<div class="bd-end-title">' + bdEsc(d.defender.name) + '</div>' +
    '<div class="bd-drill-ship">' + (d.defender.image ? '<img src="../' + bdEsc(d.defender.image) + '" alt="">' : '') +
      '<span>' + bdEsc(d.defender.type_name || '') + ' · 2 палубы · турели отключены</span></div>' +
    '<div class="bd-drill-party">' + pics + '</div>' +
    '<div class="bd-end-text">В бой идут копии бойцов из трюма «' + bdEsc(d.attacker.name) + '»: ' +
      'настоящие остаются на месте, потерь нет. Охрана — трое: «' + bdEsc(d.foe.name) + '», у каждого половина здоровья. ' +
      'Стоят на местах и стреляют, когда видят бойца.</div>' +
    '<ul class="bd-drill-goals">' +
      '<li><b>Цель</b><span>захватить мостик — подсказки ведут по шагам</span></li>' +
      '<li><b>Темп</b><span>действие копится ' + Math.round(BDD.cd / 1000) + ' с — в настоящем бою ' + real + ' с</span></li>' +
    '</ul>' +
    '<button class="bd-btn wide go" data-act="drill-start">Начать учение</button>' +
    '<button class="bd-btn wide bd-drill-later" data-act="orbit">На орбиту</button>' +
  '</div>';
  box.classList.add('open');
}

function bddEndHtml(s) {
  var t = {
    captured: ['Учение пройдено', 'Мостик удержан. В настоящем абордаже удержание длится 3 минуты, турели бьют сами, ' +
      'защитник объявляет тревогу и шлёт подкрепление, а заряд в реакторе взрывает корабль вместе с экипажем.'],
    repelled: ['Группа погибла', 'Копии бойцов пали — настоящие целы. Стреляй первым: подходи так, чтобы до врага было 3 клетки, и держи «На чеку».'],
    withdrawn: ['Учение прервано', 'Начать заново можно в любой момент — из панели корабля на орбите.'],
    timeout: ['Время вышло', 'Двадцать минут прошли. Попробуй ещё раз — путь к мостику тот же.']
  }[s.status] || ['Учение окончено', ''];
  var me = s.stats.att || {};
  var acc = me.shots ? Math.round(100 * (me.hits || 0) / me.shots) + '%' : '—';
  var sec = Math.max(1, Math.round(((BDD.finished || Date.now()) - BDD.t0) / 1000));
  var cell = function(v, k, cls) { return '<div class="bd-end-stat' + (cls ? ' ' + cls : '') + '"><b>' + v + '</b><span>' + k + '</span></div>'; };
  var steps = 0;
  BDD_STEPS.forEach(function(x) { if (BDD.done[x.k]) steps++; });
  var good = s.status === 'captured';
  return '<div class="bd-end-card drill ' + (good ? 'good' : '') + '">' +
    '<div class="bd-end-kicker">Учебный абордаж</div>' +
    '<div class="bd-end-title">' + bdEsc(t[0]) + '</div>' +
    '<div class="bd-end-text">' + bdEsc(t[1]) + '</div>' +
    '<div class="bd-end-stats">' +
      cell(me.kills || 0, 'врагов снято', 'good') +
      cell(me.lost || 0, 'копий потеряно', me.lost ? 'bad' : '') +
      cell(acc, 'точность · ' + (me.shots || 0) + ' выстр.') +
      cell(me.breach || 0, 'дверей взломано') +
      cell(bdClock(sec), 'длилось') +
      cell(steps + ' / ' + BDD_STEPS.length, 'шагов пройдено', good ? 'good' : '') +
    '</div>' +
    (good ? '<div class="bd-end-extra">Настоящий абордаж — плитка «Абордаж» у корабля вплотную к врагу</div>' : '') +
    '<div class="bd-acts">' +
      '<button class="bd-btn" data-act="drill-again">Ещё раз</button>' +
      '<button class="bd-btn go" data-act="orbit">На орбиту</button>' +
    '</div>' +
  '</div>';
}

// Кнопки вступления и итога; true — разобрано здесь
function bddClick(b) {
  var act = b.getAttribute('data-act');
  if (act === 'drill-start') {
    document.getElementById('bd-end').classList.remove('open');
    bddBegin();
    return true;
  }
  if (act === 'drill-again') { location.reload(); return true; }
  return false;
}
