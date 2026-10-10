// Аренда производства.
//
// Управляющий планетой сдаёт союзнику своей фракции казарму, завод техники,
// храм или верфь станции на срок и за плату, которую назначает сам (можно
// и даром). Пока аренда идёт, нанимать там может только арендатор, а сам
// хозяин — нет. Бойцов и корабли арендатор оплачивает своими кредитами,
// сырьё берётся со склада планеты, как у самого хозяина.
//
// Решает всё база (lease_offer / lease_respond / production_access_error):
// здесь только окна, карточки и подсказки. Модуль общий для галактики,
// земли и орбиты — каждая страница берёт из него то, что ей нужно.

var PL_CODES = ['rep_barracks', 'cis_droid', 'rep_vehicle', 'cis_vehicle', 'rep_temple', 'cis_sith'];
var PL_HOURS = [1, 3, 6, 12, 24, 48];
var PL_PRICES = [0, 500, 1000, 2500, 5000];
var PL_PRICE_MAX = 1000000;

var PL_STATUS = {
  offered:   { text: 'ждёт ответа', cls: 'wait' },
  active:    { text: 'идёт',        cls: 'good' },
  declined:  { text: 'отказ',       cls: 'bad' },
  cancelled: { text: 'отозвано',    cls: 'dim' },
  expired:   { text: 'истекло',     cls: 'dim' },
  ended:     { text: 'завершена',   cls: 'dim' },
  void:      { text: 'сгорела',     cls: 'bad' }
};

var plPendingLeases = 0;     // входящие предложения — для значка «Армия»
var plOffer = null;          // открытое окно «Сдать в аренду»
var plPanelOpen = false;     // открыта ли шторка в галактике
var plPanelTimer = null;
var plPanelSeq = 0;

// ── Мелочи ─────────────────────────────────────────────────────────

function plEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function plNum(n) {
  return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function plPrice(n) {
  return n > 0 ? plNum(n) + ' кр.' : 'даром';
}

function plHoursWord(h) {
  return h + ' ч';
}

function plLeft(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec >= 3600) {
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  }
  if (sec >= 60) return Math.floor(sec / 60) + ' мин';
  return sec + ' с';
}

// Сколько осталось сейчас: сервер прислал секунды на момент ответа
function plSecLeft(row) {
  if (!row || !row._until) return 0;
  return Math.max(0, Math.ceil((row._until - Date.now()) / 1000));
}

function plStamp(rows) {
  var now = Date.now();
  (rows || []).forEach(function(r) { r._until = now + (r.seconds_left || 0) * 1000; });
  return rows || [];
}

function plMissing(err) {
  if (!err) return false;
  return err.code === 'PGRST202' || err.code === '42883' ||
    /could not find the function|does not exist/i.test(err.message || '');
}

function plRpc(name, args) {
  return Promise.resolve(supabase.rpc(name, args || {})).then(function(r) {
    return r || { data: null, error: null };
  }, function(e) {
    return { data: null, error: { message: (e && e.message) || 'нет связи с сервером' } };
  });
}

// Название планеты на картах земли и орбиты — его уже прочитал экран загрузки
function plPlanetName() {
  var el = document.querySelector('#scene-loader .sl-name');
  var t = el ? (el.textContent || '').trim() : '';
  return t && t !== '…' ? t : '';
}

function plLeasable(code) {
  return PL_CODES.indexOf(code) !== -1;
}

function plToast(text, bad) {
  var t = document.getElementById('pl-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'pl-toast';
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(plToast.timer);
  plToast.timer = setTimeout(function() { t.className = ''; }, 3600);
}

function plThumb(image) {
  return '<span class="pl-thumb">' +
    (image ? '<img src="../' + plEsc(image) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
    '</span>';
}

// ── Аренды этой планеты ────────────────────────────────────────────

// Карта «здание → аренда» по планете: только то, что касается меня
// (я сдаю или я арендую). Ключ верфи — 'station'.
function plSystemLeases(systemId) {
  if (!systemId || typeof supabase === 'undefined') return Promise.resolve({});
  return plRpc('get_system_leases', { p_system_id: systemId }).then(function(r) {
    var map = {};
    if (r.error) return map;
    plStamp(r.data).forEach(function(row) {
      map[row.building_id || 'station'] = row;
    });
    return map;
  });
}

function plLeaseOf(map, buildingId) {
  return (map && map[buildingId || 'station']) || null;
}

function plIsTenant(row) {
  return !!row && row.role === 'lessee' && row.status === 'active' && plSecLeft(row) > 0;
}

function plIsLockedOwner(row) {
  return !!row && row.role === 'lessor' && row.status === 'active' && plSecLeft(row) > 0;
}

// ── Плашка в окне найма и на верфи ─────────────────────────────────

// Что видит в окне производства хозяин сданного и сам арендатор.
// Возвращает null, если сказать нечего.
function plBannerHtml(row, kind) {
  if (!row) return null;
  var left = plLeft(plSecLeft(row));
  var what = kind === 'station' ? 'заказывать корабли и чинить их в доке' : 'нанимать';

  if (row.role === 'lessee' && row.status === 'active') {
    return '<div class="pl-banner tenant">' +
      '<div class="pl-banner-top"><b>Аренда у ' + plEsc(row.lessor_name || 'союзника') + '</b>' +
        '<span class="pl-banner-left" data-pl-left>' + left + '</span></div>' +
      '<div class="pl-banner-sub">Платишь своими кредитами, сырьё — со склада планеты. ' +
        'Заказ, начатый до конца срока, доделается.</div>' +
    '</div>';
  }
  if (row.role === 'lessor' && row.status === 'active') {
    return '<div class="pl-banner locked">' +
      '<div class="pl-banner-top"><b>Сдано игроку ' + plEsc(row.lessee_name || 'союзнику') + '</b>' +
        '<span class="pl-banner-left" data-pl-left>' + left + '</span></div>' +
      '<div class="pl-banner-sub">Пока идёт аренда, ' + what + ' здесь может только он.</div>' +
    '</div>';
  }
  if (row.role === 'lessor' && row.status === 'offered') {
    return '<div class="pl-banner offered">' +
      '<div class="pl-banner-top"><b>Предложено в аренду: ' + plEsc(row.lessee_name || 'союзнику') + '</b></div>' +
      '<div class="pl-banner-sub">Пока он не ответил, производство твоё. ' +
        'Принять он сможет, когда линия освободится.</div>' +
    '</div>';
  }
  return null;
}

// Живой отсчёт в плашке: по нулю зовём onEnd (перечитать и перерисовать)
function plTickBanner(host, row, onEnd) {
  if (!host) return;
  if (host._plTick) { clearInterval(host._plTick); host._plTick = null; }
  if (!row || row.status !== 'active') return;
  host._plTick = setInterval(function() {
    if (!document.body.contains(host)) { clearInterval(host._plTick); host._plTick = null; return; }
    var sec = plSecLeft(row);
    var el = host.querySelector('[data-pl-left]');
    if (el) el.textContent = plLeft(sec);
    if (sec <= 0) {
      clearInterval(host._plTick); host._plTick = null;
      if (typeof onEnd === 'function') onEnd();
    }
  }, 1000);
}

function plStopTick(host) {
  if (host && host._plTick) { clearInterval(host._plTick); host._plTick = null; }
}

// Плашка в окне найма и на верфи вместе с действием хозяина: «Сдать
// в аренду», пока ничего не сдано, и «Отозвать», пока ждём ответа.
// o: { kind ('building' | 'station'), canOffer, offer: {systemId, buildingId,
//      name, image, planetName}, onEnd (срок вышел), onChanged }
function plRenderBanner(host, row, o) {
  if (!host) return;
  plStopTick(host);
  o = o || {};
  var html = row ? plBannerHtml(row, o.kind) : null;

  if (!html && o.canOffer) {
    html = '<div class="pl-banner idle">' +
      '<div class="pl-banner-top"><b>⚒ Аренда союзнику</b>' +
        '<span class="pl-banner-hint">на срок и за твою цену</span></div>' +
    '</div>';
  }

  host.innerHTML = html || '';
  host.style.display = html ? '' : 'none';
  if (!html) return;

  var banner = host.querySelector('.pl-banner');
  var changed = function() { if (typeof o.onChanged === 'function') o.onChanged(); };

  if (!row && o.canOffer && o.offer) {
    var give = plButton('Сдать в аренду', 'gold');
    give.className += ' pl-banner-btn';
    give.addEventListener('click', function() {
      var of = o.offer;
      plOpenOffer({ systemId: of.systemId, buildingId: of.buildingId || null, name: of.name,
                    image: of.image, planetName: of.planetName, onDone: changed });
    });
    banner.appendChild(give);
  } else if (row && row.role === 'lessor' && row.status === 'offered') {
    var cancel = plButton('Отозвать предложение', 'ghost');
    cancel.className += ' pl-banner-btn';
    cancel.addEventListener('click', function() {
      cancel.disabled = true;
      plRpc('lease_cancel', { p_id: row.id }).then(function(r) {
        cancel.disabled = false;
        if (r.error) plToast(r.error.message, true);
        else plToast('Предложение отозвано');
        changed();
      });
    });
    banner.appendChild(cancel);
  }

  if (row && row.status === 'active') plTickBanner(host, row, o.onEnd);
}

// ── Блок аренды в карточке постройки и станции ─────────────────────
//
// o: { systemId, buildingId (null — верфь), name, image, planetName,
//      lease, canOffer, onOpen, onChanged }
function plRenderBlock(host, o) {
  if (!host) return;
  plStopTick(host);
  var row = o.lease;
  host.innerHTML = '';
  host.className = 'pl-block';

  if (!row && !o.canOffer) { host.style.display = 'none'; return; }
  host.style.display = '';

  var head = '<div class="pl-block-head"><span class="pl-block-ico">⚒</span>Аренда союзнику';
  var st = row ? (PL_STATUS[row.status] || PL_STATUS.offered) : null;
  if (row) {
    var stText = row.role === 'lessee' && row.status === 'active' ? 'твоя' : st.text;
    head += '<span class="pl-chip ' + st.cls + '">' + stText + '</span>';
  }
  head += '</div>';

  var body = '';
  if (!row) {
    body = '<div class="pl-block-text">Отдай производство союзнику на срок. ' +
      'Пока аренда идёт, сам нанимать здесь не сможешь.</div>';
  } else if (row.role === 'lessor' && row.status === 'offered') {
    body = '<div class="pl-block-text"><b>' + plEsc(row.lessee_name) + '</b> · ' +
      plHoursWord(row.hours) + ' · ' + plPrice(row.price) + '</div>' +
      '<div class="pl-block-sub">Ответ ждём ещё <span data-pl-left>' + plLeft(plSecLeft(row)) + '</span></div>';
  } else if (row.role === 'lessor') {
    body = '<div class="pl-block-text">' + (o.buildingId ? 'Нанимает' : 'Верфь у') + ' <b>' + plEsc(row.lessee_name) + '</b> · ещё ' +
      '<span data-pl-left>' + plLeft(plSecLeft(row)) + '</span></div>' +
      '<div class="pl-block-sub">' + (o.buildingId
        ? 'Нанимать самому и сносить — после конца срока.'
        : 'Строить корабли, чинить свои и сносить станцию — после конца срока.') + '</div>';
  } else if (row.status === 'active') {
    body = '<div class="pl-block-text">Арендуешь у <b>' + plEsc(row.lessor_name) + '</b> · ещё ' +
      '<span data-pl-left>' + plLeft(plSecLeft(row)) + '</span></div>';
  } else {
    body = '<div class="pl-block-text"><b>' + plEsc(row.lessor_name) + '</b> предлагает: ' +
      plHoursWord(row.hours) + ' · ' + plPrice(row.price) + '</div>';
  }
  host.innerHTML = head + body;

  var acts = document.createElement('div');
  acts.className = 'pl-block-acts';

  var changed = function() { if (typeof o.onChanged === 'function') o.onChanged(); };

  if (!row) {
    var give = plButton('Сдать в аренду', 'gold');
    give.addEventListener('click', function() {
      plOpenOffer({
        systemId: o.systemId, buildingId: o.buildingId || null,
        name: o.name, image: o.image, planetName: o.planetName,
        onDone: changed
      });
    });
    acts.appendChild(give);
  } else if (row.role === 'lessor' && row.status === 'offered') {
    var cancel = plButton('Отозвать предложение', 'ghost');
    cancel.addEventListener('click', function() {
      cancel.disabled = true;
      plRpc('lease_cancel', { p_id: row.id }).then(function(r) {
        cancel.disabled = false;
        if (r.error) { plToast(r.error.message, true); changed(); return; }
        plToast('Предложение отозвано');
        changed();
      });
    });
    acts.appendChild(cancel);
  } else if (row.role === 'lessee' && row.status === 'active') {
    acts.className += ' stack';
    if (typeof o.onOpen === 'function') {
      var open = plButton(o.buildingId ? 'Открыть производство' : 'Открыть верфь', 'good');
      open.addEventListener('click', function() { o.onOpen(); });
      acts.appendChild(open);
    }
    var back = plButton('Вернуть досрочно', 'ghost');
    back.addEventListener('click', function() { plEnd(row, o.name, changed, back); });
    acts.appendChild(back);
  } else if (row.role === 'lessee' && row.status === 'offered') {
    var no = plButton('Отказаться', 'ghost');
    var yes = plButton('Принять', 'good');
    no.addEventListener('click', function() { plRespond(row, false, { name: o.name, image: o.image }, changed, [yes, no]); });
    yes.addEventListener('click', function() { plRespond(row, true, { name: o.name, image: o.image }, changed, [yes, no]); });
    acts.appendChild(no);
    acts.appendChild(yes);
  }
  if (acts.children.length) host.appendChild(acts);

  // Отсчёт: сколько ждать ответа или сколько осталось аренды
  if (row) {
    host._plTick = setInterval(function() {
      if (!document.body.contains(host)) { plStopTick(host); return; }
      var sec = plSecLeft(row);
      var els = host.querySelectorAll('[data-pl-left]');
      for (var i = 0; i < els.length; i++) els[i].textContent = plLeft(sec);
      if (sec <= 0) { plStopTick(host); changed(); }
    }, 1000);
  }
}

function plButton(text, tone) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'pl-btn ' + (tone || 'ghost');
  b.textContent = text;
  return b;
}

// ── Ответ арендатора, досрочный возврат ────────────────────────────

function plRespond(row, accept, look, done, btns) {
  var lock = function(on) { (btns || []).forEach(function(b) { if (b) b.disabled = on; }); };
  var send = function() {
    lock(true);
    plRpc('lease_respond', { p_id: row.id, p_accept: accept }).then(function(r) {
      lock(false);
      if (r.error) { plToast(r.error.message, true); if (done) done(); return; }
      // «!…» — предложение уже не действует (истекло, планета ушла)
      if (typeof r.data === 'string' && r.data.charAt(0) === '!') {
        plToast(r.data.slice(1), true);
        refreshLeaseBadge();
        if (done) done();
        return;
      }
      plToast(accept
        ? 'Аренда началась — производство твоё на ' + plHoursWord(row.hours)
        : 'Ты отказался от аренды');
      refreshLeaseBadge();
      if (accept && typeof refreshCreditsBar === 'function') refreshCreditsBar();
      if (done) done();
    });
  };

  if (!accept || typeof gameConfirm !== 'function') { send(); return; }

  var name = (look && look.name) || row.target_name || 'Производство';
  gameConfirm({
    tone: 'build',
    kicker: 'Принять аренду',
    title: name,
    image: look && look.image ? '../' + look.image : (row.image ? '../' + row.image : null),
    sub: (row.system_name ? 'Планета ' + row.system_name + ' · ' : '') + 'на ' + plHoursWord(row.hours),
    rows: row.price > 0
      ? [{ label: 'Спишется', items: [{ kind: 'credits', text: plNum(row.price) + ' кр.' }] }]
      : [],
    note: (row.price > 0 ? '' : 'Союзник отдаёт производство даром. ') +
      'Срок пойдёт сразу. Нанимать будешь за свои кредиты, сырьё — со склада планеты.',
    ok: 'Принять',
    tag: 'lease-accept'
  }, send);
}

function plEnd(row, name, done, btn) {
  var send = function() {
    if (btn) { if (btn.disabled) return; btn.disabled = true; }
    plRpc('lease_end', { p_id: row.id }).then(function(r) {
      if (btn) btn.disabled = false;
      if (r.error) { plToast(r.error.message, true); if (done) done(); return; }
      plToast('Производство вернулось хозяину');
      if (done) done();
    });
  };
  if (typeof gameConfirm !== 'function') { send(); return; }
  gameConfirm({
    tone: 'danger',
    kicker: 'Вернуть досрочно',
    title: name || row.target_name || 'Производство',
    sub: 'Осталось ' + plLeft(plSecLeft(row)),
    note: 'Плата за аренду не возвращается. Заказы, что уже идут, доделаются.',
    ok: 'Вернуть'
  }, send);
}

// ── Окно «Сдать в аренду» ──────────────────────────────────────────

function plOpenOffer(o) {
  plCloseOffer();
  plOffer = {
    o: o, partners: null, partner: null, hours: 6, price: 0, busy: false, error: null
  };

  var el = document.createElement('div');
  el.id = 'pl-sheet';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML =
    '<div class="pl-box">' +
      '<div class="pl-head">' +
        plThumb(o.image) +
        '<div class="pl-head-text">' +
          '<div class="pl-kicker">Аренда производства</div>' +
          '<div class="pl-title">' + plEsc(o.name || 'Производство') + '</div>' +
          (o.planetName ? '<div class="pl-sub">планета ' + plEsc(o.planetName) + '</div>' : '') +
        '</div>' +
        '<button type="button" class="pl-x" aria-label="Закрыть">✕</button>' +
      '</div>' +
      '<div class="pl-body"></div>' +
      '<div class="pl-foot">' +
        '<div class="pl-sum"></div>' +
        '<button type="button" class="pl-send" disabled>Выбери союзника</button>' +
      '</div>' +
    '</div>';

  el.addEventListener('click', function(e) {
    if (e.target === el) plCloseOffer();
  });
  ['touchstart', 'touchmove', 'wheel', 'pointerdown'].forEach(function(ev) {
    el.addEventListener(ev, function(e) { e.stopPropagation(); }, { passive: true });
  });
  el.querySelector('.pl-x').addEventListener('click', plCloseOffer);
  el.querySelector('.pl-send').addEventListener('click', plSendOffer);

  document.body.appendChild(el);
  plOffer.el = el;
  document.addEventListener('keydown', plOfferKey, true);
  void el.offsetWidth;
  el.classList.add('open');

  plRenderOffer();

  plRpc('get_lease_partners').then(function(r) {
    if (!plOffer || plOffer.el !== el) return;
    if (r.error) {
      plOffer.error = plMissing(r.error) ? 'Аренда пока не включена на сервере' : 'Не удалось загрузить союзников';
      plOffer.partners = [];
    } else {
      plOffer.partners = r.data || [];
      if (plOffer.partners.length === 1) plOffer.partner = plOffer.partners[0].user_id;
    }
    plRenderOffer();
  });
}

function plOfferKey(e) {
  if (!plOffer) return;
  // Пока открыто «Точно?», клавиши — его
  if (typeof gameConfirmOpen === 'function' && gameConfirmOpen()) return;
  if (e.key === 'Escape' || e.keyCode === 27) {
    e.preventDefault(); e.stopPropagation();
    plCloseOffer();
  }
}

function plCloseOffer() {
  document.removeEventListener('keydown', plOfferKey, true);
  if (!plOffer) return;
  var el = plOffer.el;
  plOffer = null;
  if (!el) return;
  el.classList.remove('open');
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 180);
}

function plRenderOffer() {
  if (!plOffer) return;
  var st = plOffer;
  var body = st.el.querySelector('.pl-body');
  // Поле цены перерисовываем только при первой отрисовке, иначе
  // курсор и набранное пропадали бы на каждом нажатии
  var keepFocus = document.activeElement && document.activeElement.classList &&
                  document.activeElement.classList.contains('pl-price-input');
  body.innerHTML = '';

  // 1. Кому
  var who = document.createElement('div');
  who.className = 'pl-step';
  who.innerHTML = '<div class="pl-step-title"><span>1</span>Кому сдать</div>';
  if (st.partners === null) {
    who.innerHTML += '<div class="pl-none">Загрузка...</div>';
  } else if (st.error) {
    who.innerHTML += '<div class="pl-none bad">' + plEsc(st.error) + '</div>';
  } else if (!st.partners.length) {
    who.innerHTML += '<div class="pl-none">В твоей фракции пока нет других игроков</div>';
  } else {
    var list = document.createElement('div');
    list.className = 'pl-partners';
    st.partners.forEach(function(p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pl-partner' + (p.user_id === st.partner ? ' chosen' : '');
      b.innerHTML = '<span class="pl-pawn">♟</span><span>' + plEsc(p.nickname) + '</span>';
      b.addEventListener('click', function() { st.partner = p.user_id; plRenderOffer(); });
      list.appendChild(b);
    });
    who.appendChild(list);
  }
  body.appendChild(who);

  // 2. На сколько
  var how = document.createElement('div');
  how.className = 'pl-step';
  how.innerHTML = '<div class="pl-step-title"><span>2</span>На сколько</div>';
  var hours = document.createElement('div');
  hours.className = 'pl-chips';
  PL_HOURS.forEach(function(h) {
    var c = document.createElement('button');
    c.type = 'button';
    c.className = 'pl-chip-btn' + (st.hours === h ? ' active' : '');
    c.textContent = plHoursWord(h);
    c.addEventListener('click', function() { st.hours = h; plRenderOffer(); });
    hours.appendChild(c);
  });
  how.appendChild(hours);
  body.appendChild(how);

  // 3. Плата за весь срок
  var pay = document.createElement('div');
  pay.className = 'pl-step';
  pay.innerHTML = '<div class="pl-step-title"><span>3</span>Плата за весь срок</div>';
  var row = document.createElement('div');
  row.className = 'pl-price';
  var input = document.createElement('input');
  input.className = 'pl-price-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.setAttribute('inputmode', 'numeric');
  input.maxLength = 8;
  input.value = st.price > 0 ? String(st.price) : '';
  input.placeholder = '0 — даром';
  input.addEventListener('input', function() {
    var digits = input.value.replace(/[^\d]/g, '');
    if (digits !== input.value) input.value = digits;
    var n = digits ? parseInt(digits, 10) : 0;
    st.price = Math.min(PL_PRICE_MAX, isNaN(n) ? 0 : n);
    if (st.price === PL_PRICE_MAX && n > PL_PRICE_MAX) input.value = String(PL_PRICE_MAX);
    plPaintPriceChips(pay);
    plPaintOfferFoot();
  });
  row.appendChild(input);
  var unit = document.createElement('span');
  unit.className = 'pl-price-unit';
  unit.textContent = 'кр.';
  row.appendChild(unit);
  pay.appendChild(row);

  var quick = document.createElement('div');
  quick.className = 'pl-chips pl-quick';
  PL_PRICES.forEach(function(p) {
    var c = document.createElement('button');
    c.type = 'button';
    c.className = 'pl-chip-btn';
    c.setAttribute('data-price', p);
    c.textContent = p > 0 ? plNum(p) : 'даром';
    c.addEventListener('click', function() {
      st.price = p;
      input.value = p > 0 ? String(p) : '';
      plPaintPriceChips(pay);
      plPaintOfferFoot();
    });
    quick.appendChild(c);
  });
  pay.appendChild(quick);
  body.appendChild(pay);
  plPaintPriceChips(pay);

  // Правила — коротко и до кнопки, а не в справке
  var rules = document.createElement('div');
  rules.className = 'pl-rules';
  rules.innerHTML =
    '<b>Пока идёт аренда, нанимать здесь может только союзник — ты нет.</b>' +
    '<i>Бойцов и корабли он оплачивает сам, сырьё берётся со склада планеты.</i>' +
    '<i>Плата придёт, когда он согласится. Отозвать можно, пока не ответил.</i>' +
    '<i>Снести постройку до конца срока нельзя. Потеряешь планету — аренда сгорит.</i>';
  body.appendChild(rules);

  if (keepFocus) { try { input.focus(); } catch (e) {} }
  plPaintOfferFoot();
}

function plPaintPriceChips(scope) {
  if (!plOffer) return;
  var chips = scope.querySelectorAll('.pl-quick .pl-chip-btn');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('active', parseInt(chips[i].getAttribute('data-price'), 10) === plOffer.price);
  }
}

function plPaintOfferFoot() {
  if (!plOffer) return;
  var st = plOffer;
  var partner = null;
  (st.partners || []).forEach(function(p) { if (p.user_id === st.partner) partner = p; });

  var sum = st.el.querySelector('.pl-sum');
  sum.innerHTML = partner
    ? '<b>' + plEsc(partner.nickname) + '</b> · ' + plHoursWord(st.hours) + ' · <em>' + plPrice(st.price) + '</em>'
    : '<span class="pl-sum-empty">Союзник не выбран</span>';

  var btn = st.el.querySelector('.pl-send');
  btn.disabled = st.busy || !partner;
  btn.textContent = st.busy ? 'Отправляем...' : !partner ? 'Выбери союзника' : 'Предложить аренду';
}

function plSendOffer() {
  var st = plOffer;
  if (!st || st.busy || !st.partner) return;
  st.busy = true;
  plPaintOfferFoot();

  var name = '';
  (st.partners || []).forEach(function(p) { if (p.user_id === st.partner) name = p.nickname; });

  plRpc('lease_offer', {
    p_system_id: st.o.systemId,
    p_building_id: st.o.buildingId || null,
    p_lessee: st.partner,
    p_hours: st.hours,
    p_price: st.price
  }).then(function(r) {
    if (plOffer !== st) return;
    st.busy = false;
    if (r.error) {
      plPaintOfferFoot();
      plToast(r.error.message, true);
      return;
    }
    var done = st.o.onDone;
    plCloseOffer();
    plToast('Предложение ушло — ждём ответа ' + name);
    if (typeof done === 'function') done();
  });
}

// ── Галактика: шторка «Аренда производства» ────────────────────────

function refreshLeaseBadge() {
  if (typeof supabase === 'undefined') return;
  plRpc('get_pending_lease_count').then(function(r) {
    var n = r.error ? 0 : (r.data || 0);
    plPendingLeases = n;
    var text = n > 9 ? '9+' : String(n);

    var entry = document.getElementById('pl-inbox-badge');
    if (entry) { entry.textContent = text; entry.style.display = n > 0 ? 'inline-block' : 'none'; }

    var sub = document.getElementById('pl-entry-sub');
    if (sub) sub.textContent = n > 0 ? 'предлагают тебе: ' + n : 'казармы, заводы и верфи союзников';

    if (typeof paintArmyBadge === 'function') paintArmyBadge();
  });
}

function openLeasePanel() {
  var panel = document.getElementById('pl-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  plPanelOpen = true;
  loadLeasePanel();
}

function closeLeasePanel() {
  var panel = document.getElementById('pl-panel');
  if (panel) panel.style.display = 'none';
  plPanelOpen = false;
  if (plPanelTimer) { clearInterval(plPanelTimer); plPanelTimer = null; }
  refreshLeaseBadge();
}

function loadLeasePanel() {
  var body = document.getElementById('pl-panel-body');
  if (!body) return;
  if (!body.children.length) body.innerHTML = '<div class="pl-empty">Загрузка...</div>';

  var my = ++plPanelSeq;
  plRpc('get_my_leases').then(function(r) {
    if (!plPanelOpen || my !== plPanelSeq) return;
    if (r.error) {
      body.innerHTML = '<div class="pl-empty">' +
        (plMissing(r.error) ? 'Аренда пока не включена на сервере' : 'Не удалось загрузить аренды') + '</div>';
      return;
    }
    renderLeasePanel(plStamp(r.data));
  });
}

function renderLeasePanel(rows) {
  var body = document.getElementById('pl-panel-body');
  body.innerHTML = '';
  if (plPanelTimer) { clearInterval(plPanelTimer); plPanelTimer = null; }

  var live = function(x) { return x.status === 'offered' || x.status === 'active'; };
  var groups = [
    { title: 'Предлагают тебе', list: rows.filter(function(x) { return x.role === 'lessee' && x.status === 'offered'; }) },
    { title: 'Арендуешь',       list: rows.filter(function(x) { return x.role === 'lessee' && x.status === 'active'; }) },
    { title: 'Сдаёшь',          list: rows.filter(function(x) { return x.role === 'lessor' && live(x); }) },
    { title: 'Недавние',        list: rows.filter(function(x) { return !live(x); }), past: true }
  ];

  var any = false;
  groups.forEach(function(g) {
    if (!g.list.length) return;
    any = true;
    var h = document.createElement('div');
    h.className = 'pl-group-title' + (g.past ? ' past' : '');
    h.innerHTML = plEsc(g.title) + (g.past ? '' : '<em>' + g.list.length + '</em>');
    body.appendChild(h);
    g.list.forEach(function(x) { body.appendChild(makeLeaseCard(x, !g.past)); });
  });

  if (!any) {
    body.innerHTML =
      '<div class="pl-empty">Аренд пока нет' +
      '<i>Сдать союзнику казарму, завод техники, храм или верфь может управляющий планетой — ' +
      'в окне найма этой постройки или в панели станции.</i></div>';
    return;
  }

  // Отсчёты в карточках; по нулю — перечитываем список
  plPanelTimer = setInterval(function() {
    if (!plPanelOpen) { clearInterval(plPanelTimer); plPanelTimer = null; return; }
    var cards = body.querySelectorAll('.pl-card[data-live]');
    var reload = false;
    for (var i = 0; i < cards.length; i++) {
      var row = cards[i]._plRow;
      if (!row) continue;
      var sec = plSecLeft(row);
      var el = cards[i].querySelector('[data-pl-left]');
      if (el) el.textContent = plLeft(sec);
      if (sec <= 0) reload = true;
    }
    if (reload) { clearInterval(plPanelTimer); plPanelTimer = null; loadLeasePanel(); }
  }, 1000);
}

function makeLeaseCard(x, live) {
  var card = document.createElement('div');
  card.className = 'pl-card' + (live ? '' : ' past') + ' role-' + x.role + ' st-' + x.status;
  card._plRow = x;
  if (live) card.setAttribute('data-live', '1');

  var st = PL_STATUS[x.status] || PL_STATUS.offered;
  var chip = x.role === 'lessee' && x.status === 'active' ? 'твоя' : st.text;
  var who = x.role === 'lessee' ? 'от ' + x.partner_name : 'для ' + x.partner_name;

  var timeLine = '';
  if (live && x.status === 'offered') {
    timeLine = (x.role === 'lessee' ? 'Ответить нужно в течение ' : 'Ответ ждём ещё ') +
      '<span data-pl-left>' + plLeft(plSecLeft(x)) + '</span>';
  } else if (live) {
    timeLine = 'Осталось <span data-pl-left>' + plLeft(plSecLeft(x)) + '</span>';
  }

  card.innerHTML =
    '<div class="pl-card-head">' +
      plThumb(x.image) +
      '<span class="pl-card-info"><b>' + plEsc(x.target_name) + '</b>' +
        '<i>планета ' + plEsc(x.system_name) + ' · ' + plEsc(who) + '</i>' +
        '<u>' + plHoursWord(x.hours) + ' · ' + plPrice(x.price) + '</u></span>' +
      '<span class="pl-chip ' + st.cls + '">' + chip + '</span>' +
    '</div>' +
    (timeLine ? '<div class="pl-card-time">' + timeLine + '</div>' : '');

  if (!live) return card;

  var acts = document.createElement('div');
  acts.className = 'pl-card-acts';
  var reload = function() { loadLeasePanel(); refreshLeaseBadge(); };

  if (x.role === 'lessee' && x.status === 'offered') {
    var note = document.createElement('div');
    note.className = 'pl-card-note';
    note.textContent = 'Срок пойдёт с момента согласия. Нанимать будешь за свои кредиты, сырьё — со склада планеты.';
    card.appendChild(note);
    var no = plButton('Отказаться', 'ghost');
    var yes = plButton(x.price > 0 ? 'Принять · ' + plNum(x.price) : 'Принять', 'good');
    no.addEventListener('click', function() { plRespond(x, false, { name: x.target_name, image: x.image }, reload, [yes, no]); });
    yes.addEventListener('click', function() { plRespond(x, true, { name: x.target_name, image: x.image }, reload, [yes, no]); });
    acts.appendChild(no);
    acts.appendChild(yes);
  } else if (x.role === 'lessee') {
    var back = plButton('Вернуть', 'ghost');
    back.addEventListener('click', function() { plEnd(x, x.target_name, reload, back); });
    var go = plButton(x.building_id ? 'К постройке' : 'К верфи', 'good');
    go.addEventListener('click', function() { window.location.href = plTargetUrl(x); });
    acts.appendChild(back);
    acts.appendChild(go);
  } else if (x.status === 'offered') {
    var cancel = plButton('Отозвать предложение', 'ghost');
    cancel.addEventListener('click', function() {
      cancel.disabled = true;
      plRpc('lease_cancel', { p_id: x.id }).then(function(r) {
        cancel.disabled = false;
        if (r.error) plToast(r.error.message, true);
        else plToast('Предложение отозвано');
        reload();
      });
    });
    acts.appendChild(cancel);
  } else {
    var look = plButton(x.building_id ? 'К постройке' : 'К верфи', 'ghost');
    look.addEventListener('click', function() { window.location.href = plTargetUrl(x); });
    acts.appendChild(look);
  }
  card.appendChild(acts);
  return card;
}

// Куда вести: к зданию на карте планеты или прямо в верфь станции
function plTargetUrl(x) {
  var sys = 'system=' + encodeURIComponent(x.system_id);
  return x.building_id
    ? 'ground-battle.html?' + sys + '&bid=' + encodeURIComponent(x.building_id) + '&open=lease'
    : 'space-battle.html?' + sys + '&open=shipyard';
}

// Строка события в ленте: кто, что, на сколько и почём
function plFeedLine(e) {
  var m = e.meta || {};
  var who = m.player || 'союзник';
  var what = e.subject || 'производство';
  var hours = m.hours ? ' · ' + plHoursWord(m.hours) : '';
  if (e.type === 'lease_offered') return who + ' предлагает: ' + what + hours + ' · ' + plPrice(e.amount);
  if (e.type === 'lease_accepted') return who + ' принял: ' + what + hours + (e.amount > 0 ? ' · +' + plNum(e.amount) + ' кр.' : '');
  if (e.type === 'lease_declined') return who + ' отказался: ' + what;
  if (e.type === 'lease_returned') return who + ' вернул досрочно: ' + what;
  if (e.type === 'lease_cancelled') return who + ' отозвал предложение: ' + what;
  if (e.type === 'lease_void') return what + ' · у хозяина больше нет планеты или постройки' +
    (e.amount > 0 ? ' · вернулось ' + plNum(e.amount) + ' кр.' : '');
  return what;
}

document.addEventListener('DOMContentLoaded', function() {
  var panel = document.getElementById('pl-panel');
  if (!panel) return;

  var close = document.getElementById('pl-panel-close');
  if (close) close.addEventListener('click', closeLeasePanel);
  panel.addEventListener('click', function(e) { if (e.target === panel) closeLeasePanel(); });

  var entry = document.getElementById('pl-open');
  if (entry) entry.addEventListener('click', openLeasePanel);

  refreshLeaseBadge();
  setInterval(function() { if (!document.hidden) refreshLeaseBadge(); }, 30000);
});
