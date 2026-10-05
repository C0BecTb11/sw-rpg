// Экран «Снабжение»: сеть складов фракции, рейсы снабжения, правила своих
// складов и доверие между игроками.
//
// Сервер (RPC get_supply_* / set_supply_rule / *_supply_access / *_supply_route)
// решает всё сам: что можно забрать, кто кому доверяет, куда летит флот.
// Здесь только показ и формы. Таймеры рейсов тикают локально, к базе ходим
// раз в полминуты и только пока экран открыт; значок на нижней панели —
// раз в минуту, двумя лёгкими запросами.
//
// Снаружи нужны: openSupplyScreen(tab, ctx) — её зовут фракционная панель,
// нижняя панель галактики и логистический хаб на наземной карте;
// closeSupplyScreen(). Вкладки: 'network' | 'routes' | 'stores' | 'market' | 'access'.
// ctx = { hub: system_id, name } — экран открыт из хаба этой планеты:
// склады отфильтрованы по ней, новый рейс и вывоз покупок начинаются отсюда.
//
// Экран — единственный интерфейс логистики: старая панель хаба (конвои и
// рынок) перенесена сюда целиком, торговый пост и добыча живут отдельно.

(function() {

  var TABS = [
    { id: 'network', label: 'Сеть' },
    { id: 'routes',  label: 'Рейсы' },
    { id: 'stores',  label: 'Склады' },
    { id: 'market',  label: 'Рынок' },
    { id: 'access',  label: 'Доступ' }
  ];

  // Справочник ресурсов: берём из БД, а это — запас на случай сбоя
  var RES_DEFAULT = [
    { id: 'ore',         name: 'Руда',             color: '#b08968' },
    { id: 'gas',         name: 'Тибанна',          color: '#4ad9c8' },
    { id: 'crystals',    name: 'Кристаллы',        color: '#a34ad9' },
    { id: 'food',        name: 'Продовольствие',   color: '#5fd968' },
    { id: 'durasteel',   name: 'Дюрасталь',        color: '#8fa8c4' },
    { id: 'cells',       name: 'Топливные ячейки', color: '#d9a940' },
    { id: 'electronics', name: 'Электроника',      color: '#4a90d9' }
  ];

  var MAX_STOPS = 6;
  var STEP = 10;

  var st = {
    open: false,
    tab: 'network',
    filter: 'all',          // сеть: all | take | need
    myId: null,
    faction: null,
    resources: RES_DEFAULT.slice(),
    systems: null,          // планеты своей фракции для конструктора
    network: null, routes: null, planets: null, grants: null, partners: null,
    errors: {},
    loading: {},
    openLogs: {}, logs: {},          // рейс → раскрыт / строки журнала
    openTakes: {}, takes: {},        // планета → раскрыт «кто брал» / строки
    openRule: {},                    // 'sys|res' → раскрыт редактор правила
    showAll: {},                     // планета → показать все ресурсы
    drafts: {},                      // 'sys|res' → черновик правила
    saving: {},
    hub: null,                       // { id, name } — экран открыт из хаба этой планеты
    storeSys: null,                  // «Склады»: показать только эту планету
    convoys: null,                   // конвои старого образца, ещё в пути
    lots: null, orders: null, mylots: null,   // рынок
    mkt: 'lots',                     // рынок: lots | orders | mine
    mktRes: 'all',                   // фильтр лотов по ресурсу
    buyQty: {},                      // лот → сколько купить
    pick: null,                      // открытая форма вывоза покупки
    cmds: null, cmdsError: null,     // командиры для вывоза
    hubs: {},                        // планета → есть ли достроенный хаб (true/false)
    lotForm: null                    // черновик нового лота
  };

  var timer = null, ticks = 0, badgeTimer = null, toastTimer = null;
  var ed = null;  // состояние конструктора рейса

  // ── Мелочи ─────────────────────────────────────────────────────────

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

  function call(name, args) {
    var p;
    try { p = supabase.rpc(name, args || {}); }
    catch (e) { return Promise.resolve({ data: null, error: { message: 'Нет связи с сервером' } }); }
    return Promise.resolve(p).then(function(res) { return res || { data: null, error: null }; },
      function() { return { data: null, error: { message: 'Нет связи с сервером' } }; });
  }

  function errText(err) {
    var m = err && (err.message || err.details) || '';
    // Служебные сообщения PostgREST игроку ничего не скажут
    if (!m || /function|schema cache|permission denied|JWT|violates/i.test(m)) return 'Не получилось — попробуй ещё раз';
    return m;
  }

  function resInfo(id) {
    for (var i = 0; i < st.resources.length; i++) if (st.resources[i].id === id) return st.resources[i];
    return { id: id, name: id, color: '#8fa8c4' };
  }

  function sysName(id) {
    if (st.systems) for (var i = 0; i < st.systems.length; i++) if (st.systems[i].id === id) return st.systems[i].name;
    return id || '—';
  }

  function stopName(s) {
    return (s.system_name && s.system_name !== s.system_id) ? s.system_name : sysName(s.system_id);
  }

  function shortName(n) {
    n = String(n || '—');
    return n.length > 8 ? n.slice(0, 7) + '.' : n;
  }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function leftText(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + ' ч ' + m + ' мин';
    if (m > 0) return m + ' мин ' + s + ' с';
    return s + ' с';
  }

  function timeText(iso) {
    var ms = new Date(iso).getTime();
    if (isNaN(ms)) return '';
    if (typeof svFormatTime === 'function') return svFormatTime(ms);
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // «сегодня 14:20» / «вчера 09:05» / «12.09 18:40» — для «кто брал»
  function whenText(iso) {
    var ms = new Date(iso).getTime();
    if (isNaN(ms)) return '';
    var now = (typeof svNow === 'function') ? svNow() : Date.now();
    var key = (typeof svDayKey === 'function') ? svDayKey : function(x) { return new Date(x).toDateString(); };
    if (key(ms) === key(now)) return timeText(iso);
    if (key(ms) === key(now - 86400000)) return 'вчера ' + timeText(iso);
    var d = new Date(ms);
    return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + timeText(iso);
  }

  function screenEl() { return document.getElementById('supply-screen'); }
  function bodyEl() { return document.getElementById('sup-body'); }

  function toast(msg, bad) {
    var t = document.getElementById('sup-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'sup-toast';
      t.className = 'sup-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'sup-toast show' + (bad ? ' bad' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.className = 'sup-toast' + (bad ? ' bad' : ''); }, bad ? 4200 : 2400);
  }

  // ── Загрузка ───────────────────────────────────────────────────────

  var LOADERS = {
    network:  'get_supply_network',
    routes:   'get_my_supply_routes',
    planets:  'get_my_supply_planets',
    grants:   'get_supply_grants',
    partners: 'get_supply_partners',
    convoys:  'get_my_convoys',
    lots:     { fn: 'get_market_lots', args: { p_resource: null } },
    orders:   'get_my_market_orders',
    mylots:   'get_my_market_lots'
  };

  var TAB_KEYS = {
    network: ['network', 'grants', 'routes', 'planets'],
    routes:  ['routes', 'convoys'],
    stores:  ['planets'],
    market:  ['lots', 'orders', 'mylots', 'planets'],
    access:  ['grants', 'partners']
  };

  // Списки с обратным отсчётом: сервер даёт «осталось секунд», а мы
  // превращаем это в момент по своим часам — так отсчёт не зависит от
  // расхождения часов клиента и сервера
  function stampUntil(rows) {
    var now = Date.now();
    (rows || []).forEach(function(r) {
      if (r && r.seconds_left !== undefined && r.seconds_left !== null) r._until = now + num(r.seconds_left) * 1000;
    });
  }

  // Один и тот же список не запрашиваем дважды: второй ждёт первый ответ
  var waiters = {};

  function load(keys, done) {
    var left = keys.length;
    if (!left) { if (done) done(); return; }
    function fin() { if (--left === 0 && done) done(); }
    keys.forEach(function(k) {
      if (st.loading[k]) { waiters[k].push(fin); return; }
      st.loading[k] = true;
      waiters[k] = [fin];
      var L = LOADERS[k];
      call(L.fn || L, L.args).then(function(res) {
        st.loading[k] = false;
        if (res.error) st.errors[k] = errText(res.error);
        else {
          st[k] = res.data || [];
          st.errors[k] = null;
          if (k === 'orders' || k === 'convoys') stampUntil(st[k]);
          // Свежие правила с сервера: черновики без правок больше не нужны,
          // иначе после смены правила или контроля они покажут старое
          if (k === 'planets') {
            Object.keys(st.drafts).forEach(function(dk) { if (!st.drafts[dk].dirty) delete st.drafts[dk]; });
          }
        }
        var w = waiters[k];
        waiters[k] = [];
        w.forEach(function(f) { f(); });
      });
    });
  }

  function refreshTab(silent) {
    var tab = st.tab;
    load(TAB_KEYS[tab], function() {
      if (!st.open) return;
      updateTabCounts();
      updateNavBadge();
      // Пока игрок правит склад, список под пальцами не перерисовываем
      if (tab === st.tab && !(silent && isEditingStores())) render();
    });
  }

  function isEditingStores() {
    if (st.tab !== 'stores') return false;
    var a = document.activeElement;
    return !!(a && a.closest && a.closest('#supply-screen .sup-rule'));
  }

  function ensureBasics(done) {
    var left = 3;
    function one() { if (--left === 0 && done) done(); }

    if (st.faction) one();
    else {
      supabase.auth.getSession().then(function(r) {
        var s = r && r.data && r.data.session;
        if (!s) { one(); return; }
        st.myId = s.user.id;
        supabase.from('profiles').select('faction').eq('id', s.user.id).maybeSingle().then(function(p) {
          st.faction = p && p.data ? p.data.faction : null;
          one();
        }, one);
      }, one);
    }

    if (st.resLoaded) one();
    else {
      supabase.from('resources').select('id, name, color, sort_order').then(function(r) {
        if (r && !r.error && r.data && r.data.length) {
          st.resources = r.data.slice().sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
        }
        st.resLoaded = true;
        one();
      }, function() { st.resLoaded = true; one(); });
    }

    one();
  }

  function loadSystems(done) {
    if (st.systems) { done(); return; }
    var q = supabase.from('systems').select('id, name, faction, is_deep_space');
    q.then(function(r) {
      var rows = (r && r.data) || [];
      st.systems = rows.filter(function(s) {
        return !s.is_deep_space && (!st.faction || s.faction === st.faction);
      }).sort(function(a, b) { return String(a.name).localeCompare(String(b.name), 'ru'); });
      done();
    }, function() { st.systems = []; done(); });
  }

  // ── Открытие и каркас ──────────────────────────────────────────────

  function buildShell() {
    var el = screenEl();
    if (!el) {
      el = document.createElement('div');
      el.id = 'supply-screen';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    if (el.getAttribute('data-ready')) return el;
    el.setAttribute('data-ready', '1');
    el.innerHTML =
      '<div class="sup-head">' +
        '<div class="sup-head-row">' +
          '<div class="sup-title-box"><span class="sup-title">Снабжение</span>' +
            '<span class="sup-sub" id="sup-sub"></span></div>' +
          '<button type="button" class="sup-close" id="sup-close" aria-label="Закрыть">✕</button>' +
        '</div>' +
        '<div class="sup-tabs" id="sup-tabs">' +
          TABS.map(function(t) {
            return '<button type="button" class="sup-tab" data-tab="' + t.id + '">' + t.label +
              '<i class="sup-tab-n" data-n="' + t.id + '"></i></button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="sup-body" id="sup-body"></div>';

    el.querySelector('#sup-close').addEventListener('click', closeSupplyScreen);
    el.querySelector('#sup-tabs').addEventListener('click', function(e) {
      var b = e.target.closest('.sup-tab');
      if (b) switchTab(b.getAttribute('data-tab'));
    });
    el.querySelector('#sup-body').addEventListener('click', onBodyClick);
    el.querySelector('#sup-body').addEventListener('input', onBodyInput);
    el.querySelector('#sup-body').addEventListener('change', onBodyInput);
    return el;
  }

  function openSupplyScreen(tab, ctx) {
    var el = buildShell();
    if (tab && TAB_KEYS[tab]) st.tab = tab;

    // Из хаба — склады этой планеты и рейсы отсюда; без контекста — вся сеть
    var hubId = ctx && ctx.hub ? String(ctx.hub) : null;
    if (hubId) {
      st.hub = { id: hubId, name: ctx.name || null };
      st.storeSys = hubId;
      st.hubs[hubId] = true;
    } else {
      st.hub = null;
      st.storeSys = null;
    }
    st.pick = null;
    st.lotForm = null;
    paintSubtitle();

    st.open = true;
    el.style.display = 'block';
    el.scrollTop = 0;
    markTabs();
    bodyEl().innerHTML = '<div class="sup-loading">Загрузка…</div>';

    ensureBasics(function() {
      // Имя планеты хаба знает справочник систем — на наземной карте его больше негде взять
      if (st.hub && !st.hub.name) loadSystems(function() { if (st.hub) { st.hub.name = sysName(st.hub.id); paintSubtitle(); if (st.open) render(); } });
      // Остальные вкладки — фоном, ради счётчиков на них
      load(['routes', 'grants', 'network', 'planets', 'orders'], function() { if (st.open) { updateTabCounts(); updateNavBadge(); } });
      refreshTab();
    });

    if (timer) clearInterval(timer);
    ticks = 0;
    timer = setInterval(function() {
      ticks++;
      if (ticks % 30 === 0 && (st.tab === 'routes' || st.tab === 'network')) { refreshTab(true); return; }
      tickRoutes();
    }, 1000);
  }

  function closeSupplyScreen() {
    st.open = false;
    var el = screenEl();
    if (el) el.style.display = 'none';
    closeEditor();
    if (timer) { clearInterval(timer); timer = null; }
  }

  function hubName() {
    return st.hub ? (st.hub.name || sysName(st.hub.id)) : '';
  }

  function paintSubtitle() {
    var el = document.getElementById('sup-sub');
    if (!el) return;
    if (st.hub) {
      el.innerHTML = '<i></i>Логистический хаб · <b>' + esc(hubName()) + '</b>';
      el.style.display = '';
    } else {
      el.innerHTML = '';
      el.style.display = 'none';
    }
  }

  function switchTab(tab) {
    if (!TAB_KEYS[tab]) return;
    st.tab = tab;
    markTabs();
    screenEl().scrollTop = 0;
    var have = TAB_KEYS[tab].every(function(k) { return st[k] !== null || st.errors[k]; });
    if (have) render();
    else bodyEl().innerHTML = '<div class="sup-loading">Загрузка…</div>';
    refreshTab();
  }

  function markTabs() {
    var btns = document.querySelectorAll('#sup-tabs .sup-tab');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-tab') === st.tab);
    }
  }

  function setTabCount(tab, n, kind) {
    var el = document.querySelector('#sup-tabs .sup-tab-n[data-n="' + tab + '"]');
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.className = 'sup-tab-n' + (n > 0 ? ' show' : '') + (kind ? ' ' + kind : '');
  }

  function incomingRequests() {
    return (st.grants || []).filter(function(g) {
      return g.direction === 'i_trust' && g.status === 'pending' && !g.requested_by_me;
    });
  }

  function liveRoutes() {
    return (st.routes || []).filter(function(r) { return r.status !== 'stopped'; });
  }

  function updateTabCounts() {
    var needs = (st.network || []).filter(function(r) { return r.need > 0; }).length;
    setTabCount('network', needs, 'gold');

    var live = liveRoutes();
    var stalled = live.filter(function(r) { return r.status === 'stalled'; }).length;
    if (stalled) setTabCount('routes', stalled, 'alert');
    else setTabCount('routes', live.length, '');

    var planets = {};
    (st.planets || []).forEach(function(p) { planets[p.system_id] = 1; });
    setTabCount('stores', Object.keys(planets).length, '');

    // Рынок: оплаченные покупки, за которыми ещё не послан флот
    setTabCount('market', waitingOrders().length, 'gold');

    setTabCount('access', incomingRequests().length, 'alert');
  }

  function waitingOrders() {
    return (st.orders || []).filter(function(o) { return !o.fleet_sent && untilLeft(o) > 0; });
  }

  function untilLeft(row) {
    if (!row || !row._until) return num(row && row.seconds_left);
    return Math.max(0, Math.round((row._until - Date.now()) / 1000));
  }

  // ── Значок на нижней панели ────────────────────────────────────────

  function updateNavBadge() {
    var badge = document.getElementById('supply-badge');
    if (!badge) return;
    var n = incomingRequests().length +
      liveRoutes().filter(function(r) { return r.status === 'stalled'; }).length;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n > 0 ? 'block' : 'none';
  }

  function refreshNavBadge() {
    if (document.hidden) return;
    if (st.open) { updateNavBadge(); return; }
    var left = 2;
    var g = null, r = null;
    function done() {
      if (--left) return;
      if (g) st.grants = g;
      if (r) st.routes = r;
      updateNavBadge();
    }
    call('get_supply_grants').then(function(res) { if (!res.error) g = res.data || []; done(); });
    call('get_my_supply_routes').then(function(res) { if (!res.error) r = res.data || []; done(); });
  }

  // ── Отрисовка ──────────────────────────────────────────────────────

  function render() {
    var body = bodyEl();
    if (!body || !st.open) return;
    var keys = TAB_KEYS[st.tab];
    // Рынок сам показывает загрузку и ошибки под переключателем разделов —
    // иначе сбой одного списка отрезал бы два других
    if (st.tab === 'market') { body.innerHTML = renderMarket(); return; }
    var mainKey = { network: 'network', routes: 'routes', stores: 'planets', access: 'grants' }[st.tab];
    if (st[mainKey] === null && st.errors[mainKey]) {
      body.innerHTML = '<div class="sup-empty"><b>Не удалось загрузить</b>' + esc(st.errors[mainKey]) +
        '<br><button type="button" class="sup-btn" data-act="retry">Повторить</button></div>';
      return;
    }
    if (st[mainKey] === null) { body.innerHTML = '<div class="sup-loading">Загрузка…</div>'; return; }
    void keys;

    if (st.tab === 'network') body.innerHTML = renderNetwork();
    else if (st.tab === 'routes') body.innerHTML = renderRoutes();
    else if (st.tab === 'stores') body.innerHTML = renderStores();
    else body.innerHTML = renderAccess();
  }

  function chip(cls, res, inner) {
    var r = resInfo(res.resource || res.id);
    var color = res.color || r.color;
    return '<span class="sup-chip ' + cls + '"><i style="background:' + esc(color) + '"></i>' + inner + '</span>';
  }

  function resLabel(row) { return esc(row.resource_name || resInfo(row.resource).name); }

  // ── Вкладка «Сеть» ─────────────────────────────────────────────────

  function grantWith(userId, direction) {
    var list = (st.grants || []).filter(function(g) {
      return g.other_user_id === userId && g.direction === direction &&
        (g.status === 'active' || g.status === 'pending');
    });
    return list.length ? list[0] : null;
  }

  function renderNetwork() {
    var rows = st.network || [];
    var bySys = {}, order = [];
    var takeCount = 0, needCount = 0;

    rows.forEach(function(r) {
      if (!bySys[r.system_id]) {
        bySys[r.system_id] = { id: r.system_id, name: r.system_name, controller_id: r.controller_id,
          controller_name: r.controller_name, mine: !!r.is_mine, take: [], need: [], locked: [] };
        order.push(r.system_id);
      }
      var p = bySys[r.system_id];
      // Чужое «только доверенным» сервер отдаёт с available = 0 — без числа
      if (r.is_mine) { if (r.available > 0) p.take.push(r); }
      else if (r.can_take) { if (r.available > 0) { p.take.push(r); takeCount++; } }
      else if (r.audience === 'trusted' && (r.available > 0 || !(r.need > 0))) p.locked.push(r);
      if (r.need > 0) { p.need.push(r); needCount++; }
    });

    var flying = liveRoutes().filter(function(r) { return r.status === 'active'; }).length;
    var stalled = liveRoutes().filter(function(r) { return r.status === 'stalled'; }).length;

    var h = '<div class="sup-summary">' +
      '<div class="sup-sum-cell take"><b>' + takeCount + '</b><span>можно<br>забрать</span></div>' +
      '<div class="sup-sum-cell need' + (needCount ? ' has' : '') + '"><b>' + needCount + '</b><span>' +
        plural(needCount, 'нужда', 'нужды', 'нужд') + '<br>в сети</span></div>' +
      '<div class="sup-sum-cell fly' + (stalled ? ' bad' : '') + '"><b>' + (stalled || flying) + '</b><span>' +
        (stalled ? plural(stalled, 'рейс<br>встал', 'рейса<br>встали', 'рейсов<br>встало')
                 : plural(flying, 'рейс<br>в пути', 'рейса<br>в пути', 'рейсов<br>в пути')) + '</span></div>' +
    '</div>';

    if (!order.length) {
      return h + '<div class="sup-empty"><b>Сеть пока пуста</b>' +
        'Никто во фракции не открыл склады и не заявил нужд.<br>' +
        'Открой свои — во вкладке «Склады»: выбери ресурс, включи «В сеть» и задай, сколько оставлять себе.' +
        '<br><button type="button" class="sup-btn" data-act="tab" data-tab="stores">Склады ›</button></div>';
    }

    h += '<div class="sup-seg sup-filter">' +
      segBtn('filter', 'all', 'Все', st.filter === 'all') +
      segBtn('filter', 'take', 'Забрать · ' + takeCount, st.filter === 'take') +
      segBtn('filter', 'need', 'Нужды · ' + needCount, st.filter === 'need') +
    '</div>';

    // Сначала планеты с нуждой (туда и надо везти), потом самые полные склады.
    // Свои — в конце: они видны и во вкладке «Склады»
    var list = order.map(function(id) { return bySys[id]; });
    list.sort(function(a, b) {
      if (a.mine !== b.mine) return a.mine ? 1 : -1;
      var an = a.need.length ? 1 : 0, bn = b.need.length ? 1 : 0;
      if (an !== bn) return bn - an;
      return sumAvail(b) - sumAvail(a);
    });

    var shown = 0;
    list.forEach(function(p) {
      var take = st.filter === 'need' ? [] : p.take;
      var locked = st.filter === 'need' ? [] : p.locked;
      var need = st.filter === 'take' ? [] : p.need;
      if (!take.length && !need.length && !locked.length) return;
      shown++;

      var trusted = !p.mine && grantWith(p.controller_id, 'trusts_me');
      var owner = p.mine
        ? '<span class="sup-tag mine">моя</span>'
        : '<b>' + esc(p.controller_name || '—') + '</b>' +
          (trusted && trusted.status === 'active' ? ' <span class="sup-tag trust">доверяет</span>' : '');

      var cls = 'sup-pcard' + (p.mine ? ' mine' : '') + (need.length ? ' has-need' : (take.length ? ' has-take' : ''));
      h += '<div class="' + cls + '">' +
        '<div class="sup-phead">' +
          '<button type="button" class="sup-pname" data-act="focus" data-sys="' + esc(p.id) + '">' +
            esc(p.name) + '<em>⌖</em></button>' +
          '<span class="sup-owner">' + owner + '</span>' +
          ((take.length || need.length)
            ? '<button type="button" class="sup-mini" data-act="route-from" data-sys="' + esc(p.id) + '"' +
              ' data-mode="' + (take.length && st.filter !== 'need' ? 'take' : 'need') + '">Рейс ›</button>'
            : '') +
        '</div>';

      if (take.length) {
        h += '<div class="sup-chips sup-chiprow">' + take.map(function(r) {
          return chip(r.is_mine ? 'own' : 'take', r, resLabel(r) + ' <b>' + r.available + '</b>');
        }).join('') + '</div>';
      }
      if (need.length) {
        h += '<div class="sup-chips sup-chiprow">' + need.map(function(r) {
          return chip('need', r, resLabel(r) + ' <b>нужно ' + r.need + '</b>');
        }).join('') + '</div>';
      }
      if (locked.length) {
        h += '<div class="sup-chips sup-chiprow">' + locked.map(function(r) {
          return chip('locked', r, resLabel(r) + ' · доверенным');
        }).join('') + '</div>';
        var pend = grantWith(p.controller_id, 'trusts_me');
        h += '<div class="sup-lock"><div class="sup-lock-text">Нужно доверие ' + esc(p.controller_name || 'владельца') +
          '<i>откроет все его склады для доверенных</i></div>' +
          (pend && pend.status === 'pending'
            ? '<span class="sup-lock-state">запрос отправлен</span>'
            : '<button type="button" class="sup-btn green" data-act="request" data-user="' + esc(p.controller_id) + '">Запросить доступ</button>') +
          '</div>';
      }
      h += '</div>';
    });

    if (!shown) {
      h += '<div class="sup-empty">' + (st.filter === 'need' ? 'Нужд в сети нет — склады фракции сыты' : 'Сейчас забрать нечего') + '</div>';
    }
    return h;
  }

  function sumAvail(p) {
    var s = 0;
    p.take.forEach(function(r) { s += r.available; });
    return s;
  }

  function segBtn(group, val, label, on, extra) {
    return '<button type="button" class="' + (on ? 'on' : '') + (extra ? ' ' + extra : '') + '" data-act="seg" data-group="' +
      group + '" data-val="' + esc(val) + '">' + label + '</button>';
  }

  // ── Вкладка «Рейсы» ────────────────────────────────────────────────

  function routeState(r) {
    if (r.status === 'stalled') return { cls: 'stalled', label: 'встал' };
    if (r.status === 'paused') return { cls: 'paused', label: 'пауза' };
    if (r.status === 'stopped') return { cls: 'stopped', label: 'завершён' };
    if (r.phase === 'travel') return { cls: 'travel', label: 'в пути' };
    if (r.phase === 'waiting') return { cls: 'waiting', label: 'ждёт груз' };
    return { cls: 'stop', label: 'на погрузке' };
  }

  function stopsOf(r) {
    var s = r.stops;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = []; } }
    return Array.isArray(s) ? s : [];
  }

  function cargoOf(r) {
    var c = r.cargo;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = {}; } }
    return c || {};
  }

  function actionText(a) {
    var load = a.op === 'load';
    var what = a.resource === '*' ? 'всё' : resInfo(a.resource).name.toLowerCase();
    var how;
    if (a.mode === 'amount') how = ' · ' + num(a.amount);
    else if (a.mode === 'need') how = ' · по нужде';
    else how = load ? ' · сколько можно' : (a.resource === '*' ? '' : ' · всё');
    return '<span class="sup-plan-act ' + (load ? 'load' : 'unload') + '">' + (load ? 'погрузить ' : 'выгрузить ') + '</span>' +
      esc(what) + how;
  }

  function statusLine(r, stt) {
    var here = esc(r.here_name || '—'), next = esc(r.next_name || '—');
    var left = '<span class="sup-left" data-left="' + esc(r.id) + '">' + leftOf(r) + '</span>';
    if (stt.cls === 'travel') return '<div class="sup-status-line"><span>' + here + ' → <b>' + next + '</b></span>' + left + '</div>';
    if (stt.cls === 'waiting') return '<div class="sup-status-line"><span>Стоит на ' + here + ', повтор через</span>' + left + '</div>';
    if (stt.cls === 'stop') return '<div class="sup-status-line"><span>Работает на ' + here + '</span>' + left + '</div>';
    if (stt.cls === 'paused') return 'Пауза — флот стоит на ' + here;
    if (stt.cls === 'stopped') return 'Рейс завершён';
    return '<b>' + esc(r.last_note || 'Рейс встал') + '</b>';
  }

  function leftOf(r) {
    if (r.seconds_left > 0) return leftText(r.seconds_left);
    return r.status === 'active' && r.phase === 'travel' ? 'прибывает' : '';
  }

  function renderRoute(r) {
    var stt = routeState(r);
    var stops = stopsOf(r);
    var cargo = cargoOf(r);
    var idx = num(r.stop_index);

    var cargoChips = Object.keys(cargo).filter(function(k) { return num(cargo[k]) > 0; }).map(function(k) {
      return chip('cargo', { resource: k }, esc(resInfo(k).name) + ' <b>' + num(cargo[k]) + '</b>');
    });

    // Цепочка: в перелёте подсвечена цель и бегущий отрезок к ней
    var chain = '';
    stops.forEach(function(s, i) {
      var cls = 'sup-node';
      if (i === idx) cls += r.phase === 'travel' && r.status !== 'stopped' ? ' target' : ' here';
      if (i > 0) {
        var toward = r.phase === 'travel' && r.status !== 'stopped' && i === idx;
        chain += '<span class="sup-link' + (toward ? (stt.cls === 'travel' ? ' moving' : ' toward') : '') + '"></span>';
      }
      // Разовый рейс «и домой»: последняя остановка без действий на первой планете
      var home = !r.loop && i > 0 && i === stops.length - 1 && stops[0] && s.system_id === stops[0].system_id &&
        !(s.actions || []).length;
      chain += '<div class="' + cls + (home ? ' home' : '') + '"><span class="sup-node-dot">' + (home ? '↩' : (i + 1)) + '</span>' +
        '<span class="sup-node-name">' + esc(shortName(stopName(s))) + '</span></div>';
    });
    if (r.loop && stops.length) {
      var back = r.phase === 'travel' && r.status !== 'stopped' && idx === 0 && num(r.cycles) > 0;
      chain += '<span class="sup-link' + (back ? (stt.cls === 'travel' ? ' moving' : ' toward') : '') + '"></span><span class="sup-loop" title="по кругу">↻</span>';
    }

    var note = (stt.cls !== 'stalled' && r.last_note) ? '<div class="sup-status-note">' + esc(r.last_note) + '</div>' : '';
    if (stt.cls === 'stalled') {
      note = '<div class="sup-status-note">Флот: ' + esc(r.here_name || '—') +
        (r.next_name ? ' · цель: ' + esc(r.next_name) : '') +
        (/Продолжить/.test(r.last_note || '') ? '' : '. Исправь причину и нажми «Продолжить»') + '</div>';
    }

    var live = r.status !== 'stopped';
    var actions = '';
    if (live) {
      var toggle = r.status === 'active'
        ? '<button type="button" class="sup-btn" data-act="route-status" data-id="' + esc(r.id) + '" data-st="paused">Пауза</button>'
        : '<button type="button" class="sup-btn ' + (r.status === 'stalled' ? 'gold' : 'blue') + '" data-act="route-status" data-id="' +
            esc(r.id) + '" data-st="active">Продолжить</button>';
      actions = '<div class="sup-actions">' + toggle +
        '<button type="button" class="sup-btn" data-act="route-edit" data-id="' + esc(r.id) + '">Изменить</button>' +
        '<button type="button" class="sup-btn danger" data-act="route-stop" data-id="' + esc(r.id) + '">Завершить</button>' +
      '</div>';
    }

    var open = !!st.openLogs[r.id];
    var detail = '';
    if (open) {
      detail = '<div class="sup-detail"><div class="sup-plan">' + stops.map(function(s, i) {
        return '<div class="sup-plan-stop"><span>' + (i + 1) + '</span><div><b>' + esc(stopName(s)) + '</b> — ' +
          (s.actions || []).map(actionText).join('; ') + '</div></div>';
      }).join('') + '</div><span class="sup-label">Журнал</span>' + renderLog(r.id) + '</div>';
    }

    return '<div class="sup-route ' + stt.cls + '" data-route="' + esc(r.id) + '">' +
      '<div class="sup-route-top">' +
        '<div><div class="sup-route-name">' + esc(r.name || 'Рейс') + '</div>' +
        '<div class="sup-route-sub"><b>' + esc(r.commander_name || 'Командир') + '</b> · ' +
          num(r.ships) + ' ' + plural(num(r.ships), 'корабль', 'корабля', 'кораблей') +
          ' · свободно ' + num(r.free_cargo) + '</div></div>' +
        '<span class="sup-pill ' + stt.cls + '"><i></i>' + stt.label + '</span>' +
      '</div>' +
      '<div class="sup-chips sup-cargo">' + (cargoChips.length ? cargoChips.join('') : '<span class="sup-cargo-empty">Трюм пуст</span>') + '</div>' +
      '<div class="sup-chain">' + chain + '</div>' +
      '<div class="sup-status">' + statusLine(r, stt) + note + '</div>' +
      '<div class="sup-stats"><span>кругов <b>' + num(r.cycles) + '</b></span><span>перевезено <b>' + num(r.moved_total) + '</b></span></div>' +
      actions +
      '<button type="button" class="sup-fold' + (open ? ' open' : '') + '" data-act="log" data-id="' + esc(r.id) + '">Журнал и план<em>▾</em></button>' +
      detail +
    '</div>';
  }

  function renderLog(id) {
    var rows = st.logs[id];
    if (rows === undefined) return '<div class="sup-note">Загрузка журнала…</div>';
    if (rows === null) return '<div class="sup-note">Журнал не загрузился</div>';
    if (!rows.length) return '<div class="sup-note">Записей пока нет — они появятся на первой остановке</div>';
    return rows.map(function(l) {
      var m = num(l.moved);
      return '<div class="sup-log-row"><span class="sup-log-time">' + esc(timeText(l.at)) + '</span>' +
        '<span class="sup-log-text">' + (l.system_name ? '<b>' + esc(l.system_name) + '</b> · ' : '') + esc(l.text) + '</span>' +
        (m ? '<span class="sup-log-moved">+' + m + '</span>' : '') + '</div>';
    }).join('');
  }

  function renderRoutes() {
    var routes = (st.routes || []).slice();
    var live = routes.filter(function(r) { return r.status !== 'stopped'; });
    var done = routes.filter(function(r) { return r.status === 'stopped'; });
    var rank = { stalled: 0, active: 1, paused: 2 };
    live.sort(function(a, b) { return (rank[a.status] || 3) - (rank[b.status] || 3); });

    var h = '<button type="button" class="sup-new" data-act="route-new"><span>+</span>Новый рейс' +
      (st.hub ? '<em>отсюда · ' + esc(hubName()) + '</em>' : '') + '</button>';

    var convoys = (st.convoys || []).filter(function(c) { return c.status === 'in_flight' || c.status === 'stalled'; });

    if (!live.length) {
      h += '<div class="sup-empty"><b>Рейсов нет</b>' +
        'Рейс — это флот, который сам возит груз: один раз туда (и, если нужно, обратно) или по кругу — забирает там, где отдают, и выгружает там, где нужно.<br><br>' +
        'Чтобы запускать рейсы, нужен логистический хаб хотя бы на одной твоей планете.</div>';
    } else {
      h += live.map(renderRoute).join('');
    }

    if (convoys.length) {
      h += '<div class="sup-section">Конвои в пути<span class="sup-count blue">' + convoys.length + '</span></div>';
      h += convoys.map(renderConvoy).join('');
    }

    if (done.length) {
      h += '<div class="sup-section">Завершённые<span class="sup-count">' + done.length + '</span></div>';
      h += done.slice(0, 5).map(renderRoute).join('');
    }
    return h;
  }

  // Конвой старого образца (отправка со склада или вывоз покупки):
  // только показ — управлять им уже нечем, он долетит сам
  var CONVOY_STAGE = { to_pickup: 'к продавцу', to_dest: 'везёт груз', returning: 'возвращается' };

  function renderConvoy(c) {
    var bad = c.status === 'stalled';
    var path = (c.kind === 'market' && c.pickup_name)
      ? esc(c.pickup_name) + ' → ' + esc(c.to_name)
      : esc(c.from_name) + ' → ' + esc(c.to_name);
    var left = untilLeft(c);
    return '<div class="sup-convoy' + (bad ? ' bad' : '') + '">' +
      '<div class="sup-convoy-info">' +
        '<div class="sup-convoy-cargo">' + (c.kind === 'market' ? '<span class="sup-tag buy">покупка</span> ' : '') +
          esc(c.cargo_text || 'груз') + '</div>' +
        '<div class="sup-convoy-path">' + path + (c.return_home ? ' <span>· и обратно</span>' : '') + '</div>' +
      '</div>' +
      '<div class="sup-convoy-state">' +
        (bad ? '<span class="sup-pill stalled"><i></i>встал</span>'
             : '<span class="sup-pill travel"><i></i>' + esc(CONVOY_STAGE[c.stage] || 'в пути') + '</span>' +
               '<span class="sup-left" data-until="' + num(c._until) + '" data-zero="прибывает">' + (left > 0 ? leftText(left) : 'прибывает') + '</span>') +
      '</div>' +
    '</div>';
  }

  // Локальный отсчёт: только цифры, без перерисовки карточек
  function tickRoutes() {
    // Брони и конвои: отсчёт от момента, а не от счётчика
    var us = document.querySelectorAll('#sup-body [data-until]');
    for (var u = 0; u < us.length; u++) {
      var ms = num(us[u].getAttribute('data-until'));
      if (!ms) continue;
      var sec = Math.max(0, Math.round((ms - Date.now()) / 1000));
      us[u].textContent = sec > 0 ? leftText(sec) : (us[u].getAttribute('data-zero') || '');
    }
    if (!st.routes) return;
    var arrived = false;
    st.routes.forEach(function(r) {
      if (r.status !== 'active' || !(r.seconds_left > 0)) return;
      r.seconds_left -= 1;
      if (r.seconds_left <= 0) arrived = true;
    });
    if (st.tab !== 'routes') return;
    var els = document.querySelectorAll('#sup-body .sup-left[data-left]');
    for (var i = 0; i < els.length; i++) {
      var r = findRoute(els[i].getAttribute('data-left'));
      if (r) els[i].textContent = leftOf(r);
    }
    // Тик сервера раз в 20 с — дадим ему отработать и перечитаем
    if (arrived) setTimeout(function() { if (st.open && st.tab === 'routes') refreshTab(true); }, 6000);
  }

  function findRoute(id) {
    var list = st.routes || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }

  // ── Вкладка «Склады» ───────────────────────────────────────────────

  function ruleKey(sys, res) { return sys + '|' + res; }

  function draftOf(p) {
    var k = ruleKey(p.system_id, p.resource);
    if (!st.drafts[k]) {
      st.drafts[k] = {
        share: !!p.share,
        keep_min: num(p.keep_min),
        max_per_day: (p.max_per_day === null || p.max_per_day === undefined) ? null : num(p.max_per_day),
        audience: p.audience === 'trusted' ? 'trusted' : 'faction',
        want_min: num(p.want_min),
        dirty: false
      };
    }
    return st.drafts[k];
  }

  function giveable(p, d) {
    if (!d.share) return 0;
    var a = num(p.stock) - d.keep_min;
    if (d.max_per_day !== null) a = Math.min(a, d.max_per_day - num(p.taken_today));
    return Math.max(0, a);
  }

  function findPlanetRow(sys, res) {
    var list = st.planets || [];
    for (var i = 0; i < list.length; i++) if (list[i].system_id === sys && list[i].resource === res) return list[i];
    return null;
  }

  function renderStores() {
    var rows = st.planets || [];
    if (!rows.length) {
      return '<div class="sup-empty"><b>Своих складов нет</b>' +
        'Склад принадлежит тому, кто управляет планетой. Получи планету у лидера фракции — и здесь можно будет открыть её склад для снабженцев.</div>';
    }

    var bySys = {}, order = [];
    rows.forEach(function(r) {
      if (!bySys[r.system_id]) { bySys[r.system_id] = []; order.push(r.system_id); }
      bySys[r.system_id].push(r);
    });

    var h = '';
    // Из хаба: сначала склад этой планеты, остальные — по кнопке
    if (st.hub) {
      var hubMine = !!bySys[st.hub.id];
      h += '<div class="sup-seg sup-scope">' +
        segBtn('scope', 'hub', '<i class="sup-dot"></i><span>' + esc(hubName()) + '</span>', st.storeSys === st.hub.id, hubMine ? '' : 'dim') +
        segBtn('scope', 'all', 'Все планеты · ' + order.length, st.storeSys !== st.hub.id) +
      '</div>';
      if (st.storeSys === st.hub.id) {
        if (!hubMine) {
          return h + '<div class="sup-empty"><b>Склад не твой</b>Планетой ' + esc(hubName()) +
            ' сейчас управляет другой игрок — правила её склада задаёт он.' +
            '<br><button type="button" class="sup-btn" data-act="seg" data-group="scope" data-val="all">Все мои склады ›</button></div>';
        }
        order = [st.hub.id];
      }
    }

    h += '<div class="sup-note">Включи «В сеть» — и снабженцы фракции смогут забирать излишки рейсами. ' +
      '«Оставлять себе» никто, кроме тебя, не тронет. «Желаемый запас» покажет планету в сети как нужду.</div>';

    order.forEach(function(sysId) {
      var list = bySys[sysId];
      var shared = list.filter(function(r) { return draftOf(r).share; }).length;
      var main = [], rest = [];
      list.forEach(function(r) {
        var d = draftOf(r);
        if (num(r.stock) > 0 || d.share || d.want_min > 0 || st.openRule[ruleKey(r.system_id, r.resource)]) main.push(r);
        else rest.push(r);
      });
      if (st.showAll[sysId]) { main = list; rest = []; }

      h += '<div class="sup-planet-h"><button type="button" class="sup-pname" data-act="focus" data-sys="' + esc(sysId) + '">' +
        esc(list[0].system_name) + '<em>⌖</em></button>' +
        (shared ? '<span class="sup-count green">в сети ' + shared + '</span>' : '<span class="sup-count">закрыт</span>') + '</div>';

      h += main.map(renderResRow).join('');
      if (rest.length) {
        h += '<button type="button" class="sup-more" data-act="show-all" data-sys="' + esc(sysId) + '">ещё ' + rest.length + ' ' +
          plural(rest.length, 'ресурс', 'ресурса', 'ресурсов') + ' — пусто на складе ▾</button>';
      }

      var open = !!st.openTakes[sysId];
      h += '<div class="sup-takes"><button type="button" class="sup-fold' + (open ? ' open' : '') + '" data-act="takes" data-sys="' +
        esc(sysId) + '">Кто брал<em>▾</em></button>' + (open ? renderTakes(sysId) : '') + '</div>';
    });
    return h;
  }

  function renderResRow(p) {
    var k = ruleKey(p.system_id, p.resource);
    var d = draftOf(p);
    var color = p.color || resInfo(p.resource).color;
    var stock = num(p.stock);
    var open = !!st.openRule[k];

    var h = '<div class="sup-res' + (d.share ? '' : ' off') + '" data-rule="' + esc(k) + '" style="border-left-color:' + esc(color) + '">' +
      '<div class="sup-res-top">' +
        '<span class="sup-res-name">' + esc(p.resource_name || resInfo(p.resource).name) + '</span>' +
        '<span class="sup-res-val">' + stock + '<em> / ' + num(p.cap) + '</em></span>' +
        '<button type="button" class="sup-toggle' + (d.share ? ' on' : '') + '" data-act="share" data-k="' + esc(k) + '"' +
          (st.saving[k] ? ' disabled' : '') + '><i></i>В сеть</button>' +
      '</div>' +
      '<div class="sup-bar">' + barInner(p, d) + '</div>' +
      '<div class="sup-res-sum">' + resSummary(p, d) + '</div>' +
      '<button type="button" class="sup-res-edit' + (open ? ' open' : '') + '" data-act="rule-open" data-k="' + esc(k) + '">' +
        (open ? 'Свернуть' : 'Настроить') + '<em>▾</em></button>';

    if (open) {
      h += '<div class="sup-rule">' +
        qtyField('Оставлять себе', 'keep_min', k, d.keep_min, '0') +
        qtyField('Не больше в сутки', 'max_per_day', k, d.max_per_day, 'без лимита') +
        qtyField('Желаемый запас', 'want_min', k, d.want_min, '0') +
        '<div class="sup-field"><span class="sup-label">Кому</span><div class="sup-seg">' +
          segBtn('aud:' + k, 'faction', 'Фракции', d.audience === 'faction') +
          segBtn('aud:' + k, 'trusted', 'Доверенным', d.audience === 'trusted') +
        '</div></div>' +
        '<div class="sup-rule-foot">' +
          '<span class="sup-rule-preview">' + previewText(p, d) + '</span>' +
          '<button type="button" class="sup-btn ' + (d.dirty ? 'gold' : '') + '" data-act="rule-save" data-k="' + esc(k) + '"' +
            (st.saving[k] ? ' disabled' : '') + '>' + (st.saving[k] ? 'Сохраняю…' : 'Сохранить') + '</button>' +
        '</div>' +
      '</div>';
    }
    return h + '</div>';
  }

  function barInner(p, d) {
    var cap = Math.max(1, num(p.cap));
    var color = p.color || resInfo(p.resource).color;
    var pct = function(v) { return Math.max(0, Math.min(100, v / cap * 100)); };
    return '<i style="width:' + pct(num(p.stock)) + '%;background:' + esc(color) + '"></i>' +
      (d.share && d.keep_min ? '<b class="keep" style="left:' + pct(d.keep_min) + '%"></b>' : '') +
      (d.want_min ? '<b class="want" style="left:' + pct(d.want_min) + '%"></b>' : '');
  }

  function resSummary(p, d) {
    var need = Math.max(0, d.want_min - num(p.stock));
    var sum = [];
    if (d.share) {
      sum.push('<span class="give">отдаёт <b>' + giveable(p, d) + '</b></span>');
      if (d.keep_min) sum.push('<span class="k">себе <b>' + d.keep_min + '</b></span>');
      sum.push('<span>' + (d.max_per_day === null ? 'без лимита' : 'до <b>' + d.max_per_day + '</b>/сут') + '</span>');
      sum.push('<span>' + (d.audience === 'trusted' ? 'доверенным' : 'фракции') + '</span>');
    }
    if (d.want_min) sum.push('<span class="w' + (need ? ' need' : '') + '">' + (need ? 'нужно <b>' + need + '</b>' : 'запас <b>' + d.want_min + '</b>') + '</span>');
    if (num(p.taken_today)) sum.push('<span>вывезено сегодня <b>' + num(p.taken_today) + '</b></span>');
    if (!sum.length) sum.push('<span>не отдаёт в сеть</span>');
    return sum.join('');
  }

  function previewText(p, d) {
    if (!d.share) return 'Снабженцы не заберут — склад закрыт';
    return 'Снабженцы смогут забрать <b>' + giveable(p, d) + '</b>' + (d.audience === 'trusted' ? ' (только доверенные)' : '');
  }

  function qtyField(label, field, k, val, ph) {
    return '<div class="sup-field"><span class="sup-label">' + label + '</span><div class="sup-qty">' +
      '<button type="button" data-act="rule-step" data-k="' + esc(k) + '" data-f="' + field + '" data-d="-1" aria-label="меньше">−</button>' +
      '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" data-rule-f="' + field + '" data-k="' + esc(k) + '"' +
        ' value="' + (val === null ? '' : val) + '" placeholder="' + esc(ph) + '">' +
      '<button type="button" data-act="rule-step" data-k="' + esc(k) + '" data-f="' + field + '" data-d="1" aria-label="больше">+</button>' +
    '</div></div>';
  }

  function renderTakes(sysId) {
    var rows = st.takes[sysId];
    if (rows === undefined) return '<div class="sup-note">Загрузка…</div>';
    if (rows === null) return '<div class="sup-note">Не удалось загрузить</div>';
    if (!rows.length) return '<div class="sup-note">С этого склада пока ничего не забирали</div>';
    return rows.map(function(t) {
      return '<div class="sup-take-row"><span>' + esc(whenText(t.taken_at)) + '</span><div>' + esc(t.taker_name || '—') + ' · ' +
        esc(t.resource_name) + '</div><b>−' + num(t.amount) + '</b></div>';
    }).join('');
  }

  function rerenderRule(k) {
    var el = document.querySelector('#sup-body .sup-res[data-rule="' + cssEsc(k) + '"]');
    var parts = k.split('|');
    var p = findPlanetRow(parts[0], parts[1]);
    if (!el || !p) { render(); return; }
    var tmp = document.createElement('div');
    tmp.innerHTML = renderResRow(p);
    el.parentNode.replaceChild(tmp.firstChild, el);
  }

  // Только «живые» части формы — чтобы поле ввода не теряло фокус
  function refreshRuleLive(k) {
    var el = document.querySelector('#sup-body .sup-res[data-rule="' + cssEsc(k) + '"]');
    var parts = k.split('|');
    var p = findPlanetRow(parts[0], parts[1]);
    if (!el || !p) return;
    var d = draftOf(p);
    var bar = el.querySelector('.sup-bar');
    if (bar) bar.innerHTML = barInner(p, d);
    var pv = el.querySelector('.sup-rule-preview');
    if (pv) pv.innerHTML = previewText(p, d);
    var sv = el.querySelector('[data-act="rule-save"]');
    if (sv) sv.className = 'sup-btn' + (d.dirty ? ' gold' : '');
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function saveRule(k, fromToggle) {
    var parts = k.split('|');
    var p = findPlanetRow(parts[0], parts[1]);
    if (!p) return;
    var d = draftOf(p);
    if (d.max_per_day !== null && d.max_per_day < 0) d.max_per_day = 0;
    st.saving[k] = true;
    rerenderRule(k);
    call('set_supply_rule', {
      p_system_id: p.system_id, p_resource: p.resource, p_share: d.share, p_keep_min: d.keep_min,
      p_max_per_day: d.max_per_day, p_audience: d.audience, p_want_min: d.want_min
    }).then(function(res) {
      st.saving[k] = false;
      if (res.error) {
        // Переключатель не сохранился — возвращаем его к тому, что на сервере
        if (fromToggle) d.share = !!p.share;
        toast(errText(res.error), true);
        rerenderRule(k);
        return;
      }
      p.share = d.share; p.keep_min = d.keep_min; p.max_per_day = d.max_per_day;
      p.audience = d.audience; p.want_min = d.want_min;
      d.dirty = false;
      rerenderRule(k);
      var row = document.querySelector('#sup-body .sup-res[data-rule="' + cssEsc(k) + '"]');
      if (row) { row.classList.add('flash'); setTimeout(function() { row.classList.remove('flash'); }, 1200); }
      toast((p.resource_name || resInfo(p.resource).name) + ': правило сохранено');
      // Сеть изменилась — пусть «Сеть» перечитается при следующем заходе
      st.network = null;
      load(['network'], function() { updateTabCounts(); });
    });
  }

  // ── Вкладка «Доступ» ───────────────────────────────────────────────

  function ava(name) { return '<span class="sup-ava">' + esc(String(name || '?').charAt(0)) + '</span>'; }

  function person(name, sub, btns, cls) {
    return '<div class="sup-person' + (cls ? ' ' + cls : '') + '">' + ava(name) +
      '<div class="sup-person-info"><div class="sup-person-name">' + esc(name || '—') + '</div>' +
      '<div class="sup-person-sub">' + sub + '</div></div>' +
      (btns ? '<div class="sup-person-btns">' + btns + '</div>' : '') + '</div>';
  }

  function ago(iso) {
    var ms = new Date(iso).getTime();
    if (isNaN(ms)) return '';
    var now = (typeof svNow === 'function') ? svNow() : Date.now();
    var m = Math.max(0, Math.round((now - ms) / 60000));
    if (m < 1) return 'только что';
    if (m < 60) return m + ' мин назад';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' ч назад';
    var d = Math.round(h / 24);
    return d + ' ' + plural(d, 'день', 'дня', 'дней') + ' назад';
  }

  function renderAccess() {
    var g = st.grants || [];
    var incoming = incomingRequests();
    var myReq = g.filter(function(x) { return x.direction === 'trusts_me' && x.status === 'pending'; });
    var iTrust = g.filter(function(x) { return x.direction === 'i_trust' && x.status === 'active'; });
    var trustsMe = g.filter(function(x) { return x.direction === 'trusts_me' && x.status === 'active'; });
    var h = '';

    if (incoming.length) {
      h += '<div class="sup-section">Просят доступ<span class="sup-count red">' + incoming.length + '</span></div>';
      h += incoming.map(function(x) {
        return person(x.other_name, 'к твоим складам · ' + esc(ago(x.created_at)),
          '<button type="button" class="sup-btn green" data-act="respond" data-id="' + esc(x.id) + '" data-ok="1">Принять</button>' +
          '<button type="button" class="sup-btn ghost" data-act="respond" data-id="' + esc(x.id) + '" data-ok="0">Нет</button>', 'incoming');
      }).join('');
    }

    h += '<div class="sup-section">Я доверяю<span class="sup-count">' + iTrust.length + '</span></div>';
    h += iTrust.length ? iTrust.map(function(x) {
      return person(x.other_name, '<span class="g">может брать</span> и с твоих складов «только доверенным»',
        '<button type="button" class="sup-btn danger" data-act="revoke" data-id="' + esc(x.id) + '">Отозвать</button>');
    }).join('') : '<div class="sup-note">Никому. Доверенные видят и склады, открытые «только доверенным».</div>';

    h += '<div class="sup-section">Доверяют мне<span class="sup-count">' + trustsMe.length + '</span></div>';
    h += trustsMe.length ? trustsMe.map(function(x) {
      return person(x.other_name, '<span class="b">открыл тебе</span> свои склады «только доверенным»',
        '<button type="button" class="sup-btn ghost" data-act="revoke" data-id="' + esc(x.id) + '">Отказаться</button>');
    }).join('') : '<div class="sup-note">Пока никто. Запроси доступ у игрока ниже — он получит уведомление.</div>';

    if (myReq.length) {
      h += '<div class="sup-section">Мои запросы<span class="sup-count gold">' + myReq.length + '</span></div>';
      h += myReq.map(function(x) {
        return person(x.other_name, '<span class="y">ждёт ответа</span> · ' + esc(ago(x.created_at)),
          '<button type="button" class="sup-btn ghost" data-act="revoke" data-id="' + esc(x.id) + '">Отменить</button>');
      }).join('');
    }

    h += '<div class="sup-section">Игроки фракции</div>';
    if (st.partners === null) {
      h += st.errors.partners ? '<div class="sup-note">' + esc(st.errors.partners) + '</div>' : '<div class="sup-loading">Загрузка…</div>';
      return h;
    }
    if (!st.partners.length) return h + '<div class="sup-note">Во фракции пока нет других игроков</div>';

    var list = st.partners.slice().sort(function(a, b) { return num(b.planets) - num(a.planets); });
    h += list.map(function(p) {
      var mine = grantWith(p.user_id, 'i_trust') || (p.i_trust ? { status: 'active' } : null);
      var theirs = grantWith(p.user_id, 'trusts_me') || (p.trusts_me ? { status: 'active' } : null);
      var sub = [];
      sub.push(num(p.planets) ? num(p.planets) + ' ' + plural(num(p.planets), 'планета', 'планеты', 'планет') : 'без планет');
      if (mine && mine.status === 'active') sub.push('<span class="g">ты доверяешь</span>');
      if (theirs && theirs.status === 'active') sub.push('<span class="b">доверяет тебе</span>');
      if (theirs && theirs.status === 'pending') sub.push('<span class="y">ты запросил доступ</span>');
      if (mine && mine.status === 'pending' && !mine.requested_by_me) sub.push('<span class="y">просит доступ у тебя</span>');

      var btns = '';
      if (mine && mine.status === 'pending' && !mine.requested_by_me) {
        btns += '<button type="button" class="sup-btn green" data-act="respond" data-id="' + esc(mine.id) + '" data-ok="1">Принять</button>';
      } else if (!mine) {
        btns += '<button type="button" class="sup-btn" data-act="grant" data-user="' + esc(p.user_id) + '">Доверять</button>';
      }
      if (!theirs && num(p.planets) > 0) {
        btns += '<button type="button" class="sup-btn green" data-act="request" data-user="' + esc(p.user_id) + '">Запросить</button>';
      }
      return person(p.nickname, sub.join(' · '), btns);
    }).join('');
    return h;
  }

  // ── Вкладка «Рынок» ────────────────────────────────────────────────
  // Лоты галактики, оплаченные покупки (их вывозит свой флот) и свои лоты.
  // Деньги, остатки и пути считает сервер; здесь — формы и подсказки.

  var HUB_CODES = { rep_logistics: 1, cis_logistics: 1 };

  function renderMarket() {
    var waiting = waitingOrders().length;
    var lots = foreignLots();
    var h = '<div class="sup-seg sup-mkt">' +
      segBtn('mkt', 'lots', 'Лоты' + (st.lots ? ' · ' + lots.length : ''), st.mkt === 'lots') +
      segBtn('mkt', 'orders', 'Куплено' + (waiting ? '<i class="sup-seg-n">' + waiting + '</i>' : ''), st.mkt === 'orders') +
      segBtn('mkt', 'mine', 'Мои лоты' + (st.mylots && st.mylots.length ? ' · ' + st.mylots.length : ''), st.mkt === 'mine') +
    '</div>';

    var key = { lots: 'lots', orders: 'orders', mine: 'mylots' }[st.mkt];
    if (st[key] === null) {
      if (st.errors[key]) {
        return h + '<div class="sup-empty"><b>Не удалось загрузить</b>' + esc(st.errors[key]) +
          '<br><button type="button" class="sup-btn" data-act="retry">Повторить</button></div>';
      }
      return h + '<div class="sup-loading">Загрузка…</div>';
    }
    if (st.mkt === 'lots') return h + renderLots(lots);
    if (st.mkt === 'orders') return h + renderOrders();
    return h + renderMine();
  }

  function foreignLots() {
    return (st.lots || []).filter(function(l) { return !l.mine && num(l.amount_left) > 0; });
  }

  function findBy(list, key, id) {
    list = list || [];
    for (var i = 0; i < list.length; i++) if (String(list[i][key]) === String(id)) return list[i];
    return null;
  }

  function resDot(res, color) {
    return '<i style="background:' + esc(color || resInfo(res).color) + '"></i>';
  }

  function money(n) {
    // 12400 → «12 400»: тонкий неразрывный пробел между тысячами
    return String(num(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  // ---------- Лоты ----------

  function buyQty(l) {
    var q = st.buyQty[l.lot_id];
    if (q === undefined) q = Math.min(10, num(l.amount_left));
    return Math.max(0, Math.min(num(l.amount_left), q));
  }

  function renderLots(list) {
    if (!list.length) {
      return '<div class="sup-empty"><b>Лотов нет</b>Сейчас в галактике никто ничего не продаёт.<br>' +
        'Выставить свой товар можно в разделе «Мои лоты».</div>';
    }

    var kinds = [];
    list.forEach(function(l) { if (kinds.indexOf(l.resource) < 0) kinds.push(l.resource); });
    if (st.mktRes !== 'all' && kinds.indexOf(st.mktRes) < 0) st.mktRes = 'all';

    var h = '';
    if (kinds.length > 1) {
      h += '<div class="sup-fchips">' +
        '<button type="button" class="sup-fchip' + (st.mktRes === 'all' ? ' on' : '') + '" data-act="seg" data-group="mktres" data-val="all">Все · ' + list.length + '</button>' +
        kinds.map(function(k) {
          var n = list.filter(function(l) { return l.resource === k; }).length;
          return '<button type="button" class="sup-fchip' + (st.mktRes === k ? ' on' : '') + '" data-act="seg" data-group="mktres" data-val="' + esc(k) + '">' +
            resDot(k) + esc(resInfo(k).name) + ' · ' + n + '</button>';
        }).join('') + '</div>';
    }

    h += '<div class="sup-note">Покупка ждёт на складе продавца сутки — за ней летит твой флот (раздел «Куплено»). ' +
      'Деньги списываются сразу.</div>';

    list.filter(function(l) { return st.mktRes === 'all' || l.resource === st.mktRes; }).forEach(function(l) {
      h += renderLot(l);
    });
    return h;
  }

  function renderLot(l) {
    var q = buyQty(l);
    var color = resInfo(l.resource).color;
    var tags = '';
    if (l.foreign_side) tags += '<span class="sup-tag enemy">противник</span>';
    else if (l.open_to === 'all') tags += '<span class="sup-tag open">открыт всем</span>';
    var id = esc(l.lot_id);
    return '<div class="sup-lot' + (l.foreign_side ? ' foreign' : '') + '" data-lot="' + id + '" style="border-left-color:' + esc(color) + '">' +
      '<div class="sup-lot-top">' +
        '<span class="sup-lot-res">' + esc(l.resource_name || resInfo(l.resource).name) + '</span>' +
        '<span class="sup-lot-price"><b>' + money(l.price_per_unit) + '</b> кр/ед</span>' +
      '</div>' +
      '<div class="sup-lot-sub"><b>' + esc(l.seller_name || '—') + '</b> · ' + esc(l.system_name || '—') +
        ' · в наличии <b>' + num(l.amount_left) + '</b>' + (tags ? ' ' + tags : '') + '</div>' +
      '<div class="sup-lot-buy">' +
        '<div class="sup-qty">' +
          '<button type="button" data-act="buy-step" data-id="' + id + '" data-d="-1" aria-label="меньше">−</button>' +
          '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" data-mk="buyq" data-id="' + id + '" value="' + q + '">' +
          '<button type="button" data-act="buy-step" data-id="' + id + '" data-d="1" aria-label="больше">+</button>' +
        '</div>' +
        '<button type="button" class="sup-mini" data-act="buy-max" data-id="' + id + '">всё</button>' +
        '<button type="button" class="sup-btn buy" data-act="buy" data-id="' + id + '"' + (q > 0 ? '' : ' disabled') + '>Купить</button>' +
      '</div>' +
      '<div class="sup-lot-cost" data-cost="' + id + '">' + costText(l, q, false) + '</div>' +
    '</div>';
  }

  function costText(l, q, confirm) {
    if (!(q > 0)) return 'Укажи, сколько купить';
    var sum = money(q * num(l.price_per_unit));
    if (confirm) return '<span class="y">Спишется <b>' + sum + ' кр</b> — нажми ещё раз. Забирать флотом с планеты ' + esc(l.system_name) + '</span>';
    return 'Итого <b>' + sum + ' кр</b>' + (l.foreign_side ? ' · <span class="r">вывоз — только через свои миры</span>' : '');
  }

  function refreshLotLive(id) {
    var l = findBy(st.lots, 'lot_id', id);
    if (!l) return;
    var q = buyQty(l);
    var cost = document.querySelector('#sup-body [data-cost="' + cssEsc(id) + '"]');
    if (cost) cost.innerHTML = costText(l, q, false);
    var btn = document.querySelector('#sup-body [data-act="buy"][data-id="' + cssEsc(id) + '"]');
    if (btn) { btn.disabled = !(q > 0); btn.classList.remove('confirm'); btn.textContent = 'Купить'; }
  }

  function buyLot(id, btn) {
    var l = findBy(st.lots, 'lot_id', id);
    if (!l) return;
    var q = buyQty(l);
    if (!(q > 0)) return;
    // Двойное касание вместо системного окна: первое показывает сумму
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = 'Точно?';
      var cost = document.querySelector('#sup-body [data-cost="' + cssEsc(id) + '"]');
      if (cost) cost.innerHTML = costText(l, q, true);
      setTimeout(function() {
        if (document.body.contains(btn) && btn.classList.contains('confirm')) refreshLotLive(id);
      }, 4000);
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Покупаю…';
    call('buy_market_lot', { p_lot_id: l.lot_id, p_amount: q }).then(function(res) {
      if (res.error) {
        toast(errText(res.error), true);
        load(['lots'], function() { if (st.tab === 'market') render(); });
        return;
      }
      delete st.buyQty[l.lot_id];
      toast('Куплено: ' + (l.resource_name || resInfo(l.resource).name).toLowerCase() + ' ' + q + ' за ' + money(q * num(l.price_per_unit)) +
        ' кр. Теперь отправь за покупкой флот');
      // Сразу к вывозу: форма новой брони уже раскрыта
      st.mkt = 'orders';
      if (res.data) { openPick(String(res.data)); st.pick.scroll = true; }
      load(['lots', 'orders'], function() { updateTabCounts(); if (st.tab === 'market') { render(); scrollToPick(); } });
      if (typeof refreshCreditsBar === 'function') { try { refreshCreditsBar(); } catch (e) { /* полоса кредитов догонит сама */ } }
    });
  }

  // ---------- Куплено ----------

  function renderOrders() {
    var list = (st.orders || []).slice();
    if (!list.length) {
      return '<div class="sup-empty"><b>Оплаченных покупок нет</b>Купи лот в разделе «Лоты» — он сутки ждёт на складе продавца, ' +
        'пока за ним не прилетит твой флот.<br><button type="button" class="sup-btn" data-act="seg" data-group="mkt" data-val="lots">К лотам ›</button></div>';
    }
    var h = '<div class="sup-note">Флот сам долетит до продавца через свои миры, заберёт покупку и отвезёт куда скажешь. ' +
      'Весь заказ должен влезть в трюм.</div>';
    list.sort(function(a, b) { return (a.fleet_sent ? 1 : 0) - (b.fleet_sent ? 1 : 0) || untilLeft(a) - untilLeft(b); });
    return h + list.map(renderOrder).join('');
  }

  function renderOrder(o) {
    var id = esc(o.order_id);
    var left = untilLeft(o);
    var expired = left <= 0;
    var soon = !expired && left < 3600;
    var open = st.pick && st.pick.orderId === String(o.order_id) && !o.fleet_sent && !expired;
    var pill = o.fleet_sent ? '<span class="sup-pill travel"><i></i>флот в пути</span>'
      : expired ? '<span class="sup-pill stalled"><i></i>истекла</span>'
      : '<span class="sup-pill waiting"><i></i>ждёт вывоза</span>';

    var h = '<div class="sup-order' + (o.fleet_sent ? ' sent' : '') + (open ? ' open' : '') + '" data-order="' + id + '"' +
      ' style="border-left-color:' + esc(resInfo(o.resource).color) + '">' +
      '<div class="sup-lot-top"><span class="sup-lot-res">' + esc(o.resource_name || resInfo(o.resource).name) +
        ' <b>' + num(o.amount_left) + '</b></span>' + pill + '</div>' +
      '<div class="sup-lot-sub">У продавца на <b>' + esc(o.system_name || '—') + '</b> · оплачено ' + money(o.paid) + ' кр</div>';

    if (!o.fleet_sent) {
      h += '<div class="sup-order-left' + (soon ? ' soon' : '') + (expired ? ' gone' : '') + '">' +
        (expired ? 'Срок брони истёк' : 'Бронь ещё <span data-until="' + num(o._until) + '" data-zero="истекает">' + leftText(left) + '</span>') + '</div>';
      if (!expired) {
        h += open
          ? renderPickForm(o)
          : '<button type="button" class="sup-btn buy wide" data-act="pick-open" data-id="' + id + '">Вывезти флотом</button>';
      }
    } else {
      h += '<div class="sup-order-left">Флот уже летит — смотри «Конвои в пути» во вкладке «Рейсы»</div>';
    }
    return h + '</div>';
  }

  function openPick(orderId) {
    st.pick = { orderId: orderId, commanderId: null, dest: null, destTouched: false, back: false, sending: false };
    st.cmds = null;
    st.cmdsError = null;
    loadSystems(function() { if (st.tab === 'market' && st.mkt === 'orders') render(); });
    call('get_supply_commanders').then(function(res) {
      if (!st.pick || st.pick.orderId !== orderId) return;
      st.cmds = sortByHub(res.error ? [] : (res.data || []));
      st.cmdsError = res.error ? errText(res.error) : null;
      var o = findBy(st.orders, 'order_id', orderId);
      st.pick.commanderId = pickPickupCommander(st.cmds, o ? num(o.amount_left) : 0);
      if (st.tab === 'market' && st.mkt === 'orders') { render(); scrollToPick(); }
    });
  }

  // Новая покупка встаёт в список не первой — подводим экран к её форме
  function scrollToPick() {
    if (!st.pick || !st.pick.scroll) return;
    var el = document.querySelector('#sup-body .sup-order.open');
    var scr = screenEl();
    if (!el || !scr) return;
    if (st.cmds !== null) st.pick.scroll = false;
    var head = scr.querySelector('.sup-head');
    scr.scrollTop = Math.max(0, el.offsetTop - (head ? head.offsetHeight : 0) - 12);
  }

  // Готовый свободный флот с местом под весь заказ; из хаба — тот, что у хаба
  function pickPickupCommander(list, need) {
    var ok = (list || []).filter(function(c) { return !c.busy && c.ready && num(c.free_cargo) >= need; });
    if (st.hub) {
      var here = ok.filter(function(c) { return c.system_id === st.hub.id; });
      if (here.length) return here[0].commander_id;
    }
    if (ok.length) return ok[0].commander_id;
    var free = (list || []).filter(function(c) { return !c.busy; });
    return free.length ? free[0].commander_id : null;
  }

  function pickCommanderRow() {
    return st.pick ? findBy(st.cmds, 'commander_id', st.pick.commanderId) : null;
  }

  // Куда везти по умолчанию: в хаб, из которого открыт экран, иначе туда, где стоит флот
  function pickDest() {
    var p = st.pick;
    if (!p) return null;
    if (p.destTouched && p.dest) return p.dest;
    if (st.hub) return st.hub.id;
    var c = pickCommanderRow();
    return c && c.system_id ? c.system_id : (p.dest || null);
  }

  function renderPickForm(o) {
    var p = st.pick;
    var h = '<div class="sup-pick">';

    h += '<span class="sup-label">Флот</span>';
    if (st.cmds === null) {
      h += '<div class="sup-loading" style="padding:10px">Загрузка…</div></div>';
      return h;
    }
    if (!st.cmds.length) {
      h += '<div class="sup-note">' + (st.cmdsError ? esc(st.cmdsError) :
        'Нет командиров с флотом. Назначь командиру корабли в разделе «Армия».') + '</div></div>';
      return h;
    }

    var need = num(o.amount_left);
    var cv = hubCommanders(st.cmds, p.commanderId, p.showAll);
    h += cv.shown.map(function(c) {
      var s = cmdState(c);
      if (!c.busy && c.ready && num(c.free_cargo) < need) s = { cls: 'warn', text: 'мало места' };
      var on = c.commander_id === p.commanderId;
      return '<button type="button" class="sup-cmd' + (on ? ' on' : '') + '" data-act="pick-cmd" data-id="' + esc(c.commander_id) + '"' +
        (c.busy ? ' disabled' : '') + '><span class="sup-radio"></span><div class="sup-cmd-info">' +
        '<div class="sup-cmd-name">' + esc(c.name) + '</div>' +
        '<div class="sup-cmd-sub">' + (st.hub && c.system_id === st.hub.id ? '<span class="sup-here">у хаба</span> ' : '') +
          esc(c.system_name || '—') + ' · трюм ' + num(c.free_cargo) + '</div></div>' +
        '<span class="sup-cmd-state ' + s.cls + '">' + s.text + '</span></button>';
    }).join('');
    if (cv.hidden) {
      h += '<button type="button" class="sup-more" data-act="pick-all">флоты на других планетах · ' + cv.hidden + ' ▾</button>';
    }

    var c = pickCommanderRow();
    var origin = c ? c.system_id : null;
    var dest = pickDest();

    h += '<span class="sup-label" style="margin-top:10px">Куда выгрузить</span>' +
      '<select class="sup-select" data-mk="pick-dest">' + destOptions(dest, origin) + '</select>';

    var showBack = !!(origin && dest && dest !== origin);
    if (showBack) {
      h += '<button type="button" class="sup-looprow' + (p.back ? ' on' : '') + '" data-act="pick-back">' +
        '<span>Вернуться домой<i>' + (p.back ? 'после выгрузки флот вернётся на ' + esc(c.system_name || sysName(origin))
          : 'флот останется на ' + esc(sysName(dest))) + '</i></span>' +
        '<span class="sup-toggle' + (p.back ? ' on' : '') + '"><i></i>' + (p.back ? 'да' : 'нет') + '</span></button>';
    }

    // Путь словами: откуда → продавец → куда (→ обратно)
    if (c && dest) {
      var parts = [];
      if (origin !== o.system_id) parts.push(esc(c.system_name || sysName(origin)));
      parts.push('<b>' + esc(o.system_name) + '</b> <em>погрузка</em>');
      if (dest !== o.system_id) parts.push(esc(sysName(dest)) + ' <em>выгрузка</em>');
      else parts[parts.length - 1] = '<b>' + esc(o.system_name) + '</b> <em>погрузка и выгрузка</em>';
      if (showBack && p.back) parts.push(esc(c.system_name || sysName(origin)));
      h += '<div class="sup-pick-path"><span>' + parts.join('</span><i>→</i><span>') + '</span></div>';
    }

    var why = null;
    if (!c) why = 'Выбери флот';
    else if (c.busy) why = 'Этот флот занят';
    else if (!c.ready) why = 'Флот не в зоне прыжка — выведи весь флот в полосу у края орбиты';
    else if (num(c.free_cargo) < need) why = 'Не влезет: покупка ' + need + ', свободно ' + num(c.free_cargo);
    else if (!dest) why = 'Выбери планету выгрузки';

    h += '<div class="sup-pick-fit' + (c && num(c.free_cargo) < need ? ' over' : '') + '">' +
      (c ? 'Покупка <b>' + need + '</b> · свободно в трюме <b>' + num(c.free_cargo) + '</b>' : '') + '</div>';
    if (why && c) h += '<div class="sup-hint warn">' + esc(why) + '</div>';
    h += '<div class="sup-pick-btns">' +
      '<button type="button" class="sup-btn ghost" data-act="pick-close">Отмена</button>' +
      '<button type="button" class="sup-btn gold" data-act="pick-go"' + (why || p.sending ? ' disabled' : '') + '>' +
        (p.sending ? 'Отправляю…' : 'Отправить за покупкой') + '</button></div>';
    return h + '</div>';
  }

  function destOptions(sel, origin) {
    var h = '';
    var have = false;
    var list = (st.systems || []).slice();
    // Наверх — хаб и место стоянки флота: чаще всего везут туда
    list.sort(function(a, b) {
      var ra = (st.hub && a.id === st.hub.id) ? 0 : a.id === origin ? 1 : isMyPlanet(a.id) ? 2 : 3;
      var rb = (st.hub && b.id === st.hub.id) ? 0 : b.id === origin ? 1 : isMyPlanet(b.id) ? 2 : 3;
      return ra - rb || String(a.name).localeCompare(String(b.name), 'ru');
    });
    list.forEach(function(s) {
      if (s.id === sel) have = true;
      var tail = (st.hub && s.id === st.hub.id) ? 'этот хаб' : s.id === origin ? 'флот здесь' : isMyPlanet(s.id) ? 'моя' : '';
      h += '<option value="' + esc(s.id) + '"' + (s.id === sel ? ' selected' : '') + '>' + esc(s.name) +
        (tail ? ' · ' + tail : '') + '</option>';
    });
    if (!have) h = '<option value="" disabled' + (sel ? '' : ' selected') + '>— выбери планету —</option>' + h;
    return h;
  }

  function sendPickup(btn) {
    var p = st.pick;
    var c = pickCommanderRow();
    var dest = pickDest();
    if (!p || !c || !dest || p.sending) return;
    p.sending = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Отправляю…'; }
    call('dispatch_market_pickup', {
      p_commander_id: c.commander_id,
      p_order_id: p.orderId,
      p_to_system: dest,
      p_return_home: dest === c.system_id ? false : !!p.back
    }).then(function(res) {
      if (!st.pick) return;
      st.pick.sending = false;
      if (res.error) { toast(errText(res.error), true); render(); return; }
      st.pick = null;
      toast('Флот вылетел за покупкой — следи в «Рейсах», раздел «Конвои в пути»');
      load(['orders', 'convoys'], function() { updateTabCounts(); if (st.tab === 'market') render(); });
    });
  }

  // ---------- Мои лоты ----------

  function myPlanetList() {
    var seen = {}, out = [];
    (st.planets || []).forEach(function(p) {
      if (seen[p.system_id]) return;
      seen[p.system_id] = 1;
      out.push({ id: p.system_id, name: p.system_name });
    });
    return out;
  }

  // Торговать можно только с планеты, где достроен логистический хаб —
  // так решает сервер. Спрашиваем постройки один раз на планету.
  function checkHubs(list) {
    list.forEach(function(p) {
      if (st.hubs[p.id] !== undefined) return;
      st.hubs[p.id] = 'loading';
      call('get_system_buildings', { p_system_id: p.id }).then(function(res) {
        if (res.error || !res.data) { st.hubs[p.id] = null; }
        else {
          var now = Date.now();
          st.hubs[p.id] = res.data.some(function(b) {
            // Трофейный хаб чужой стороны сервер не засчитает
            return HUB_CODES[b.type_code] && (!b.completes_at || new Date(b.completes_at).getTime() <= now) &&
              (!st.faction || !b.faction || b.faction === st.faction);
          });
        }
        if (st.open && st.tab === 'market' && st.mkt === 'mine' && !isEditingMarket()) render();
      });
    });
  }

  function isEditingMarket() {
    var a = document.activeElement;
    return !!(a && a.closest && a.closest('#supply-screen .sup-form') && a.tagName === 'INPUT');
  }

  function lotForm() {
    if (!st.lotForm) st.lotForm = { sys: null, res: null, amount: 10, price: 20, aud: 'faction', sending: false };
    return st.lotForm;
  }

  function stockRows(sys) {
    return (st.planets || []).filter(function(p) { return p.system_id === sys && num(p.stock) > 0; });
  }

  // Подбираем планету и ресурс так, чтобы форма сразу была рабочей
  function settleLotForm(planets) {
    var f = lotForm();
    var ids = planets.map(function(p) { return p.id; });
    if (!f.sys || ids.indexOf(f.sys) < 0) {
      if (st.hub && ids.indexOf(st.hub.id) >= 0) f.sys = st.hub.id;
      else {
        var withHub = planets.filter(function(p) { return st.hubs[p.id] === true; });
        f.sys = (withHub[0] || planets[0] || {}).id || null;
      }
    }
    var rows = stockRows(f.sys);
    if (!findBy(rows, 'resource', f.res)) f.res = rows.length ? rows[0].resource : null;
    var row = findBy(rows, 'resource', f.res);
    var max = row ? num(row.stock) : 0;
    if (f.amount > max) f.amount = max;
    if (f.amount < 1 && max > 0) f.amount = Math.min(10, max);
    return { f: f, rows: rows, max: max };
  }

  function renderMine() {
    var planets = myPlanetList();
    checkHubs(planets);
    var h = '<div class="sup-section">Выставить лот</div>';

    if (!planets.length) {
      h += '<div class="sup-note">Продают со склада своей планеты, где достроен логистический хаб. Своих планет пока нет.</div>';
    } else {
      var s = settleLotForm(planets);
      var f = s.f;
      var hubState = st.hubs[f.sys];
      var noHub = hubState === false;

      h += '<div class="sup-form">' +
        '<div class="sup-field"><span class="sup-label">Склад планеты</span>' +
          '<select class="sup-select" data-mk="lot-sys">' + planets.map(function(p) {
            var tail = st.hubs[p.id] === false ? ' · нет хаба' : (st.hub && p.id === st.hub.id ? ' · этот хаб' : '');
            return '<option value="' + esc(p.id) + '"' + (p.id === f.sys ? ' selected' : '') + '>' + esc(p.name) + tail + '</option>';
          }).join('') + '</select></div>';

      if (noHub) {
        h += '<div class="sup-avail warn">На этой планете нет достроенного логистического хаба — продавать отсюда нельзя</div>';
      }

      if (!s.rows.length) {
        h += '<div class="sup-note" style="margin:10px 2px 0">Склад планеты пуст — продавать нечего.</div></div>';
      } else {
        h += '<div class="sup-field"><span class="sup-label">Ресурс</span>' +
          '<select class="sup-select" data-mk="lot-res">' + s.rows.map(function(r) {
            return '<option value="' + esc(r.resource) + '"' + (r.resource === f.res ? ' selected' : '') + '>' +
              esc(r.resource_name || resInfo(r.resource).name) + ' — на складе ' + num(r.stock) + '</option>';
          }).join('') + '</select></div>' +
          '<div class="sup-rule">' +
            '<div class="sup-field"><span class="sup-label">Сколько <i>из ' + s.max + '</i></span><div class="sup-qty">' +
              '<button type="button" data-act="lot-step" data-f="amount" data-d="-1" aria-label="меньше">−</button>' +
              '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" data-mk="lot-amount" value="' + num(f.amount) + '">' +
              '<button type="button" data-act="lot-step" data-f="amount" data-d="1" aria-label="больше">+</button></div></div>' +
            '<div class="sup-field"><span class="sup-label">Цена за ед., кр</span><div class="sup-qty">' +
              '<button type="button" data-act="lot-step" data-f="price" data-d="-1" aria-label="дешевле">−</button>' +
              '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" data-mk="lot-price" value="' + num(f.price) + '">' +
              '<button type="button" data-act="lot-step" data-f="price" data-d="1" aria-label="дороже">+</button></div></div>' +
            '<div class="sup-field full"><span class="sup-label">Кому продавать</span><div class="sup-seg">' +
              segBtn('lotaud', 'faction', 'Своей фракции', f.aud === 'faction') +
              segBtn('lotaud', 'all', 'Всем, и противнику', f.aud === 'all', 'enemy') +
            '</div></div>' +
          '</div>' +
          '<div class="sup-lot-cost" id="sup-lot-sum">' + lotSummary(f) + '</div>' +
          '<button type="button" class="sup-go" data-act="lot-create"' + (lotFormError(f, s.max) || noHub || f.sending ? ' disabled' : '') + '>' +
            (f.sending ? 'Выставляю…' : 'Выставить лот') + '</button>' +
        '</div>';
      }
    }

    var mine = st.mylots || [];
    h += '<div class="sup-section">Мои лоты<span class="sup-count">' + mine.length + '</span></div>';
    if (!mine.length) return h + '<div class="sup-note">Ты ничего не продаёшь.</div>';
    return h + mine.map(renderMyLot).join('');
  }

  function lotFormError(f, max) {
    if (!f.res) return 'Выбери ресурс';
    if (!(num(f.amount) > 0)) return 'Укажи количество';
    if (num(f.amount) > max) return 'На складе только ' + max;
    if (!(num(f.price) > 0)) return 'Укажи цену';
    return null;
  }

  function lotSummary(f) {
    var row = findBy(stockRows(f.sys), 'resource', f.res);
    var err = lotFormError(f, row ? num(row.stock) : 0);
    if (err) return '<span class="r">' + esc(err) + '</span>';
    return 'Со склада сразу спишется <b>' + num(f.amount) + '</b> · выручка до <b>' + money(num(f.amount) * num(f.price)) + ' кр</b>' +
      (f.aud === 'all' ? '<br><span class="y">Лот увидит и купит противник</span>' : '');
  }

  function refreshLotFormLive() {
    var f = lotForm();
    var sum = document.getElementById('sup-lot-sum');
    if (sum) sum.innerHTML = lotSummary(f);
    var row = findBy(stockRows(f.sys), 'resource', f.res);
    var go = document.querySelector('#sup-body [data-act="lot-create"]');
    if (go) go.disabled = !!lotFormError(f, row ? num(row.stock) : 0) || st.hubs[f.sys] === false || f.sending;
  }

  function renderMyLot(l) {
    var id = esc(l.lot_id);
    var reserved = num(l.reserved);
    return '<div class="sup-lot mine" style="border-left-color:' + esc(resInfo(l.resource).color) + '">' +
      '<div class="sup-lot-top">' +
        '<span class="sup-lot-res">' + esc(l.resource_name || resInfo(l.resource).name) + ' <b>' + num(l.amount_left) + '</b></span>' +
        '<span class="sup-lot-price"><b>' + money(l.price_per_unit) + '</b> кр/ед</span>' +
      '</div>' +
      '<div class="sup-lot-sub">' + esc(l.system_name || '—') +
        (l.open_to === 'all' ? ' <span class="sup-tag enemy">всем</span>' : ' <span class="sup-tag mine">своим</span>') +
        (reserved ? ' · <span class="y">забронировано ' + reserved + '</span>' : '') + '</div>' +
      '<div class="sup-actions">' +
        (reserved
          ? '<span class="sup-lot-lock">Есть брони — снять можно после вывоза или истечения</span>'
          : '<button type="button" class="sup-btn danger" data-act="lot-cancel" data-id="' + id + '">Снять с продажи</button>') +
      '</div>' +
    '</div>';
  }

  function createLot(btn) {
    var f = lotForm();
    if (f.sending) return;
    var row = findBy(stockRows(f.sys), 'resource', f.res);
    if (lotFormError(f, row ? num(row.stock) : 0)) { refreshLotFormLive(); return; }
    f.sending = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Выставляю…'; }
    call('create_market_lot', {
      p_system_id: f.sys, p_resource: f.res, p_amount: num(f.amount), p_price: num(f.price), p_open_to: f.aud
    }).then(function(res) {
      f.sending = false;
      if (res.error) { toast(errText(res.error), true); if (st.tab === 'market') render(); return; }
      toast('Лот выставлен: ' + resInfo(f.res).name.toLowerCase() + ' ' + num(f.amount) + ' по ' + money(f.price) + ' кр');
      f.amount = 10;
      load(['mylots', 'planets', 'lots'], function() { updateTabCounts(); if (st.tab === 'market') render(); });
    });
  }

  function cancelLot(id, btn) {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = 'Точно снять?';
      setTimeout(function() {
        if (document.body.contains(btn) && btn.classList.contains('confirm')) { btn.classList.remove('confirm'); btn.textContent = 'Снять с продажи'; }
      }, 3000);
      return;
    }
    var l = findBy(st.mylots, 'lot_id', id);
    btn.disabled = true;
    call('cancel_market_lot', { p_lot_id: id }).then(function(res) {
      if (res.error) { btn.disabled = false; toast(errText(res.error), true); return; }
      var fit = num(res.data), left = l ? num(l.amount_left) : fit;
      toast(fit < left ? 'Лот снят — на склад влезло ' + fit + ' из ' + left : 'Лот снят — остаток вернулся на склад');
      load(['mylots', 'planets', 'lots'], function() { updateTabCounts(); if (st.tab === 'market') render(); });
    });
  }

  function marketClick(act, b) {
    var id = b.getAttribute('data-id');
    if (act === 'buy-step' || act === 'buy-max') {
      var l = findBy(st.lots, 'lot_id', id);
      if (!l) return true;
      var max = num(l.amount_left), cur = buyQty(l), next;
      if (act === 'buy-max') next = max;
      else {
        var dir = num(b.getAttribute('data-d'));
        next = dir > 0 ? (Math.floor(cur / STEP) + 1) * STEP : (Math.ceil(cur / STEP) - 1) * STEP;
      }
      next = Math.max(1, Math.min(max, next));
      st.buyQty[l.lot_id] = next;
      var inp = document.querySelector('#sup-body input[data-mk="buyq"][data-id="' + cssEsc(id) + '"]');
      if (inp) inp.value = next;
      refreshLotLive(id);
      return true;
    }
    if (act === 'buy') { buyLot(id, b); return true; }
    if (act === 'pick-open') { openPick(id); render(); return true; }
    if (act === 'pick-close') { st.pick = null; render(); return true; }
    if (act === 'pick-cmd') {
      if (!st.pick) return true;
      st.pick.commanderId = id;
      render();
      return true;
    }
    if (act === 'pick-all') { if (st.pick) { st.pick.showAll = true; render(); } return true; }
    if (act === 'pick-back') { if (st.pick) { st.pick.back = !st.pick.back; render(); } return true; }
    if (act === 'pick-go') { sendPickup(b); return true; }
    if (act === 'lot-step') {
      var f = lotForm(), fld = b.getAttribute('data-f'), d = num(b.getAttribute('data-d'));
      var step = fld === 'price' ? 1 : STEP;
      var v = num(f[fld]);
      var nv = step === 1 ? v + d : (d > 0 ? (Math.floor(v / step) + 1) * step : (Math.ceil(v / step) - 1) * step);
      if (fld === 'amount') {
        var row = findBy(stockRows(f.sys), 'resource', f.res);
        nv = Math.min(row ? num(row.stock) : 0, nv);
      }
      f[fld] = Math.max(1, nv);
      var input = b.parentNode.querySelector('input');
      if (input) input.value = f[fld];
      refreshLotFormLive();
      return true;
    }
    if (act === 'lot-create') { createLot(b); return true; }
    if (act === 'lot-cancel') { cancelLot(id, b); return true; }
    return false;
  }

  function marketInput(t) {
    var mk = t.getAttribute('data-mk');
    if (!mk) return false;
    if (mk === 'pick-dest') {
      if (st.pick) { st.pick.dest = t.value; st.pick.destTouched = true; render(); }
      return true;
    }
    if (mk === 'lot-sys' || mk === 'lot-res') {
      var f = lotForm();
      if (mk === 'lot-sys') { f.sys = t.value; f.res = null; } else f.res = t.value;
      f.amount = 10;
      render();
      return true;
    }
    var clean = String(t.value).replace(/[^0-9]/g, '');
    if (clean !== t.value) t.value = clean;
    if (mk === 'buyq') {
      var id = t.getAttribute('data-id');
      var l = findBy(st.lots, 'lot_id', id);
      if (!l) return true;
      var q = Math.min(num(l.amount_left), num(clean));
      if (clean !== '' && q !== num(clean)) t.value = q;
      st.buyQty[l.lot_id] = q;
      refreshLotLive(id);
      return true;
    }
    if (mk === 'lot-amount') { lotForm().amount = num(clean); refreshLotFormLive(); return true; }
    if (mk === 'lot-price') { lotForm().price = num(clean); refreshLotFormLive(); return true; }
    return true;
  }

  // ── События ────────────────────────────────────────────────────────

  function onBodyClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');

    if (act === 'retry') { refreshTab(); return; }
    if (act === 'tab') { switchTab(b.getAttribute('data-tab')); return; }
    if (marketClick(act, b)) return;

    if (act === 'focus') { focusSystem(b.getAttribute('data-sys')); return; }

    if (act === 'seg') {
      var group = b.getAttribute('data-group'), val = b.getAttribute('data-val');
      if (group === 'filter') { st.filter = val; render(); return; }
      if (group === 'scope') { st.storeSys = (val === 'hub' && st.hub) ? st.hub.id : null; render(); return; }
      if (group === 'mkt') { st.mkt = val; st.pick = null; screenEl().scrollTop = 0; render(); return; }
      if (group === 'mktres') { st.mktRes = val; render(); return; }
      if (group === 'lotaud') { lotForm().aud = val; render(); return; }
      if (group.indexOf('aud:') === 0) {
        var k = group.slice(4);
        var p = findPlanetRow(k.split('|')[0], k.split('|')[1]);
        if (!p) return;
        var d = draftOf(p);
        d.audience = val; d.dirty = true;
        rerenderRule(k);
      }
      return;
    }

    if (act === 'route-from') { openEditorFrom(b.getAttribute('data-sys'), b.getAttribute('data-mode')); return; }
    if (act === 'route-new') { openNewRoute(); return; }
    if (act === 'route-edit') { openEditor(findRoute(b.getAttribute('data-id'))); return; }

    if (act === 'route-status') { setRouteStatus(b.getAttribute('data-id'), b.getAttribute('data-st'), b); return; }

    if (act === 'route-stop') {
      // Двойное нажатие вместо системного окна: второе подтверждает
      if (!b.classList.contains('confirm')) {
        b.classList.add('confirm');
        b.textContent = 'Точно?';
        setTimeout(function() {
          if (document.body.contains(b) && b.classList.contains('confirm')) { b.classList.remove('confirm'); b.textContent = 'Завершить'; }
        }, 3000);
        return;
      }
      setRouteStatus(b.getAttribute('data-id'), 'stopped', b);
      return;
    }

    if (act === 'log') {
      var id = b.getAttribute('data-id');
      st.openLogs[id] = !st.openLogs[id];
      if (st.openLogs[id]) {
        delete st.logs[id];
        call('get_supply_route_log', { p_route_id: id }).then(function(res) {
          st.logs[id] = res.error ? null : (res.data || []);
          if (st.tab === 'routes') rerenderRoute(id);
        });
      }
      rerenderRoute(id);
      return;
    }

    if (act === 'show-all') { st.showAll[b.getAttribute('data-sys')] = true; render(); return; }

    if (act === 'takes') {
      var s = b.getAttribute('data-sys');
      st.openTakes[s] = !st.openTakes[s];
      if (st.openTakes[s]) {
        delete st.takes[s];
        call('get_supply_takes', { p_system_id: s }).then(function(res) {
          st.takes[s] = res.error ? null : (res.data || []);
          if (st.tab === 'stores') render();
        });
      }
      render();
      return;
    }

    if (act === 'rule-open') {
      var rk = b.getAttribute('data-k');
      st.openRule[rk] = !st.openRule[rk];
      rerenderRule(rk);
      return;
    }

    if (act === 'rule-step') {
      var sk = b.getAttribute('data-k'), f = b.getAttribute('data-f'), dir = num(b.getAttribute('data-d'));
      var sp = findPlanetRow(sk.split('|')[0], sk.split('|')[1]);
      if (!sp) return;
      var sd = draftOf(sp);
      var cur = sd[f];
      if (cur === null) { if (dir < 0) return; cur = 0; }
      // Шаг ровняет на десятки: 37 → 40 / 30
      var next = dir > 0 ? (Math.floor(cur / STEP) + 1) * STEP : (Math.ceil(cur / STEP) - 1) * STEP;
      next = Math.max(0, next);
      sd[f] = next;
      sd.dirty = true;
      var inp = b.parentNode.querySelector('input');
      if (inp) inp.value = next;
      refreshRuleLive(sk);
      return;
    }

    if (act === 'rule-save') { saveRule(b.getAttribute('data-k'), false); return; }

    if (act === 'share') {
      var tk = b.getAttribute('data-k');
      var tp = findPlanetRow(tk.split('|')[0], tk.split('|')[1]);
      if (!tp) return;
      var td = draftOf(tp);
      td.share = !td.share;
      saveRule(tk, true);
      return;
    }

    if (act === 'request') { accessCall('request_supply_access', { p_owner_user_id: b.getAttribute('data-user') }, 'Запрос отправлен — владелец получит уведомление', b); return; }
    if (act === 'grant') { accessCall('grant_supply_access', { p_grantee_user_id: b.getAttribute('data-user') }, 'Доступ к твоим складам открыт', b); return; }
    if (act === 'respond') {
      var ok = b.getAttribute('data-ok') === '1';
      accessCall('respond_supply_access', { p_grant_id: b.getAttribute('data-id'), p_accept: ok }, ok ? 'Доступ открыт' : 'Запрос отклонён', b);
      return;
    }
    if (act === 'revoke') { accessCall('revoke_supply_access', { p_grant_id: b.getAttribute('data-id') }, 'Доступ закрыт', b); return; }
  }

  function onBodyInput(e) {
    var t = e.target;
    if (!t.getAttribute) return;
    if (t.getAttribute('data-mk')) {
      // Текстовые поля пересчитываем на ввод; списки — один раз, на выбор
      if (t.tagName === 'SELECT' && e.type !== 'change') return;
      marketInput(t);
      return;
    }
    if (!t.getAttribute('data-rule-f')) return;
    var k = t.getAttribute('data-k'), f = t.getAttribute('data-rule-f');
    var p = findPlanetRow(k.split('|')[0], k.split('|')[1]);
    if (!p) return;
    var d = draftOf(p);
    var clean = String(t.value).replace(/[^0-9]/g, '');
    if (clean !== t.value) t.value = clean;
    if (f === 'max_per_day' && clean === '') d[f] = null;
    else d[f] = num(clean);
    d.dirty = true;
    refreshRuleLive(k);
  }

  // ⌖ у планеты: на галактике — навести карту; на наземной карте другой
  // планеты — перейти на её поверхность (у галактики нет адреса «покажи X»)
  function focusSystem(sys) {
    if (!sys) return;
    if (typeof focusGalaxySystem === 'function') {
      closeSupplyScreen();
      focusGalaxySystem(sys);
      return;
    }
    var here = null;
    try { here = new URLSearchParams(window.location.search).get('system'); } catch (e) { here = null; }
    closeSupplyScreen();
    if (here === sys) return;
    window.location.href = 'ground-battle.html?system=' + encodeURIComponent(sys);
  }

  function rerenderRoute(id) {
    var el = document.querySelector('#sup-body .sup-route[data-route="' + cssEsc(id) + '"]');
    var r = findRoute(id);
    if (!el || !r) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = renderRoute(r);
    el.parentNode.replaceChild(tmp.firstChild, el);
  }

  function setRouteStatus(id, status, btn) {
    if (btn) btn.disabled = true;
    call('set_supply_route_status', { p_route_id: id, p_status: status }).then(function(res) {
      if (res.error) {
        if (btn) btn.disabled = false;
        toast(errText(res.error), true);
        return;
      }
      toast(status === 'paused' ? 'Рейс на паузе' : status === 'stopped' ? 'Рейс завершён, командир свободен' : 'Рейс продолжен');
      load(['routes'], function() { updateTabCounts(); updateNavBadge(); if (st.tab === 'routes') render(); });
    });
  }

  function accessCall(fn, args, okText, btn) {
    if (btn) btn.disabled = true;
    call(fn, args).then(function(res) {
      if (res.error) {
        if (btn) btn.disabled = false;
        toast(errText(res.error), true);
        return;
      }
      toast(okText);
      load(['grants', 'partners', 'network'], function() { updateTabCounts(); updateNavBadge(); render(); });
    });
  }

  // ── Конструктор рейса ──────────────────────────────────────────────

  function newAction(op) {
    return op === 'unload'
      ? { op: 'unload', resource: '*', mode: 'all', amount: 50 }
      : { op: 'load', resource: 'ore', mode: 'all', amount: 50 };
  }

  // opts: { loop, returnHome, commanderId } — подстановки для нового рейса
  function openEditor(route, presetStops, opts) {
    opts = opts || {};
    ed = {
      routeId: route ? route.id : null,
      commanderId: route ? route.commander_id : (opts.commanderId || null),
      commanderName: route ? route.commander_name : null,
      name: route ? (route.name || '') : '',
      loop: route ? !!route.loop : (opts.loop === undefined ? true : !!opts.loop),
      returnHome: !!opts.returnHome,
      stops: route
        ? stopsOf(route).map(function(s) {
            return { system_id: s.system_id, actions: (s.actions || []).map(function(a) {
              return { op: a.op, resource: a.resource || (a.op === 'unload' ? '*' : 'ore'),
                       mode: a.mode || 'all', amount: a.amount === undefined || a.amount === null ? 50 : num(a.amount) };
            }) };
          })
        : [{ system_id: '', actions: [newAction('load')] }, { system_id: '', actions: [newAction('unload')] }],
      commanders: null,
      sending: false
    };
    if (presetStops) ed.stops = presetStops;
    // Разовый рейс «туда и обратно» хранится как лишняя последняя остановка
    // на первой планете без действий — в конструкторе это переключатель
    if (route && !ed.loop && ed.stops.length >= 3) {
      var first = ed.stops[0], last = ed.stops[ed.stops.length - 1];
      if (last.system_id && last.system_id === first.system_id && !last.actions.length) {
        ed.stops.pop();
        ed.returnHome = true;
      }
    }
    showEditor();
  }

  // «Новый рейс»: из хаба — первая остановка здесь, погрузку игрок выберет
  // сам, флот — тот, что стоит у этой планеты; без хаба — пустой бланк
  function openNewRoute() {
    if (!st.hub) { openEditor(null); return; }
    openEditor(null, [
      { system_id: st.hub.id, actions: [] },
      { system_id: '', actions: [newAction('unload')] }
    ], { loop: false });
  }

  function maxStops() {
    return (ed && !ed.loop && ed.returnHome) ? MAX_STOPS - 1 : MAX_STOPS;
  }

  // Остановка возвращения добавляется, только если рейс и так не кончается дома
  function homeStopNeeded() {
    if (!ed || ed.loop || !ed.returnHome || ed.stops.length < 2) return false;
    var first = ed.stops[0].system_id, last = ed.stops[ed.stops.length - 1].system_id;
    return !!first && last !== first;
  }

  // Из карточки сети: остановка уже выбрана, действия подставлены
  function openEditorFrom(sysId, mode) {
    var rows = (st.network || []).filter(function(r) { return r.system_id === sysId; });
    var here = { system_id: sysId, actions: [] };
    var stops;
    if (mode === 'need') {
      rows.filter(function(r) { return r.need > 0; }).slice(0, 3).forEach(function(r) {
        here.actions.push({ op: 'unload', resource: r.resource, mode: 'need', amount: r.need });
      });
      stops = [{ system_id: '', actions: [newAction('load')] }, here];
    } else {
      rows.filter(function(r) { return r.available > 0 && (r.can_take || r.is_mine); }).slice(0, 3).forEach(function(r) {
        here.actions.push({ op: 'load', resource: r.resource, mode: 'all', amount: r.available });
      });
      if (!here.actions.length) here.actions.push(newAction('load'));
      stops = [here, { system_id: '', actions: [newAction('unload')] }];
    }
    openEditor(null, stops);
  }

  function showEditor() {
    var el = document.getElementById('sup-editor');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sup-editor';
      document.body.appendChild(el);
      el.addEventListener('click', onEditorClick);
      el.addEventListener('change', onEditorChange);
      el.addEventListener('input', onEditorInput);
    }
    el.style.display = 'flex';
    el.innerHTML =
      '<div class="sup-head"><div class="sup-head-row" style="padding-bottom:16px">' +
        '<span class="sup-title">' + (ed.routeId ? 'Изменить рейс' : 'Новый рейс') + '</span>' +
        '<button type="button" class="sup-close" data-ed="close" aria-label="Закрыть">✕</button>' +
      '</div></div>' +
      '<div class="sup-ed-body" id="sup-ed-body"><div class="sup-loading">Загрузка…</div></div>' +
      '<div class="sup-ed-foot"><div class="sup-hints" id="sup-ed-hints"></div>' +
        '<button type="button" class="sup-go" id="sup-ed-go" data-ed="go" disabled>' + (ed.routeId ? 'Сохранить рейс' : 'Запустить рейс') + '</button></div>';

    var left = 3;
    function one() { if (--left === 0) renderEditor(); }
    loadSystems(one);
    if (st.network === null) load(['network'], one); else one();
    if (st.planets === null) load(['planets'], one); else one();

    if (!ed.routeId) {
      call('get_supply_commanders').then(function(res) {
        if (!ed) return;
        ed.commanders = sortByHub(res.error ? [] : (res.data || []));
        ed.cmdError = res.error ? errText(res.error) : null;
        if (!ed.commanderId) ed.commanderId = pickCommander(ed.commanders);
        if (left === 0) renderEditor();
      });
    }
  }

  // Из хаба первыми идут флоты, стоящие у этой планеты, свободные — раньше занятых
  function sortByHub(list) {
    var id = st.hub ? st.hub.id : null;
    function rank(c) { return (id && c.system_id !== id ? 2 : 0) + (c.busy ? 1 : 0); }
    return list.slice().sort(function(a, b) { return rank(a) - rank(b); });
  }

  // Из хаба показываем флоты у этой планеты (и выбранный), остальные — по кнопке
  function hubCommanders(list, selId, all) {
    if (!st.hub || all) return { shown: list, hidden: 0 };
    var id = st.hub.id;
    var shown = list.filter(function(c) { return c.system_id === id || c.commander_id === selId; });
    if (!shown.length || shown.length === list.length) return { shown: list, hidden: 0 };
    return { shown: shown, hidden: list.length - shown.length };
  }

  // Кого выбрать сразу: из хаба — готовый свободный флот у этой планеты
  // (с самым просторным трюмом); иначе — единственный свободный
  function pickCommander(list) {
    var free = (list || []).filter(function(c) { return !c.busy; });
    if (st.hub) {
      var here = free.filter(function(c) { return c.system_id === st.hub.id && c.ready; })
        .sort(function(a, b) { return num(b.free_cargo) - num(a.free_cargo); });
      if (here.length) return here[0].commander_id;
    }
    return free.length === 1 ? free[0].commander_id : null;
  }

  function closeEditor() {
    var el = document.getElementById('sup-editor');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    ed = null;
  }

  function cmdState(c) {
    if (c.busy === 'route') return { cls: '', text: 'на рейсе' };
    if (c.busy === 'convoy') return { cls: '', text: 'в конвое' };
    if (c.busy === 'moving') return { cls: '', text: 'в перелёте' };
    if (!c.ready) return { cls: 'warn', text: 'не готов' };
    return { cls: 'ok', text: 'готов' };
  }

  function selectedCommander() {
    if (!ed || !ed.commanders) return null;
    for (var i = 0; i < ed.commanders.length; i++) if (ed.commanders[i].commander_id === ed.commanderId) return ed.commanders[i];
    return null;
  }

  function netRow(sys, res) {
    var list = st.network || [];
    for (var i = 0; i < list.length; i++) if (list[i].system_id === sys && list[i].resource === res) return list[i];
    return null;
  }

  function isMyPlanet(sys) {
    return (st.planets || []).some(function(p) { return p.system_id === sys; });
  }

  // Сколько можно взять на остановке: подсказка рядом с выбором ресурса
  function availInfo(sys, res) {
    if (!sys || !res || res === '*') return null;
    if (isMyPlanet(sys)) {
      var mine = findPlanetRow(sys, res);
      return { cls: '', html: 'твой склад: <b>' + (mine ? num(mine.stock) : 0) + '</b>', n: mine ? num(mine.stock) : 0 };
    }
    var r = netRow(sys, res);
    if (r && !r.can_take && r.audience === 'trusted') return { cls: 'bad', html: 'только доверенным — запроси доступ у ' + esc(r.controller_name || 'владельца'), n: 0 };
    if (!r || !(r.available > 0) || !r.can_take) return { cls: 'warn', html: 'сейчас здесь не отдают — рейс будет ждать', n: 0 };
    return { cls: '', html: 'доступно: <b>' + r.available + '</b>', n: r.available };
  }

  function needInfo(sys, res) {
    if (!sys || !res || res === '*') return null;
    var r = netRow(sys, res);
    if (r && r.need > 0) return { cls: 'need', html: 'нужда планеты: <b>' + r.need + '</b>' };
    return null;
  }

  function resOptions(sel, withAll, sys) {
    var h = withAll ? '<option value="*"' + (sel === '*' ? ' selected' : '') + '>Всё из трюма</option>' : '';
    st.resources.forEach(function(r) {
      var tail = '';
      if (sys && !withAll) {
        var a = availInfo(sys, r.id);
        if (a && a.n > 0) tail = ' — ' + a.n;
      }
      h += '<option value="' + esc(r.id) + '"' + (sel === r.id ? ' selected' : '') + '>' + esc(r.name) + tail + '</option>';
    });
    return h;
  }

  function sysOptions(sel) {
    var h = '<option value=""' + (sel ? '' : ' selected') + ' disabled>— выбери планету —</option>';
    var have = false;
    (st.systems || []).forEach(function(s) {
      if (s.id === sel) have = true;
      h += '<option value="' + esc(s.id) + '"' + (s.id === sel ? ' selected' : '') + '>' + esc(s.name) +
        (isMyPlanet(s.id) ? ' · моя' : '') + '</option>';
    });
    // Планета могла уйти из фракции, но в рейсе она ещё есть — покажем
    if (sel && !have) h += '<option value="' + esc(sel) + '" selected>' + esc(sel) + ' · не наша</option>';
    return h;
  }

  function renderEditor() {
    if (!ed) return;
    var body = document.getElementById('sup-ed-body');
    if (!body) return;
    var keep = body.scrollTop;
    var h = '';

    // Режим: разовая доставка или кольцо — первое, что решает игрок
    h += '<div class="sup-section">Режим</div>' +
      '<div class="sup-seg sup-mode">' +
        '<button type="button" class="' + (!ed.loop ? 'on' : '') + '" data-ed="mode-loop" data-v="0"><b>→</b>Разовая доставка</button>' +
        '<button type="button" class="' + (ed.loop ? 'on' : '') + '" data-ed="mode-loop" data-v="1"><b>↻</b>По кругу</button>' +
      '</div>' +
      '<div class="sup-mode-note">' + (ed.loop
        ? 'Флот проходит остановки и возвращается к первой — снова и снова, пока не остановишь.'
        : 'Флот один раз проходит остановки по порядку, и рейс завершается.') + '</div>';
    if (!ed.loop) {
      var home = ed.stops[0] && ed.stops[0].system_id ? sysName(ed.stops[0].system_id) : 'первую остановку';
      var tooMany = !ed.returnHome && ed.stops.length >= MAX_STOPS;
      h += '<button type="button" class="sup-looprow' + (ed.returnHome ? ' on' : '') + '" data-ed="home"' + (tooMany ? ' disabled' : '') + '>' +
        '<span>Вернуться домой<i>' + (tooMany ? 'нужна свободная остановка — убери одну из шести'
          : ed.returnHome ? 'после последней остановки флот вернётся на ' + esc(home)
          : 'флот останется там, где закончит рейс') + '</i></span>' +
        '<span class="sup-toggle' + (ed.returnHome ? ' on' : '') + '"><i></i>' + (ed.returnHome ? 'да' : 'нет') + '</span></button>';
    }

    // Командир
    h += '<div class="sup-section">Командир</div>';
    if (ed.routeId) {
      h += '<div class="sup-cmd on" style="cursor:default"><span class="sup-radio"></span><div class="sup-cmd-info">' +
        '<div class="sup-cmd-name">' + esc(ed.commanderName || 'Командир') + '</div>' +
        '<div class="sup-cmd-sub">сменить нельзя — заверши рейс и создай новый</div></div></div>';
    } else if (ed.commanders === null) {
      h += '<div class="sup-loading" style="padding:12px">Загрузка…</div>';
    } else if (!ed.commanders.length) {
      h += '<div class="sup-note">' + (ed.cmdError ? esc(ed.cmdError) :
        'Нет командиров с флотом. Назначь командиру корабли в разделе «Армия» — грузовую вместимость дают транспортные корабли.') + '</div>';
    } else {
      var cv = hubCommanders(ed.commanders, ed.commanderId, ed.showAllCmds);
      h += cv.shown.map(function(c) {
        var s = cmdState(c);
        var on = c.commander_id === ed.commanderId;
        return '<button type="button" class="sup-cmd' + (on ? ' on' : '') + '" data-ed="cmd" data-id="' + esc(c.commander_id) + '"' +
          (c.busy ? ' disabled' : '') + '><span class="sup-radio"></span><div class="sup-cmd-info">' +
          '<div class="sup-cmd-name">' + esc(c.name) + '</div>' +
          '<div class="sup-cmd-sub">' + (st.hub && c.system_id === st.hub.id ? '<span class="sup-here">у хаба</span> ' : '') +
            esc(c.system_name || '—') + ' · ' + num(c.ships) + ' ' + plural(num(c.ships), 'корабль', 'корабля', 'кораблей') +
            ' · трюм ' + num(c.free_cargo) + '</div></div>' +
          '<span class="sup-cmd-state ' + s.cls + '">' + s.text + '</span></button>';
      }).join('');
      if (cv.hidden) {
        h += '<button type="button" class="sup-more" data-ed="all-cmds">флоты на других планетах · ' + cv.hidden + ' ▾</button>';
      }
    }

    // Название
    h += '<div class="sup-section">Название</div>' +
      '<input type="text" class="sup-input" data-ed="name" maxlength="40" value="' + esc(ed.name) + '" placeholder="' + esc(autoName() || 'например: Руда на Кристофсис') + '">';

    // Остановки
    var homeStop = homeStopNeeded();
    h += '<div class="sup-section">Остановки<span class="sup-count">' + (ed.stops.length + (homeStop ? 1 : 0)) + ' из ' + MAX_STOPS + '</span></div>';
    ed.stops.forEach(function(s, i) {
      if (i > 0) h += '<div class="sup-stop-link">↓<span>' + 'перелёт' + '</span></div>';
      h += renderStop(s, i);
    });
    if (ed.loop && ed.stops.length > 1) h += '<div class="sup-stop-link loop">↻<span>обратно к остановке 1</span></div>';
    if (homeStop) {
      h += '<div class="sup-stop-link">↓<span>перелёт</span></div>' +
        '<div class="sup-stop home"><div class="sup-stop-head"><span class="sup-stop-n">↩</span>' +
        '<div class="sup-home-name">' + esc(sysName(ed.stops[0].system_id)) + '<i>возвращение домой · без погрузки</i></div></div></div>';
    }

    h += '<button type="button" class="sup-add-stop" data-ed="add-stop"' + (ed.stops.length >= maxStops() ? ' disabled' : '') + '>+ Остановка</button>';

    h += '<div class="sup-note" style="margin-top:12px">Перелёт идёт через планеты своей фракции, прыжок за прыжком. ' +
      'Если флот перехватят или путь закроется, рейс встанет и придёт уведомление.' +
      (ed.loop ? ' Если за круг ничего не перевезено — флот подождёт 10 минут и попробует снова.' : '') + '</div>';

    body.innerHTML = h;
    body.scrollTop = keep;
    renderHints();
  }

  function renderStop(s, i) {
    var n = ed.stops.length;
    var h = '<div class="sup-stop" data-stop="' + i + '">' +
      '<div class="sup-stop-head"><span class="sup-stop-n">' + (i + 1) + '</span>' +
        '<select class="sup-select" data-ed="sys" data-i="' + i + '">' + sysOptions(s.system_id) + '</select>' +
        '<button type="button" class="sup-icon" data-ed="up" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="выше">↑</button>' +
        '<button type="button" class="sup-icon" data-ed="down" data-i="' + i + '"' + (i === n - 1 ? ' disabled' : '') + ' aria-label="ниже">↓</button>' +
        '<button type="button" class="sup-icon del" data-ed="del-stop" data-i="' + i + '"' + (n <= 2 ? ' disabled' : '') + ' aria-label="убрать">✕</button>' +
      '</div>';

    s.actions.forEach(function(a, j) {
      var load = a.op === 'load';
      var modes = load
        ? [['all', 'максимум'], ['amount', 'ровно']]
        : (a.resource === '*' ? [['all', 'всё'], ['need', 'по нужде']] : [['all', 'всё'], ['amount', 'ровно'], ['need', 'по нужде']]);
      var at = 'data-i="' + i + '" data-j="' + j + '"';
      h += '<div class="sup-act ' + (load ? 'load' : 'unload') + '">' +
        '<div class="sup-act-row"><div class="sup-seg op">' +
          '<button type="button" class="load' + (load ? ' on' : '') + '" data-ed="op" data-v="load" ' + at + '>Погрузить</button>' +
          '<button type="button" class="unload' + (!load ? ' on' : '') + '" data-ed="op" data-v="unload" ' + at + '>Выгрузить</button>' +
        '</div><button type="button" class="sup-icon del" data-ed="del-act" ' + at + ' aria-label="убрать действие">✕</button></div>' +
        '<div class="sup-act-row wrap"><select class="sup-select" data-ed="res" ' + at + '>' + resOptions(a.resource, !load, load ? s.system_id : null) + '</select>' +
        '<div class="sup-seg">' + modes.map(function(m) {
          return '<button type="button" class="' + (a.mode === m[0] ? 'on' : '') + '" data-ed="mode" data-v="' + m[0] + '" ' + at + '>' + m[1] + '</button>';
        }).join('') + '</div></div>';
      if (a.mode === 'amount') {
        h += '<div class="sup-act-row"><div class="sup-qty">' +
          '<button type="button" data-ed="amt" data-d="-1" ' + at + ' aria-label="меньше">−</button>' +
          '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" data-ed="amount" ' + at + ' value="' + num(a.amount) + '">' +
          '<button type="button" data-ed="amt" data-d="1" ' + at + ' aria-label="больше">+</button></div></div>';
      }
      var info = load ? availInfo(s.system_id, a.resource) : needInfo(s.system_id, a.resource);
      if (info) h += '<div class="sup-avail ' + info.cls + '">' + info.html + '</div>';
      else if (!load && a.mode === 'need') h += '<div class="sup-avail">выгрузит столько, сколько не хватает до желаемого запаса</div>';
      h += '</div>';
    });

    // Быстрая погрузка: что здесь можно взять — одним касанием в план
    var quick = quickLoads(s);
    if (quick.length) {
      h += '<div class="sup-quick"><span class="sup-label">' + (s.actions.length ? 'Ещё погрузить' : 'Погрузить отсюда') + '</span>' +
        '<div class="sup-chips">' + quick.map(function(q) {
          return '<button type="button" class="sup-chip take sup-qbtn" data-ed="quick" data-i="' + i + '" data-res="' + esc(q.id) + '">' +
            '<i style="background:' + esc(q.color) + '"></i>+ ' + esc(q.name) + ' <b>' + q.n + '</b></button>';
        }).join('') + '</div></div>';
    } else if (!s.actions.length && s.system_id) {
      h += '<div class="sup-avail warn">Здесь сейчас нечего взять — добавь действие вручную или выбери другую планету</div>';
    }

    h += '<button type="button" class="sup-add-act" data-ed="add-act" data-i="' + i + '">+ действие</button></div>';
    return h;
  }

  // Ресурсы, которые на этой остановке можно погрузить и которых ещё нет в плане
  function quickLoads(s) {
    if (!s.system_id) return [];
    // Остановка только с выгрузкой — это пункт назначения, не загромождаем
    var loads = s.actions.filter(function(a) { return a.op === 'load'; }).length;
    if (s.actions.length && !loads) return [];
    var have = {};
    s.actions.forEach(function(a) { if (a.op === 'load') have[a.resource] = 1; });
    var out = [];
    st.resources.forEach(function(r) {
      if (have[r.id]) return;
      var a = availInfo(s.system_id, r.id);
      if (a && a.n > 0) out.push({ id: r.id, name: r.name, color: r.color, n: a.n });
    });
    return out;
  }

  function autoName() {
    if (!ed) return '';
    var names = ed.stops.filter(function(s) { return s.system_id; }).map(function(s) { return sysName(s.system_id); });
    if (names.length < 2) return '';
    var n = names.join(' → ');
    return n.length > 40 ? n.slice(0, 39) + '…' : n;
  }

  function validate() {
    var errs = [], warns = [];
    if (!ed.routeId && !ed.commanderId) errs.push('Выбери командира');
    if (ed.stops.length < 2) errs.push('Нужно хотя бы 2 остановки');
    var anyLoad = false, loadTotal = 0, loadAll = false;
    ed.stops.forEach(function(s, i) {
      var n = i + 1;
      if (!s.system_id) errs.push('Остановка ' + n + ': выбери планету');
      if (!s.actions.length) {
        warns.push(i === 0 ? 'Остановка 1: выбери, что погрузить — иначе флот полетит пустым'
                           : 'Остановка ' + n + ' без действий — флот просто пролетит через неё');
      }
      var nx = ed.stops[i + 1] || (ed.loop && ed.stops.length > 2 ? ed.stops[0] : null);
      if (s.system_id && nx && nx.system_id === s.system_id) {
        errs.push('Остановки ' + n + ' и ' + (i + 1 < ed.stops.length ? n + 1 : 1) + ' — одна и та же планета');
      }
      s.actions.forEach(function(a) {
        if (a.mode === 'amount' && !(num(a.amount) > 0)) errs.push('Остановка ' + n + ': укажи количество');
        if (a.op === 'load') {
          anyLoad = true;
          if (a.mode === 'amount') loadTotal += num(a.amount); else loadAll = true;
          var info = availInfo(s.system_id, a.resource);
          if (info && info.cls === 'bad') warns.push('Остановка ' + n + ': ' + resInfo(a.resource).name.toLowerCase() + ' только для доверенных');
        }
      });
    });
    var total = 0;
    ed.stops.forEach(function(s) { total += s.actions.length; });
    if (ed.stops.length >= 2 && !total) errs.push('Добавь хотя бы одно действие: погрузить или выгрузить');
    // Пустая первая остановка уже подсказана выше — не повторяемся
    if (ed.stops.length >= 2 && total && !anyLoad && ed.stops[0].actions.length) warns.push('В рейсе нет погрузки — повезёт только то, что уже в трюме');
    var c = selectedCommander();
    if (c) {
      if (!c.ready) warns.push('Флот не в зоне прыжка — рейс встанет на первом перелёте');
      if (loadTotal > num(c.free_cargo) && !loadAll) warns.push('Погрузка больше трюма (' + num(c.free_cargo) + ') — возьмёт сколько влезет');
    }
    return { errs: errs, warns: warns };
  }

  function renderHints() {
    var box = document.getElementById('sup-ed-hints');
    var go = document.getElementById('sup-ed-go');
    if (!box || !go || !ed) return;
    var v = validate();
    var list = v.errs.slice(0, 2).map(function(t) { return '<div class="sup-hint">' + esc(t) + '</div>'; })
      .concat(v.warns.slice(0, 2).map(function(t) { return '<div class="sup-hint warn">' + esc(t) + '</div>'; }));
    if (ed.routeId && !v.errs.length) list.push('<div class="sup-hint warn">После сохранения рейс начнётся заново — с остановки 1</div>');
    if (!list.length) {
      list.push('<div class="sup-hint ok">' + (ed.loop ? 'Рейс готов: будет ходить по кругу, пока не остановишь'
        : homeStopNeeded() ? 'Рейс готов: один проход, потом флот вернётся на ' + esc(sysName(ed.stops[0].system_id))
        : 'Рейс готов: один проход по остановкам') + '</div>');
    }
    box.innerHTML = list.join('');
    go.disabled = !!v.errs.length || ed.sending;
    go.textContent = ed.sending ? 'Отправляю…' : (ed.routeId ? 'Сохранить рейс' : 'Запустить рейс');
  }

  function edAction(t) {
    var i = num(t.getAttribute('data-i')), j = num(t.getAttribute('data-j'));
    var s = ed.stops[i];
    return { stop: s, action: s && s.actions[j], i: i, j: j };
  }

  function onEditorClick(e) {
    var b = e.target.closest('[data-ed]');
    if (!b || b.disabled || !ed) return;
    var act = b.getAttribute('data-ed');
    var i = num(b.getAttribute('data-i'));

    if (act === 'close') { closeEditor(); return; }
    if (act === 'go') { submitEditor(); return; }
    if (act === 'cmd') { ed.commanderId = b.getAttribute('data-id'); renderEditor(); return; }
    if (act === 'mode-loop') {
      ed.loop = b.getAttribute('data-v') === '1';
      // «Вернуться домой» занимает место последней остановки: если их уже
      // максимум, при возврате в разовый режим возврат домой не включаем
      if (!ed.loop && ed.returnHome && ed.stops.length >= MAX_STOPS) ed.returnHome = false;
      renderEditor();
      return;
    }
    if (act === 'all-cmds') { ed.showAllCmds = true; renderEditor(); return; }
    if (act === 'home') {
      if (!ed.returnHome && ed.stops.length >= MAX_STOPS) return;
      ed.returnHome = !ed.returnHome;
      renderEditor();
      return;
    }
    if (act === 'quick') {
      var qs = ed.stops[i];
      if (!qs) return;
      qs.actions.push({ op: 'load', resource: b.getAttribute('data-res'), mode: 'all', amount: 50 });
      renderEditor();
      return;
    }

    if (act === 'add-stop') {
      if (ed.stops.length >= maxStops()) return;
      ed.stops.push({ system_id: '', actions: [newAction('unload')] });
      renderEditor();
      var body = document.getElementById('sup-ed-body');
      if (body) body.scrollTop = body.scrollHeight;
      return;
    }
    if (act === 'del-stop') { if (ed.stops.length > 2) { ed.stops.splice(i, 1); renderEditor(); } return; }
    if (act === 'up' && i > 0) { var u = ed.stops[i]; ed.stops[i] = ed.stops[i - 1]; ed.stops[i - 1] = u; renderEditor(); return; }
    if (act === 'down' && i < ed.stops.length - 1) { var d = ed.stops[i]; ed.stops[i] = ed.stops[i + 1]; ed.stops[i + 1] = d; renderEditor(); return; }

    if (act === 'add-act') {
      var s = ed.stops[i];
      if (!s) return;
      var last = s.actions[s.actions.length - 1];
      s.actions.push(newAction(last ? last.op : 'load'));
      renderEditor();
      return;
    }

    var x = edAction(b);
    if (!x.action) return;
    if (act === 'del-act') { x.stop.actions.splice(x.j, 1); renderEditor(); return; }
    if (act === 'op') {
      var op = b.getAttribute('data-v');
      if (x.action.op === op) return;
      x.action.op = op;
      if (op === 'load' && x.action.resource === '*') x.action.resource = 'ore';
      if (op === 'load' && x.action.mode === 'need') x.action.mode = 'all';
      renderEditor();
      return;
    }
    if (act === 'mode') { x.action.mode = b.getAttribute('data-v'); renderEditor(); return; }
    if (act === 'amt') {
      var cur = num(x.action.amount), dir = num(b.getAttribute('data-d'));
      var next = dir > 0 ? (Math.floor(cur / STEP) + 1) * STEP : (Math.ceil(cur / STEP) - 1) * STEP;
      x.action.amount = Math.max(STEP, next);
      var inp = b.parentNode.querySelector('input');
      if (inp) inp.value = x.action.amount;
      renderHints();
      return;
    }
  }

  function onEditorChange(e) {
    var t = e.target;
    if (!ed || !t.getAttribute) return;
    var act = t.getAttribute('data-ed');
    if (act === 'sys') { var s = ed.stops[num(t.getAttribute('data-i'))]; if (s) s.system_id = t.value; renderEditor(); return; }
    if (act === 'res') {
      var x = edAction(t);
      if (!x.action) return;
      x.action.resource = t.value;
      if (t.value === '*' && x.action.mode === 'amount') x.action.mode = 'all';
      renderEditor();
    }
  }

  function onEditorInput(e) {
    var t = e.target;
    if (!ed || !t.getAttribute) return;
    var act = t.getAttribute('data-ed');
    if (act === 'name') { ed.name = t.value; return; }
    if (act === 'amount') {
      var clean = String(t.value).replace(/[^0-9]/g, '');
      if (clean !== t.value) t.value = clean;
      var x = edAction(t);
      if (x.action) x.action.amount = num(clean);
      renderHints();
    }
  }

  function stopsPayload() {
    var out = ed.stops.map(function(s) {
      return {
        system_id: s.system_id,
        actions: s.actions.map(function(a) {
          var o = { op: a.op, resource: a.resource, mode: a.mode };
          if (a.mode === 'amount') o.amount = num(a.amount);
          return o;
        })
      };
    });
    // «Вернуться домой»: последняя остановка — первая планета, без действий
    if (homeStopNeeded()) out.push({ system_id: ed.stops[0].system_id, actions: [] });
    return out;
  }

  function submitEditor() {
    if (!ed || ed.sending) return;
    var v = validate();
    if (v.errs.length) { renderHints(); return; }
    ed.sending = true;
    renderHints();
    var name = String(ed.name || '').trim() || autoName() || 'Рейс снабжения';
    var editing = !!ed.routeId;
    var p = editing
      ? call('update_supply_route', { p_route_id: ed.routeId, p_name: name, p_stops: stopsPayload(), p_loop: ed.loop })
      : call('create_supply_route', { p_commander_id: ed.commanderId, p_name: name, p_stops: stopsPayload(), p_loop: ed.loop });
    p.then(function(res) {
      if (!ed) return;
      ed.sending = false;
      if (res.error) { renderHints(); toast(errText(res.error), true); return; }
      closeEditor();
      toast(editing ? 'Рейс обновлён — флот начинает с остановки 1' : 'Рейс запущен — флот вылетает на первую остановку');
      if (st.open) {
        st.tab = 'routes';
        markTabs();
        load(['routes'], function() { updateTabCounts(); updateNavBadge(); render(); });
      }
    });
  }

  // ── Запуск ─────────────────────────────────────────────────────────

  window.openSupplyScreen = openSupplyScreen;
  window.closeSupplyScreen = closeSupplyScreen;

  document.addEventListener('DOMContentLoaded', function() {
    var btn = document.getElementById('panel-item-supply');
    if (btn) btn.addEventListener('click', function() { openSupplyScreen(); });

    // Значок: при загрузке и раз в минуту — запросы доступа и вставшие рейсы.
    // На страницах без нижней панели (наземная карта) значка нет — и опроса тоже
    if (!document.getElementById('supply-badge')) return;
    setTimeout(refreshNavBadge, 1500);
    if (badgeTimer) clearInterval(badgeTimer);
    badgeTimer = setInterval(refreshNavBadge, 60000);
    document.addEventListener('visibilitychange', function() { if (!document.hidden) refreshNavBadge(); });
  });

})();
