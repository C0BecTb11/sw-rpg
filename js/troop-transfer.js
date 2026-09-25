// Передача войск союзнику.
//
// Устроена как обмен: отправитель собирает, что отдаёт, и предлагает;
// получатель видит состав с картинками и подтверждает. Пока второй
// не согласился, войска остаются у первого. Юниты никуда не летят —
// меняется только хозяин, место остаётся тем же.
//
// Корабль уходит целиком: трюм, ангар, техника с десантом и груз.
// Об этом интерфейс говорит прямо в момент выбора и при подтверждении.
//
// Все проверки на сервере (create_transfer / respond_transfer): здесь
// только сборка и показ.

var trTab = 'give';
var trKind = 'ship';
var trPlanet = 'all';
var trPartners = [];
var trPartner = null;
var trAssets = [];
var trPickedShips = {};   // id → true
var trPickedVehicles = {}; // id → true
var trPickedGroups = {};   // ключ группы → сколько взять
var trGroups = {};         // ключ группы → { ids, snapshot, system_name }
var trBusy = false;

var TR_TABS = [
  { id: 'give',  name: 'Отдать' },
  { id: 'inbox', name: 'Входящие' },
  { id: 'out',   name: 'Мои предложения' }
];

var TR_STATUS = {
  pending:   { text: 'ждёт ответа', cls: 'wait' },
  accepted:  { text: 'принято',     cls: 'good' },
  declined:  { text: 'отклонено',   cls: 'bad' },
  cancelled: { text: 'отозвано',    cls: 'dim' },
  expired:   { text: 'истекло',     cls: 'dim' },
  stale:     { text: 'сорвалось',   cls: 'bad' }
};

// ── Вход ───────────────────────────────────────────────────────────

function openTransferPanel(tab) {
  document.getElementById('tr-panel').style.display = 'flex';
  setTransferTab(tab || 'give');
}

function closeTransferPanel() {
  document.getElementById('tr-panel').style.display = 'none';
  refreshTransferBadge();
}

function setTransferTab(tab) {
  trTab = tab;

  var tabs = document.querySelectorAll('#tr-tabs .tr-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
  }

  document.getElementById('tr-foot').style.display = tab === 'give' ? 'block' : 'none';

  if (tab === 'give') loadGiveTab();
  else loadOffersTab(tab);
}

// Значок входящих: на кнопке «Армия» и на вкладке. Тикает в фоне,
// чтобы предложение не пролежало незамеченным
function refreshTransferBadge() {
  supabase.rpc('get_pending_transfer_count').then(function(res) {
    var n = res.error ? 0 : (res.data || 0);
    var text = n > 9 ? '9+' : String(n);

    var army = document.getElementById('army-badge');
    if (army) { army.textContent = text; army.style.display = n > 0 ? 'block' : 'none'; }

    var entry = document.getElementById('tr-inbox-badge');
    if (entry) { entry.textContent = text; entry.style.display = n > 0 ? 'inline-block' : 'none'; }

    var sub = document.getElementById('tr-inbox-sub');
    if (sub) sub.textContent = n > 0 ? 'ждут подтверждения: ' + n : 'новых предложений нет';

    var tab = document.querySelector('#tr-tabs .tr-tab[data-tab="inbox"] .tr-tab-badge');
    if (tab) { tab.textContent = text; tab.style.display = n > 0 ? 'inline-block' : 'none'; }
  });
}

// ── Вкладка «Отдать» ───────────────────────────────────────────────

function loadGiveTab() {
  var body = document.getElementById('tr-body');
  body.innerHTML = '<div class="tr-empty">Загрузка...</div>';

  trPickedShips = {};
  trPickedVehicles = {};
  trPickedGroups = {};

  Promise.all([
    supabase.rpc('get_transfer_partners'),
    supabase.rpc('get_transferable')
  ]).then(function(r) {
    if (trTab !== 'give') return;

    if (r[0].error || r[1].error) {
      body.innerHTML = '<div class="tr-empty">Не удалось загрузить войска</div>';
      return;
    }

    trPartners = r[0].data || [];
    trAssets = r[1].data || [];

    // Выбранный союзник мог уйти из фракции — тогда сбрасываем
    if (trPartner && !trPartners.some(function(p) { return p.user_id === trPartner; })) {
      trPartner = null;
    }
    if (!trPartner && trPartners.length === 1) trPartner = trPartners[0].user_id;

    buildGroups();
    renderGiveTab();
  });
}

// Пехота одного типа на одной планете — одна карточка со счётчиком:
// выбирать двадцать клонов по одному никто не станет. Технику
// и корабли показываем поштучно — у каждой своё содержимое.
function buildGroups() {
  trGroups = {};
  trAssets.forEach(function(a) {
    if (a.kind !== 'unit' || a.snapshot.vehicle || a.block || a.offered) return;
    var key = a.system_id + '|' + a.snapshot.type;
    if (!trGroups[key]) {
      trGroups[key] = { ids: [], snapshot: a.snapshot, system_id: a.system_id, system_name: a.system_name };
    }
    trGroups[key].ids.push(a.item_id);
  });
}

function renderGiveTab() {
  var body = document.getElementById('tr-body');
  body.innerHTML = '';

  // Кому
  var who = document.createElement('div');
  who.className = 'tr-step';
  who.innerHTML = '<div class="tr-step-title"><span>1</span>Кому передать</div>';

  if (!trPartners.length) {
    who.innerHTML += '<div class="tr-none">В твоей фракции пока нет других игроков</div>';
    body.appendChild(who);
    paintGiveFoot();
    return;
  }

  var list = document.createElement('div');
  list.className = 'tr-partners';
  trPartners.forEach(function(p) {
    var b = document.createElement('button');
    b.className = 'tr-partner' + (p.user_id === trPartner ? ' chosen' : '');
    b.innerHTML = '<span class="tr-partner-pawn">♟</span><span>' + escapeTr(p.nickname) + '</span>';
    b.addEventListener('click', function() {
      trPartner = p.user_id;
      renderGiveTab();
    });
    list.appendChild(b);
  });
  who.appendChild(list);
  body.appendChild(who);

  // Что
  var what = document.createElement('div');
  what.className = 'tr-step';
  what.innerHTML = '<div class="tr-step-title"><span>2</span>Что передать</div>';

  var kinds = document.createElement('div');
  kinds.className = 'tr-kinds';
  [{ id: 'ship', name: 'Корабли' }, { id: 'unit', name: 'Наземные войска' }].forEach(function(k) {
    var n = trAssets.filter(function(a) { return a.kind === k.id; }).length;
    var b = document.createElement('button');
    b.className = 'tr-kind' + (trKind === k.id ? ' active' : '');
    b.innerHTML = k.name + '<em>' + n + '</em>';
    b.addEventListener('click', function() { trKind = k.id; renderGiveTab(); });
    kinds.appendChild(b);
  });
  what.appendChild(kinds);

  // Планеты: фильтр только по тем, где есть что-то этого вида
  var planets = {};
  trAssets.forEach(function(a) {
    if (a.kind === trKind) planets[a.system_id] = a.system_name;
  });
  var ids = Object.keys(planets).sort(function(a, b) { return planets[a].localeCompare(planets[b]); });
  if (trPlanet !== 'all' && !planets[trPlanet]) trPlanet = 'all';

  if (ids.length > 1) {
    var chips = document.createElement('div');
    chips.className = 'tr-planets';
    [{ id: 'all', name: 'Все планеты' }].concat(ids.map(function(id) {
      return { id: id, name: planets[id] };
    })).forEach(function(p) {
      var c = document.createElement('button');
      c.className = 'tr-planet' + (trPlanet === p.id ? ' active' : '');
      c.textContent = p.name;
      c.addEventListener('click', function() { trPlanet = p.id; renderGiveTab(); });
      chips.appendChild(c);
    });
    what.appendChild(chips);
  }

  var items = document.createElement('div');
  items.className = 'tr-items';
  if (trKind === 'ship') renderShipPicks(items);
  else renderUnitPicks(items);
  what.appendChild(items);

  body.appendChild(what);
  paintGiveFoot();
}

function planetMatches(sysId) {
  return trPlanet === 'all' || trPlanet === sysId;
}

function renderShipPicks(box) {
  var ships = trAssets.filter(function(a) { return a.kind === 'ship' && planetMatches(a.system_id); });

  if (!ships.length) {
    box.innerHTML = '<div class="tr-none">Кораблей нет</div>';
    return;
  }

  // Доступные сверху, недоступные — ниже и приглушённо, с причиной
  ships.sort(function(a, b) {
    var la = (a.block || a.offered) ? 1 : 0, lb = (b.block || b.offered) ? 1 : 0;
    if (la !== lb) return la - lb;
    return (a.system_name + a.snapshot.name).localeCompare(b.system_name + b.snapshot.name);
  });

  ships.forEach(function(a) {
    var locked = a.block || (a.offered ? 'уже ждёт подтверждения в другой передаче' : null);
    var card = makeAssetCard(a.snapshot, 'ship', a.system_name, a.is_deep_space);
    if (locked) {
      card.classList.add('locked');
      card.appendChild(makeLockLine(locked));
    } else {
      var check = document.createElement('span');
      check.className = 'tr-check' + (trPickedShips[a.item_id] ? ' on' : '');
      card.querySelector('.tr-card-head').appendChild(check);
      card.classList.toggle('picked', !!trPickedShips[a.item_id]);
      card.addEventListener('click', function() {
        if (trPickedShips[a.item_id]) delete trPickedShips[a.item_id];
        else trPickedShips[a.item_id] = true;
        card.classList.toggle('picked', !!trPickedShips[a.item_id]);
        check.classList.toggle('on', !!trPickedShips[a.item_id]);
        paintGiveFoot();
      });
    }
    box.appendChild(card);
  });
}

function renderUnitPicks(box) {
  var any = false;

  // Пехота группами со счётчиком
  Object.keys(trGroups).sort(function(a, b) {
    var ga = trGroups[a], gb = trGroups[b];
    return (ga.system_name + ga.snapshot.name).localeCompare(gb.system_name + gb.snapshot.name);
  }).forEach(function(key) {
    var g = trGroups[key];
    if (!planetMatches(g.system_id)) return;
    any = true;
    box.appendChild(makeGroupCard(key, g));
  });

  // Техника поштучно, со своим десантом
  var singles = trAssets.filter(function(a) {
    return a.kind === 'unit' && planetMatches(a.system_id) &&
           (a.snapshot.vehicle || a.block || a.offered);
  });

  singles.sort(function(a, b) {
    var la = (a.block || a.offered) ? 1 : 0, lb = (b.block || b.offered) ? 1 : 0;
    if (la !== lb) return la - lb;
    return (a.system_name + a.snapshot.name).localeCompare(b.system_name + b.snapshot.name);
  });

  singles.forEach(function(a) {
    any = true;
    var locked = a.block || (a.offered ? 'уже ждёт подтверждения в другой передаче' : null);
    var card = makeAssetCard(a.snapshot, 'unit', a.system_name, false);

    if (locked) {
      card.classList.add('locked');
      card.appendChild(makeLockLine(locked));
    } else {
      var check = document.createElement('span');
      check.className = 'tr-check' + (trPickedVehicles[a.item_id] ? ' on' : '');
      card.querySelector('.tr-card-head').appendChild(check);
      card.classList.toggle('picked', !!trPickedVehicles[a.item_id]);
      card.addEventListener('click', function() {
        if (trPickedVehicles[a.item_id]) delete trPickedVehicles[a.item_id];
        else trPickedVehicles[a.item_id] = true;
        card.classList.toggle('picked', !!trPickedVehicles[a.item_id]);
        check.classList.toggle('on', !!trPickedVehicles[a.item_id]);
        paintGiveFoot();
      });
    }
    box.appendChild(card);
  });

  if (!any) box.innerHTML = '<div class="tr-none">Наземных войск на картах нет</div>';
}

function makeGroupCard(key, g) {
  var card = document.createElement('div');
  card.className = 'tr-card';
  var total = g.ids.length;

  card.innerHTML =
    '<div class="tr-card-head">' +
      trThumb(g.snapshot.image, 'unit', 'big') +
      '<span class="tr-card-info"><b>' + escapeTr(g.snapshot.name) + '</b>' +
        '<i>' + escapeTr(g.system_name) + ' · есть ' + total + '</i></span>' +
    '</div>';

  var step = document.createElement('div');
  step.className = 'tr-stepper';

  var minus = document.createElement('button');
  minus.textContent = '−';
  var val = document.createElement('span');
  var plus = document.createElement('button');
  plus.textContent = '+';
  var all = document.createElement('button');
  all.className = 'tr-all';
  all.textContent = 'все';

  function paint() {
    var n = trPickedGroups[key] || 0;
    val.textContent = n;
    card.classList.toggle('picked', n > 0);
    minus.disabled = n <= 0;
    plus.disabled = n >= total;
    all.textContent = n >= total ? 'сброс' : 'все';
    paintGiveFoot();
  }

  minus.addEventListener('click', function() {
    trPickedGroups[key] = Math.max(0, (trPickedGroups[key] || 0) - 1);
    paint();
  });
  plus.addEventListener('click', function() {
    trPickedGroups[key] = Math.min(total, (trPickedGroups[key] || 0) + 1);
    paint();
  });
  all.addEventListener('click', function() {
    trPickedGroups[key] = (trPickedGroups[key] || 0) >= total ? 0 : total;
    paint();
  });

  step.appendChild(minus);
  step.appendChild(val);
  step.appendChild(plus);
  step.appendChild(all);
  card.querySelector('.tr-card-head').appendChild(step);

  val.textContent = trPickedGroups[key] || 0;
  card.classList.toggle('picked', (trPickedGroups[key] || 0) > 0);
  minus.disabled = !(trPickedGroups[key] > 0);
  plus.disabled = (trPickedGroups[key] || 0) >= total;
  all.textContent = (trPickedGroups[key] || 0) >= total ? 'сброс' : 'все';

  return card;
}

// Карточка корабля или техники: картинка, прочность и всё, что внутри
function makeAssetCard(snap, kind, systemName, deep) {
  var card = document.createElement('div');
  card.className = 'tr-card';

  var hpPct = snap.max_hp > 0 ? Math.max(0, Math.min(100, Math.round(snap.hp / snap.max_hp * 100))) : 100;
  var where = deep ? 'открытый космос' : systemName;
  var tag = kind === 'ship'
    ? (snap.fighter ? 'истребитель' : 'корабль')
    : (snap.hero ? 'одарённый' : snap.vehicle ? 'техника' : 'боец');

  card.innerHTML =
    '<div class="tr-card-head">' +
      trThumb(snap.image, kind === 'ship' ? 'ship' : 'unit', 'big') +
      '<span class="tr-card-info"><b>' + escapeTr(snap.name) + '</b>' +
        '<i>' + escapeTr(where) + ' · ' + tag + '</i>' +
        '<span class="tr-hp"><span style="width:' + hpPct + '%"></span></span>' +
      '</span>' +
    '</div>' +
    contentsHtml(snap);

  return card;
}

function contentsHtml(snap) {
  var parts = (snap.contents || []).map(function(c) {
    var kind = c.kind === 'fighter' ? 'ship' : 'unit';
    var tag = c.kind === 'fighter' ? 'ангар' : c.kind === 'vehicle' ? 'техника' : '';
    return '<span class="tr-mini" title="' + escapeTr(c.name) + '">' +
        trThumb(c.image, kind, 'small') +
        '<span class="tr-mini-text"><em>' + escapeTr(c.name) + '</em>' +
          (tag ? '<u>' + tag + '</u>' : '') + '</span>' +
        '<b>×' + c.count + '</b>' +
      '</span>';
  });

  (snap.resources || []).forEach(function(r) {
    parts.push('<span class="tr-mini tr-res" style="border-color:' + (r.color || '#2a3644') + '">' +
      '<i style="background:' + (r.color || '#8fa8c4') + '"></i>' +
      '<span class="tr-mini-text"><em>' + escapeTr(r.name) + '</em><u>груз</u></span>' +
      '<b>' + r.amount + '</b></span>');
  });

  if (!parts.length) return '';
  return '<div class="tr-inside"><div class="tr-inside-title">Внутри — уйдёт вместе</div>' +
         '<div class="tr-inside-list">' + parts.join('') + '</div></div>';
}

function makeLockLine(text) {
  var d = document.createElement('div');
  d.className = 'tr-lock';
  d.textContent = '⊘ ' + text;
  return d;
}

function trThumb(image, kind, size) {
  var img = image
    ? '<img src="../' + image + '" alt="" onerror="this.style.display=\'none\'">'
    : '';
  return '<span class="tr-thumb ' + kind + ' ' + size + '">' + img + '</span>';
}

// Что именно уходит — собираем список id для сервера
function collectPicked() {
  var items = [];
  Object.keys(trPickedShips).forEach(function(id) { items.push({ kind: 'ship', id: id }); });
  Object.keys(trPickedVehicles).forEach(function(id) { items.push({ kind: 'unit', id: id }); });
  Object.keys(trPickedGroups).forEach(function(key) {
    var n = trPickedGroups[key] || 0;
    var g = trGroups[key];
    if (!g) return;
    g.ids.slice(0, n).forEach(function(id) { items.push({ kind: 'unit', id: id }); });
  });
  return items;
}

function paintGiveFoot() {
  var ships = Object.keys(trPickedShips).length;
  var vehicles = Object.keys(trPickedVehicles).length;
  var troops = 0;
  Object.keys(trPickedGroups).forEach(function(k) { troops += trPickedGroups[k] || 0; });

  var parts = [];
  if (ships) parts.push(trPlural(ships, 'корабль', 'корабля', 'кораблей'));
  if (troops) parts.push(trPlural(troops, 'боец', 'бойца', 'бойцов'));
  if (vehicles) parts.push(trPlural(vehicles, 'машина', 'машины', 'машин'));

  var partner = null;
  trPartners.forEach(function(p) { if (p.user_id === trPartner) partner = p; });

  document.getElementById('tr-sum').innerHTML = parts.length
    ? 'Отдаёшь: <b>' + parts.join(', ') + '</b>' + (partner ? ' → ' + escapeTr(partner.nickname) : '')
    : '<span class="tr-sum-empty">Ничего не выбрано</span>';

  // Главное предупреждение — рядом с кнопкой, а не в справке
  var warn = document.getElementById('tr-warn');
  if (ships || vehicles) {
    warn.style.display = 'block';
    warn.innerHTML = '<b>Всё внутри перейдёт союзнику:</b> ' +
      (ships ? 'трюм, ангар, техника с десантом и груз. Корабли выйдут из-под твоего командира.'
             : 'десант уходит вместе с техникой.');
  } else {
    warn.style.display = 'none';
  }

  // Сообщение нужно только когда есть что и кому отправить
  document.getElementById('tr-note').style.display = (partner && parts.length) ? 'block' : 'none';
  document.getElementById('tr-foot-hint').style.display = parts.length ? 'none' : 'block';

  var btn = document.getElementById('tr-send');
  btn.disabled = trBusy || !partner || !parts.length;
  btn.textContent = trBusy ? 'Отправляем...'
    : !partner ? 'Выбери союзника'
    : !parts.length ? 'Выбери, что передать'
    : 'Предложить передачу';
}

function sendTransfer() {
  var items = collectPicked();
  if (!trPartner || !items.length || trBusy) return;

  trBusy = true;
  paintGiveFoot();

  var note = document.getElementById('tr-note');

  supabase.rpc('create_transfer', {
    p_to: trPartner,
    p_items: items,
    p_note: note && note.value ? note.value : null
  }).then(function(res) {
    trBusy = false;
    if (res.error) {
      paintGiveFoot();
      trToast(res.error.message, true);
      return;
    }
    if (note) note.value = '';
    trToast('Предложение отправлено — ждём подтверждения союзника');
    setTransferTab('out');
  });
}

// ── Входящие и мои предложения ─────────────────────────────────────

function loadOffersTab(tab) {
  var body = document.getElementById('tr-body');
  body.innerHTML = '<div class="tr-empty">Загрузка...</div>';

  supabase.rpc('get_my_transfers').then(function(res) {
    if (trTab !== tab) return;
    if (res.error) {
      body.innerHTML = '<div class="tr-empty">Не удалось загрузить предложения</div>';
      return;
    }

    var dir = tab === 'inbox' ? 'in' : 'out';
    var rows = (res.data || []).filter(function(t) { return t.direction === dir; });

    body.innerHTML = '';

    if (!rows.length) {
      body.innerHTML = '<div class="tr-empty">' +
        (dir === 'in' ? 'Тебе пока ничего не передавали' : 'Ты пока ничего не предлагал') + '</div>';
      return;
    }

    var live = rows.filter(function(t) { return t.status === 'pending'; });
    var done = rows.filter(function(t) { return t.status !== 'pending'; });

    live.forEach(function(t) { body.appendChild(makeOfferCard(t, true)); });

    if (done.length) {
      var h = document.createElement('div');
      h.className = 'tr-history-title';
      h.textContent = 'Недавние';
      body.appendChild(h);
      done.forEach(function(t) { body.appendChild(makeOfferCard(t, false)); });
    }
  });
}

function makeOfferCard(t, live) {
  var card = document.createElement('div');
  card.className = 'tr-offer' + (live ? '' : ' past');

  var st = TR_STATUS[t.status] || TR_STATUS.pending;
  var who = t.direction === 'in' ? 'от ' + t.partner_name : 'для ' + t.partner_name;

  var head =
    '<div class="tr-offer-head">' +
      '<span class="tr-partner-pawn">♟</span>' +
      '<span class="tr-offer-who"><b>' + escapeTr(who) + '</b>' +
        '<i>' + escapeTr(t.summary || '') + '</i></span>' +
      '<span class="tr-status ' + st.cls + '">' + st.text + '</span>' +
    '</div>';

  var note = t.note ? '<div class="tr-offer-note">«' + escapeTr(t.note) + '»</div>' : '';

  card.innerHTML = head + note;

  // Состав по планетам: иначе непонятно, где потом искать полученное
  var byPlanet = {};
  var order = [];
  (t.items || []).forEach(function(it) {
    if (!byPlanet[it.system_id]) { byPlanet[it.system_id] = { name: it.system_name, list: [] }; order.push(it.system_id); }
    byPlanet[it.system_id].list.push(it);
  });

  var hasInside = false;

  if (live) {
    order.forEach(function(sysId) {
      var p = byPlanet[sysId];
      var block = document.createElement('div');
      block.className = 'tr-offer-planet';
      block.innerHTML = '<div class="tr-offer-planet-name">◉ ' + escapeTr(p.name) + '</div>';

      // Корабли и техника — карточками с содержимым, пехота — плашками
      var chips = {};
      var chipOrder = [];
      p.list.forEach(function(it) {
        var s = it.snapshot || {};
        var withInside = (s.contents && s.contents.length) || (s.resources && s.resources.length);
        if (it.kind === 'ship' || s.vehicle) {
          if (withInside) hasInside = true;
          block.appendChild(makeAssetCard(s, it.kind, p.name, false));
          return;
        }
        var key = s.type;
        if (!chips[key]) { chips[key] = { snap: s, n: 0 }; chipOrder.push(key); }
        chips[key].n++;
      });

      if (chipOrder.length) {
        var row = document.createElement('div');
        row.className = 'tr-inside-list tr-troops';
        row.innerHTML = chipOrder.map(function(k) {
          var c = chips[k];
          return '<span class="tr-mini">' + trThumb(c.snap.image, 'unit', 'small') +
            '<span class="tr-mini-text"><em>' + escapeTr(c.snap.name) + '</em></span>' +
            '<b>×' + c.n + '</b></span>';
        }).join('');
        block.appendChild(row);
      }

      card.appendChild(block);
    });
  }

  if (live && t.direction === 'in') {
    var info = document.createElement('div');
    info.className = 'tr-offer-info';
    info.innerHTML =
      (hasInside ? '<b>Вместе с кораблями и техникой ты получишь всё, что внутри.</b> ' : '') +
      'Войска станут твоими там, где стоят сейчас. Если к моменту ответа что-то погибнет или сменит место — передача сорвётся.' +
      '<span class="tr-left">Ответить нужно в течение ' + trLeft(t.seconds_left) + '</span>';
    card.appendChild(info);

    var actions = document.createElement('div');
    actions.className = 'tr-actions';

    var no = document.createElement('button');
    no.className = 'tr-btn ghost';
    no.textContent = 'Отказаться';

    var yes = document.createElement('button');
    yes.className = 'tr-btn good';
    yes.textContent = 'Принять';

    no.addEventListener('click', function() { answerTransfer(t, false, yes, no); });
    yes.addEventListener('click', function() { answerTransfer(t, true, yes, no); });

    actions.appendChild(no);
    actions.appendChild(yes);
    card.appendChild(actions);
  }

  if (live && t.direction === 'out') {
    var wait = document.createElement('div');
    wait.className = 'tr-offer-info';
    wait.innerHTML = 'Пока союзник не подтвердил, войска остаются у тебя и воюют как обычно.' +
      '<span class="tr-left">Предложение действует ещё ' + trLeft(t.seconds_left) + '</span>';
    card.appendChild(wait);

    var acts = document.createElement('div');
    acts.className = 'tr-actions';
    var cancel = document.createElement('button');
    cancel.className = 'tr-btn ghost wide';
    cancel.textContent = 'Отозвать предложение';
    cancel.addEventListener('click', function() {
      cancel.disabled = true;
      supabase.rpc('cancel_transfer', { p_id: t.transfer_id }).then(function(res) {
        if (res.error) {
          cancel.disabled = false;
          trToast(res.error.message, true);
          return;
        }
        trToast('Предложение отозвано');
        loadOffersTab('out');
      });
    });
    acts.appendChild(cancel);
    card.appendChild(acts);
  }

  return card;
}

function answerTransfer(t, accept, yes, no) {
  if (accept) {
    var ok = confirm('Принять войска от ' + t.partner_name + '?\n\n' +
      (t.summary || '') + '\n\nКорабли и техника переходят к тебе со всем содержимым.');
    if (!ok) return;
  }

  yes.disabled = true;
  no.disabled = true;

  supabase.rpc('respond_transfer', { p_id: t.transfer_id, p_accept: accept }).then(function(res) {
    if (res.error) {
      yes.disabled = false;
      no.disabled = false;
      trToast(res.error.message, true);
      return;
    }

    var r = res.data || {};
    trToast(r.message || (accept ? 'Готово' : 'Отклонено'), !r.ok);
    loadOffersTab('inbox');
    refreshTransferBadge();

    // Армия за панелью должна показать новых бойцов сразу
    if (r.ok && accept && typeof loadArmyData === 'function') loadArmyData();
  });
}

// ── Мелочи ─────────────────────────────────────────────────────────

function trToast(text, bad) {
  var t = document.getElementById('tr-toast');
  if (!t) return;
  t.textContent = text;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(trToast.timer);
  trToast.timer = setTimeout(function() { t.className = ''; }, 3600);
}

function trLeft(sec) {
  if (sec >= 3600) return Math.floor(sec / 3600) + ' ч ' + Math.floor((sec % 3600) / 60) + ' мин';
  if (sec >= 60) return Math.floor(sec / 60) + ' мин';
  return sec + ' с';
}

function trPlural(n, one, few, many) {
  var d = n % 10, h = n % 100;
  var w = (d === 1 && h !== 11) ? one
        : (d >= 2 && d <= 4 && (h < 12 || h > 14)) ? few : many;
  return n + ' ' + w;
}

function escapeTr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', function() {
  var panel = document.getElementById('tr-panel');
  if (!panel) return;

  var tabs = document.getElementById('tr-tabs');
  TR_TABS.forEach(function(t) {
    var b = document.createElement('button');
    b.className = 'tr-tab';
    b.setAttribute('data-tab', t.id);
    b.innerHTML = '<span>' + t.name + '</span>' +
      (t.id === 'inbox' ? '<i class="tr-tab-badge"></i>' : '');
    b.addEventListener('click', function() { setTransferTab(t.id); });
    tabs.appendChild(b);
  });

  document.getElementById('tr-close').addEventListener('click', closeTransferPanel);
  document.getElementById('tr-send').addEventListener('click', sendTransfer);
  panel.addEventListener('click', function(e) { if (e.target === panel) closeTransferPanel(); });

  var give = document.getElementById('tr-open-give');
  var inbox = document.getElementById('tr-open-inbox');
  if (give) give.addEventListener('click', function() { openTransferPanel('give'); });
  if (inbox) inbox.addEventListener('click', function() { openTransferPanel('inbox'); });

  refreshTransferBadge();
  setInterval(refreshTransferBadge, 30000);
});
