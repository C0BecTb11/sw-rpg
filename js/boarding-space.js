// Абордаж на карте космоса: плитка «Абордаж» в панели корабля,
// выбор цели и группы, значок сцепки между кораблями. Тап по значку
// своего абордажа переводит на палубы (game/boarding.html).

var bdsList = [];          // идущие абордажи системы
var bdsAllowed = null;     // открыт ли абордаж игроку (тестеры или всем)
var bdsSeq = 0;
var bdsTimer = null;
var bdsUnitTypes = null;   // id → { name, image, is_vehicle, is_hero, can_build }
var bdsPick = null;        // { ship, target, rows: [...], counts: {} } — сборка группы
var bdsBusy = false;
// Бойцов в шлюзе: у крупного корабля (3 палубы) шлюз 6×5, у малого (2 палубы) — 5×4
function bdsLock(t) { return t && t.deck_count >= 3 ? 30 : 20; }

function bdsEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bdsByShip(id) {
  for (var i = 0; i < bdsList.length; i++) {
    var b = bdsList[i];
    if (b.attacker_ship_id === id || b.target_ship_id === id) return b;
  }
  return null;
}

function bdsUrl(b) { return 'boarding.html?id=' + encodeURIComponent(b.id); }

// После каждой загрузки флота (space-battle.js → loadShips). Флот в бою
// перечитывается часто — сцепки спрашиваем не чаще раза в 3 секунды
var bdsLast = 0;
var bdsLater = null;

function bdsLoad() {
  if (typeof systemId === 'undefined' || !systemId) return;
  var wait = 3000 - (Date.now() - bdsLast);
  if (wait > 0) {
    if (!bdsLater) bdsLater = setTimeout(function() { bdsLater = null; bdsLoad(); }, wait);
    return;
  }
  bdsLast = Date.now();
  if (bdsAllowed === null) {
    bdsAllowed = false;
    supabase.rpc('boarding_allowed').then(function(r) {
      // Сбой сети — спросим снова со следующей загрузкой флота
      bdsAllowed = r.error ? null : r.data === true;
      if (typeof scShip !== 'undefined' && scShip && typeof scRenderTiles === 'function') scRenderTiles();
    });
  }
  var my = ++bdsSeq;
  supabase.rpc('get_system_boardings', { p_system_id: systemId }).then(function(res) {
    if (my !== bdsSeq) return;
    if (res.error) return;
    bdsList = res.data || [];
    bdsRender();
    if (typeof scShip !== 'undefined' && scShip && typeof scRenderTiles === 'function') scRenderTiles();
    // Абордаж кончается без движения кораблей — значок снимаем опросом
    if (bdsTimer) { clearTimeout(bdsTimer); bdsTimer = null; }
    if (bdsList.length) bdsTimer = setTimeout(function() { if (!document.hidden) bdsLoad(); }, 20000);
  });
}

// Значок сцепки: между центрами двух кораблей
function bdsRender() {
  if (typeof grid === 'undefined' || !grid) return;
  var old = grid.querySelectorAll('.bd-clamp');
  for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
  var marked = grid.querySelectorAll('.ship-sprite.bd-coupled');
  for (var j = 0; j < marked.length; j++) marked[j].classList.remove('bd-coupled');

  bdsList.forEach(function(b) {
    var a = sxShipById(b.attacker_ship_id), t = sxShipById(b.target_ship_id);
    if (!a || !t || a.x === null || t.x === null) return;
    var ta = shipTypeById[a.ship_type], tt = shipTypeById[t.ship_type];
    if (!ta || !tt) return;
    var ba = shipBoxCells(ta, a.facing || 0), bt = shipBoxCells(tt, t.facing || 0);
    var cx = ((a.x + ba.w / 2) + (t.x + bt.w / 2)) / 2;
    var cy = ((a.y + ba.h / 2) + (t.y + bt.h / 2)) / 2;
    var size = CELL_PX * 1.5;

    var el = document.createElement('div');
    el.className = 'bd-clamp' + (b.mine ? ' mine ' + b.side : '');
    el.style.left = (cx * CELL_PX - size / 2) + 'px';
    el.style.top = (cy * CELL_PX - size / 2) + 'px';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true">' +
      '<circle cx="20" cy="20" r="17" class="r"/>' +
      '<path d="M7 13L14 20L7 27M33 13L26 20L33 27" class="c"/><circle cx="20" cy="20" r="2.6" class="d"/></svg>' +
      (b.mine ? '<span class="bd-clamp-t">' + (b.side === 'att' ? 'на борт' : 'оборона') + '</span>' : '');
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      if (b.mine) { location.href = bdsUrl(b); return; }
      if (typeof sxReport === 'function') {
        sxReport({ kind: 'info', title: 'Абордаж',
          attacker: sxShipPic(a, ta), target: sxShipPic(t, tt),
          lines: [{ text: 'Корабли сцеплены: идёт бой на палубах' }] });
      }
    });
    grid.appendChild(el);

    [a.id, t.id].forEach(function(id) {
      var sp = grid.querySelector('.ship-sprite[data-ship-id="' + id + '"]');
      if (sp) sp.classList.add('bd-coupled');
    });
  });
}

// ---------- плитка в панели корабля ----------

function bdsHint() {
  if (typeof scShip === 'undefined' || !scShip) return '';
  var b = bdsByShip(scShip.id);
  if (b && b.mine) return 'Корабль сцеплен — бой идёт на палубах';
  return 'Цель — вражеский корабль вплотную, не дальше 1 клетки';
}

function bdsAddTile(add, describe) {
  if (typeof scShip === 'undefined' || !scShip || !scType || scType.is_fighter) return;
  var b = bdsByShip(scShip.id);
  if (b && b.mine) {
    add('board', '⇥', 'На борт', true, function() {
      var left = Math.max(0, Math.floor((new Date(b.ends_at).getTime() - (Date.now() + (scTimeOffset || 0))) / 1000));
      describe('Абордаж идёт',
        b.side === 'att'
          ? 'Группа на борту цели. Корабли сцеплены: не ходят, не разворачиваются и не прыгают, трюм закрыт.'
          : 'Противник на борту. Корабли сцеплены, трюм закрыт — защищай палубы.',
        'до конца ' + Math.floor(left / 60) + ' мин');
      var info = document.getElementById('sc-abil-info');
      if (info && scMode === 'board') {
        var go = document.createElement('button');
        go.className = 'sc-hangar-btn wide bds-go';
        go.textContent = 'Открыть палубы';
        go.addEventListener('click', function() { location.href = bdsUrl(b); });
        info.appendChild(go);
      }
    });
    return;
  }
  if (!bdsAllowed || scCargoCap(scShip, scType) <= 0) return;
  var canAct = scApState(scShip).ap >= 1;
  add('board', '⇥', 'Абордаж', canAct && !b, function() {
    bdsPick = null;
    describe('Абордаж',
      'Подойди вплотную, не дальше 1 клетки. Щит цели на этом борту должен быть пробит, или цель держит луч захвата.',
      b ? 'корабль уже сцеплен' : canAct ? null : 'нет очков действий');
    if (!b) bdsTargets(document.getElementById('sc-abil-info'));
  });
}

function bdsLoadTypes() {
  if (bdsUnitTypes) return Promise.resolve(bdsUnitTypes);
  return Promise.resolve(supabase.from('unit_types').select('id, name, image, is_vehicle, is_hero, can_build')).then(function(r) {
    if (r.error || !r.data) return null;
    bdsUnitTypes = {};
    r.data.forEach(function(t) { bdsUnitTypes[t.id] = t; });
    return bdsUnitTypes;
  });
}

function bdsSideWord(port) { return port === 'n' ? 'левый борт' : 'правый борт'; }

function bdsTargets(box) {
  if (!box || !scShip) return;
  var forShip = scShip.id;
  var head = box.innerHTML;
  var wait = document.createElement('div');
  wait.className = 'sc-abil-meta';
  wait.textContent = 'Ищем цели рядом…';
  box.appendChild(wait);

  Promise.all([
    supabase.rpc('get_boarding_targets', { p_ship_id: forShip }),
    supabase.rpc('get_ship_holds'),
    bdsLoadTypes()
  ]).then(function(r) {
    if (!scShip || scShip.id !== forShip || scMode !== 'board') return;
    var targets = (!r[0].error && r[0].data) ? r[0].data : [];
    var holds = (!r[1].error && r[1].data) ? r[1].data : [];
    var types = r[2] || {};
    box.innerHTML = head;

    // Пехота и герои этого корабля по типам
    var byType = {};
    holds.forEach(function(h) {
      if (h.ship_id !== forShip) return;
      var t = types[h.unit_type];
      if (!t || t.is_vehicle) return;
      if (!byType[h.unit_type]) byType[h.unit_type] = { type: h.unit_type, name: h.unit_name, image: h.unit_image, n: 0, hero: !!t.is_hero, eng: !!t.can_build };
      byType[h.unit_type].n += h.quantity || 1;
    });
    var rows = Object.keys(byType).map(function(k) { return byType[k]; });
    var total = rows.reduce(function(s, x) { return s + x.n; }, 0);

    if (!total) {
      bdsMeta(box, 'В трюме нет пехоты. Абордажная группа набирается из трюма — техника в бой на палубах не идёт.', true);
      return;
    }
    if (!targets.length) {
      bdsMeta(box, 'Рядом нет целей. Подойди к вражескому кораблю вплотную — не дальше 1 клетки.');
      return;
    }

    targets.forEach(function(t) {
      var b = document.createElement('button');
      b.className = 'sc-hangar-btn wide bds-target' + (t.ready ? ' ready' : '');
      b.disabled = !t.ready;
      b.innerHTML = '<span class="bds-t-pic">' + (t.image ? '<img src="../' + bdsEsc(t.image) + '" alt="">' : '') + '</span>' +
        '<span class="bds-t-body"><b>' + bdsEsc(t.ship_name) + '</b>' +
        '<i>' + (t.ready ? (t.held ? 'в луче захвата' : 'щит борта пробит') + ' · ' + bdsSideWord(t.port) : bdsEsc(t.reason || '')) +
        ' · палуб ' + t.deck_count + '</i></span>';
      b.addEventListener('click', function() {
        bdsPick = { ship: forShip, target: t, rows: rows, counts: bdsAutoParty(rows, bdsLock(t)) };
        bdsParty(box, head);
      });
      box.appendChild(b);
    });
  });
}

function bdsMeta(box, text, warn) {
  var m = document.createElement('div');
  m.className = 'sc-abil-meta' + (warn ? ' warn' : '');
  m.textContent = text;
  box.appendChild(m);
}

// Первая волна по умолчанию: герои, один инженер (вскрывает шлюз за 1 действие), дальше — кого больше
function bdsAutoParty(rows, lim) {
  var c = {}, left = lim;
  var put = function(r, n) { var k = Math.min(n, r.n - (c[r.type] || 0), left); if (k > 0) { c[r.type] = (c[r.type] || 0) + k; left -= k; } };
  rows.filter(function(r) { return r.hero; }).forEach(function(r) { put(r, r.n); });
  rows.filter(function(r) { return r.eng; }).slice(0, 1).forEach(function(r) { put(r, 1); });
  rows.slice().sort(function(a, b) { return b.n - a.n; }).forEach(function(r) { put(r, r.n); });
  return c;
}

function bdsPartyCount() {
  var s = 0;
  Object.keys(bdsPick.counts).forEach(function(k) { s += bdsPick.counts[k]; });
  return s;
}

function bdsParty(box, head) {
  var p = bdsPick, t = p.target;
  box.innerHTML = head;
  var wrap = document.createElement('div');
  wrap.className = 'bds-party';
  var n = bdsPartyCount(), lim = bdsLock(t);
  var html = '<div class="bds-p-head"><b>«' + bdsEsc(t.ship_name) + '»</b><span>шлюз: ' + bdsSideWord(t.port) + '</span></div>';
  p.rows.forEach(function(r) {
    var k = p.counts[r.type] || 0;
    html += '<div class="bds-row' + (k ? ' on' : '') + '">' +
      '<span class="bds-pic">' + (r.image ? '<img src="../' + bdsEsc(r.image) + '" alt="">' : '') + '</span>' +
      '<span class="bds-name">' + bdsEsc(r.name) + (r.hero ? ' ★' : '') + '<i>в трюме ' + r.n + '</i></span>' +
      '<button class="bds-step" data-t="' + bdsEsc(r.type) + '" data-d="-1"' + (k <= 0 ? ' disabled' : '') + '>−</button>' +
      '<span class="bds-k">' + k + '</span>' +
      '<button class="bds-step" data-t="' + bdsEsc(r.type) + '" data-d="1"' + (k >= r.n || n >= lim ? ' disabled' : '') + '>+</button>' +
    '</div>';
  });
  html += '<div class="bds-total"><span>В шлюз</span><b>' + n + ' / ' + lim + '</b></div>' +
    '<div class="bds-acts">' +
      '<button class="sc-hangar-btn bds-back">Назад</button>' +
      '<button class="sc-hangar-btn bds-go"' + (n ? '' : ' disabled') + '>На абордаж</button>' +
    '</div>' +
    '<div class="bds-note">Остальные бойцы ждут в трюме. Корабли сцепятся: не ходят и не прыгают, пока идёт бой.</div>';
  wrap.innerHTML = html;
  box.appendChild(wrap);

  wrap.addEventListener('click', function(e) {
    var st = e.target.closest ? e.target.closest('.bds-step') : null;
    if (st && !st.disabled) {
      var ty = st.getAttribute('data-t'), d = +st.getAttribute('data-d');
      var row = p.rows.filter(function(r) { return r.type === ty; })[0];
      var cur = p.counts[ty] || 0, nx = cur + d;
      if (nx < 0 || nx > row.n || (d > 0 && bdsPartyCount() >= lim)) return;
      p.counts[ty] = nx;
      bdsParty(box, head);
      return;
    }
    if (e.target.closest && e.target.closest('.bds-back')) {
      bdsPick = null;
      box.innerHTML = head;
      bdsTargets(box);
      return;
    }
    var go = e.target.closest ? e.target.closest('.bds-go') : null;
    if (go && !go.disabled) bdsStart(go);
  });
}

function bdsStart(btn) {
  if (bdsBusy || !bdsPick) return;
  var p = bdsPick;
  var party = Object.keys(p.counts).filter(function(k) { return p.counts[k] > 0; })
    .map(function(k) { return { type: k, n: p.counts[k] }; });
  if (!party.length) return;
  bdsBusy = true;
  btn.disabled = true;
  btn.textContent = 'Стыковка…';
  supabase.rpc('start_boarding', { p_ship_id: p.ship, p_target_id: p.target.target_id, p_party: party }).then(function(res) {
    bdsBusy = false;
    if (res.error || !res.data) {
      btn.disabled = false;
      btn.textContent = 'На абордаж';
      if (typeof scFail === 'function') scFail(res.error ? res.error.message : 'Абордаж не начался');
      return;
    }
    location.href = 'boarding.html?id=' + encodeURIComponent(res.data);
  });
}
