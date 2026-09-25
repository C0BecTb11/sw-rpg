// Запрос планеты у лидера фракции.
//
// Игрок выбирает планету своей фракции и просит управление — лидеру
// приходит уведомление, а в окне фракции у него появляется список
// запросов с кнопками «Выдать» и «Отклонить». Выдача идёт тем же путём,
// что и из панели управления: запись в system_control, уведомления
// «выдал / забрал» пишет существующий триггер базы.

var prMode = 'ask';
var prPlanets = [];
var prChosen = null;
var prBusy = false;

// Окно фракции сообщает, лидер ли игрок — от этого зависит, что показать
function onFactionScreenReady(isLeader, hasLeader) {
  var ask = document.getElementById('pr-section');
  var review = document.getElementById('pr-review-btn');
  if (!ask || !review) return;

  ask.style.display = isLeader ? 'none' : 'block';
  review.style.display = isLeader ? 'flex' : 'none';

  var sub = document.getElementById('pr-open-sub');
  var btn = document.getElementById('pr-open-btn');
  if (!isLeader) {
    btn.disabled = !hasLeader;
    sub.textContent = hasLeader
      ? 'выбери планету — лидер получит уведомление'
      : 'у фракции пока нет лидера';
  }

  refreshPlanetRequestBadge();
}

function refreshPlanetRequestBadge() {
  supabase.rpc('get_planet_request_count').then(function(res) {
    var n = res.error ? 0 : (res.data || 0);
    var text = n > 9 ? '9+' : String(n);

    var badge = document.getElementById('faction-badge');
    if (badge) { badge.textContent = text; badge.style.display = n > 0 ? 'block' : 'none'; }

    var count = document.getElementById('pr-review-count');
    if (count) { count.textContent = n; count.classList.toggle('has', n > 0); }

    var banner = document.getElementById('fc-requests-banner');
    if (banner) {
      banner.style.display = n > 0 ? 'flex' : 'none';
      var bn = banner.querySelector('b');
      if (bn) bn.textContent = n;
    }
  });
}

// ── Шторка ─────────────────────────────────────────────────────────

function openPlanetRequestPanel(mode) {
  prMode = mode;
  prChosen = null;

  document.getElementById('pr-panel').style.display = 'flex';
  document.getElementById('pr-title').textContent =
    mode === 'review' ? 'Запросы игроков' : 'Запрос планеты';
  document.getElementById('pr-subtitle').textContent =
    mode === 'review' ? 'кто просит управление планетами' : 'управление выдаёт лидер фракции';
  document.getElementById('pr-foot').style.display = mode === 'ask' ? 'block' : 'none';

  if (mode === 'review') loadPlanetRequests();
  else loadRequestablePlanets();
}

// Вход из ленты уведомлений и из панели лидера
function openPlanetRequests() {
  openPlanetRequestPanel('review');
}

function closePlanetRequestPanel() {
  document.getElementById('pr-panel').style.display = 'none';
  refreshPlanetRequestBadge();
}

// ── Игрок: выбор планеты ───────────────────────────────────────────

function loadRequestablePlanets() {
  var body = document.getElementById('pr-body');
  body.innerHTML = '<div class="pr-empty">Загрузка...</div>';
  paintPrFoot();

  Promise.all([
    supabase.rpc('get_requestable_planets'),
    supabase.rpc('get_my_planet_requests')
  ]).then(function(r) {
    if (prMode !== 'ask') return;
    if (r[0].error) {
      body.innerHTML = '<div class="pr-empty">Не удалось загрузить планеты</div>';
      return;
    }

    prPlanets = r[0].data || [];
    var mine = r[1].error ? [] : (r[1].data || []);
    body.innerHTML = '';

    if (mine.length) body.appendChild(makeMyRequests(mine));

    var title = document.createElement('div');
    title.className = 'pr-block-title';
    title.textContent = 'Выбери планету';
    body.appendChild(title);

    if (!prPlanets.length) {
      body.appendChild(prEmpty('У фракции пока нет планет'));
      return;
    }

    prPlanets.forEach(function(p) { body.appendChild(makePlanetRow(p)); });
    paintPrFoot();
  });
}

function makeMyRequests(list) {
  var wrap = document.createElement('div');
  wrap.className = 'pr-mine';
  wrap.innerHTML = '<div class="pr-block-title">Мои запросы</div>';

  var STATUS = {
    pending:   ['ждёт ответа', 'wait'],
    approved:  ['выдана тебе', 'good'],
    rejected:  ['отклонён', 'bad'],
    cancelled: ['отозван', 'dim'],
    closed:    ['отдана другому', 'dim']
  };

  list.forEach(function(q) {
    var st = STATUS[q.status] || STATUS.pending;
    var row = document.createElement('div');
    row.className = 'pr-mine-row';
    row.innerHTML =
      '<span class="pr-mine-name">' + escapePr(q.system_name) + '</span>' +
      '<span class="pr-status ' + st[1] + '">' + st[0] + '</span>';

    if (q.status === 'pending') {
      var x = document.createElement('button');
      x.className = 'pr-mine-cancel';
      x.textContent = 'отозвать';
      x.addEventListener('click', function() {
        x.disabled = true;
        supabase.rpc('cancel_planet_request', { p_id: q.request_id }).then(function(res) {
          if (res.error) { x.disabled = false; prToast(res.error.message, true); return; }
          prToast('Запрос отозван');
          loadRequestablePlanets();
        });
      });
      row.appendChild(x);
    }
    wrap.appendChild(row);
  });

  return wrap;
}

function makePlanetRow(p) {
  var row = document.createElement('div');
  row.className = 'pr-planet';
  row.setAttribute('role', 'button');

  var locked = p.mine || p.requested;
  if (locked) row.classList.add('locked');
  if (prChosen === p.system_id) row.classList.add('chosen');

  var who;
  if (p.mine) who = '<span class="pr-who mine">под твоим управлением</span>';
  else if (p.requested) who = '<span class="pr-who wait">запрос уже у лидера</span>';
  else if (p.fresh) who = '<span class="pr-who fresh">новая — ждёт распределения</span>';
  else if (!p.controller_name) who = '<span class="pr-who free">свободна</span>';
  else who = '<span class="pr-who">управляет ' + escapePr(p.controller_name) + '</span>';

  var chips = '';
  if (p.primary_name) {
    chips += '<span class="fc-chip" style="border-color:' + (p.primary_color || '#2a3644') +
             ';color:' + (p.primary_color || '#8fa8c4') + '">' + escapePr(p.primary_name) + '</span>';
  }
  if (p.secondary_name) {
    chips += '<span class="fc-chip weak" style="border-color:' + (p.secondary_color || '#2a3644') +
             ';color:' + (p.secondary_color || '#8fa8c4') + '">' + escapePr(p.secondary_name) + '</span>';
  }
  if (!p.primary_name && !p.secondary_name) chips += '<span class="fc-chip bare">без залежей</span>';
  if (p.satisfaction !== null && p.satisfaction !== undefined) {
    chips += '<span class="fc-mood' +
      (p.satisfaction >= 60 ? ' good' : p.satisfaction >= 30 ? ' mid' : ' bad') +
      '">довольство ' + p.satisfaction + '</span>';
  }

  row.innerHTML =
    '<div class="pr-planet-head">' +
      '<span class="pr-planet-name">' + escapePr(p.name) + '</span>' +
      (locked ? '' : '<span class="pr-radio"></span>') +
    '</div>' +
    who +
    '<div class="fc-facts">' + chips + '</div>';

  if (!locked) {
    row.addEventListener('click', function() {
      prChosen = p.system_id;
      var all = document.querySelectorAll('#pr-body .pr-planet');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('chosen');
      row.classList.add('chosen');
      paintPrFoot();
    });
  }

  return row;
}

function paintPrFoot() {
  var btn = document.getElementById('pr-send');
  var chosen = null;
  prPlanets.forEach(function(p) { if (p.system_id === prChosen) chosen = p; });

  var hint = document.getElementById('pr-hint');
  if (chosen && chosen.controller_name) {
    hint.textContent = 'Сейчас планетой управляет ' + chosen.controller_name +
      '. Если лидер согласится, управление перейдёт к тебе.';
  } else {
    hint.textContent = 'Постройки, войска и заказы на планете останутся у своих хозяев — меняется только право строить и нанимать.';
  }

  btn.disabled = prBusy || !chosen;
  btn.textContent = prBusy ? 'Отправляем...'
    : chosen ? 'Запросить ' + chosen.name : 'Выбери планету';
}

function sendPlanetRequest() {
  if (!prChosen || prBusy) return;
  prBusy = true;
  paintPrFoot();

  var note = document.getElementById('pr-note');
  supabase.rpc('request_planet', {
    p_system_id: prChosen,
    p_note: note.value ? note.value : null
  }).then(function(res) {
    prBusy = false;
    if (res.error) {
      paintPrFoot();
      prToast(res.error.message, true);
      return;
    }
    note.value = '';
    prChosen = null;
    prToast('Запрос отправлен — лидер получил уведомление');
    loadRequestablePlanets();
  });
}

// ── Лидер: рассмотрение ────────────────────────────────────────────

function loadPlanetRequests() {
  var body = document.getElementById('pr-body');
  body.innerHTML = '<div class="pr-empty">Загрузка...</div>';

  supabase.rpc('get_planet_requests').then(function(res) {
    if (prMode !== 'review') return;
    if (res.error) {
      body.innerHTML = '<div class="pr-empty">' + escapePr(res.error.message) + '</div>';
      return;
    }

    var list = res.data || [];
    body.innerHTML = '';

    if (!list.length) {
      body.appendChild(prEmpty('Новых запросов нет'));
      return;
    }

    list.forEach(function(q) { body.appendChild(makeRequestCard(q)); });
  });
}

function makeRequestCard(q) {
  var card = document.createElement('div');
  card.className = 'pr-req';

  var now = q.controller_name
    ? 'сейчас управляет <b>' + escapePr(q.controller_name) + '</b>'
    : (q.fresh ? '<b class="fresh">новая, ждёт распределения</b>' : '<b class="free">никому не выдана</b>');

  card.innerHTML =
    '<div class="pr-req-head">' +
      '<span class="pr-req-planet">' + escapePr(q.system_name) + '</span>' +
      '<span class="pr-req-when">' + prWhen(q.created_at) + '</span>' +
    '</div>' +
    '<div class="pr-req-who"><span class="tr-partner-pawn">♟</span>' +
      '<span><b>' + escapePr(q.requester_name) + '</b> просит управление</span></div>' +
    '<div class="pr-req-line">' + now + '</div>' +
    (q.rivals > 0
      ? '<div class="pr-req-line warn">' + (q.rivals === 1
          ? 'На эту планету есть ещё один запрос — при выдаче он закроется'
          : 'На эту планету есть ещё запросы (' + q.rivals + ') — при выдаче они закроются') +
        '</div>'
      : '') +
    (q.note ? '<div class="pr-req-note">«' + escapePr(q.note) + '»</div>' : '');

  var acts = document.createElement('div');
  acts.className = 'pr-actions';

  var no = document.createElement('button');
  no.className = 'pr-btn ghost';
  no.textContent = 'Отклонить';

  var yes = document.createElement('button');
  yes.className = 'pr-btn good';
  yes.textContent = 'Выдать';

  no.addEventListener('click', function() { resolveRequest(q, false, yes, no); });
  yes.addEventListener('click', function() { resolveRequest(q, true, yes, no); });

  acts.appendChild(no);
  acts.appendChild(yes);
  card.appendChild(acts);

  return card;
}

function resolveRequest(q, approve, yes, no) {
  if (approve && q.controller_name) {
    var ok = confirm('Передать ' + q.system_name + ' игроку ' + q.requester_name + '?\n\n' +
      q.controller_name + ' потеряет право строить и нанимать на этой планете. ' +
      'Постройки останутся, войска и заказы производства — тоже за ним.');
    if (!ok) return;
  }

  yes.disabled = true;
  no.disabled = true;

  supabase.rpc('resolve_planet_request', { p_id: q.request_id, p_approve: approve })
    .then(function(res) {
      if (res.error) {
        yes.disabled = false;
        no.disabled = false;
        prToast(res.error.message, true);
        loadPlanetRequests();
        return;
      }
      prToast(approve
        ? q.system_name + ' выдана игроку ' + q.requester_name
        : 'Запрос отклонён');
      loadPlanetRequests();
      refreshPlanetRequestBadge();
    });
}

// Баннер в панели управления фракции: лидер видит запросы там,
// где и так распределяет планеты
function makeRequestsBanner() {
  var b = document.createElement('button');
  b.id = 'fc-requests-banner';
  b.className = 'fc-requests-banner';
  b.style.display = 'none';
  b.innerHTML = '<span>Запросы игроков на планеты: <b>0</b></span><em>рассмотреть ›</em>';
  b.addEventListener('click', openPlanetRequests);
  refreshPlanetRequestBadge();
  return b;
}

// ── Мелочи ─────────────────────────────────────────────────────────

function prEmpty(text) {
  var d = document.createElement('div');
  d.className = 'pr-empty';
  d.textContent = text;
  return d;
}

function prToast(text, bad) {
  var t = document.getElementById('pr-toast');
  if (!t) return;
  t.textContent = text;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(prToast.timer);
  prToast.timer = setTimeout(function() { t.className = ''; }, 3600);
}

function prWhen(iso) {
  var sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'только что';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин назад';
  if (sec < 86400) return Math.floor(sec / 3600) + ' ч назад';
  return Math.floor(sec / 86400) + ' дн назад';
}

function escapePr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', function() {
  var panel = document.getElementById('pr-panel');
  if (!panel) return;

  document.getElementById('pr-close').addEventListener('click', closePlanetRequestPanel);
  document.getElementById('pr-send').addEventListener('click', sendPlanetRequest);
  panel.addEventListener('click', function(e) { if (e.target === panel) closePlanetRequestPanel(); });

  document.getElementById('pr-open-btn').addEventListener('click', function() {
    openPlanetRequestPanel('ask');
  });
  document.getElementById('pr-review-btn').addEventListener('click', openPlanetRequests);

  refreshPlanetRequestBadge();
  setInterval(refreshPlanetRequestBadge, 30000);
});
