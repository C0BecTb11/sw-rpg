// Панель кредитов в правом верхнем углу. Подключается на любой экран,
// где нужна — достаточно добавить этот файл, разметку она создаёт сама.
//
// Баланс приходит из get_my_profile (столбец credits закрыт от прямого
// чтения другими игроками), и обновляется по realtime — потратил на стройку
// и цифра поменялась сразу, без перезагрузки страницы.

var creditsBarUserId = null;

function renderCreditsBar(value) {
  var el = document.getElementById('credits-value');
  if (el) el.textContent = value;
}

function initCreditsBar() {
  if (document.getElementById('credits-bar')) return;

  var bar = document.createElement('div');
  bar.id = 'credits-bar';
  bar.innerHTML = '<span id="credits-icon">◈</span><span id="credits-value">—</span>';
  document.body.appendChild(bar);

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    creditsBarUserId = res.data.session.user.id;

    supabase.rpc('get_my_profile').then(function(profRes) {
      if (!profRes.error && profRes.data && profRes.data.length > 0) {
        renderCreditsBar(profRes.data[0].credits);
      }
    });

    supabase
      .channel('credits-' + creditsBarUserId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: 'id=eq.' + creditsBarUserId
      }, function(payload) {
        if (payload.new && typeof payload.new.credits !== 'undefined') {
          renderCreditsBar(payload.new.credits);
        }
      })
      .subscribe();
  });
}

document.addEventListener('DOMContentLoaded', initCreditsBar);

// ===== Серверное время =====
// Вся игра живёт по часам сервера: выдача ресурсов и кредитов — в 04:00
// по серверу, сутки поселений — от выдачи до выдачи. Часы стоят под
// кредитами, чтобы игрок сверял свой распорядок с ними, а не с телефоном.
//
// Сдвиг считаем один раз (и раз в 10 минут уточняем): дальше часы идут
// от локального времени без запросов к базе.

var svClock = {
  offset: 0,          // серверное время минус локальное, мс
  tz: 'Europe/Moscow',
  label: 'МСК',
  payoutHour: 4,
  lockHours: 4,
  nextPayout: 0,      // мс
  ready: false,
  retry: null         // таймер повторного запроса, если сеть моргнула
};

function svNow() { return Date.now() + svClock.offset; }

// Ближайшая выдача; если прошла — следующая через сутки
function svNextPayoutMs() {
  var n = svClock.nextPayout;
  if (!n) return 0;
  var now = svNow();
  while (n <= now) n += 86400000;
  return n;
}

// Часы и минуты в поясе сервера, независимо от пояса телефона
function svFormatTime(ms, withSeconds) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: svClock.tz, hour: '2-digit', minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined, hour12: false
    }).format(new Date(ms));
  } catch (e) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
}

function svLeftText(sec) {
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' ч ' + m + ' мин';
  if (m > 0) return m + ' мин';
  return sec + ' с';
}

// Когда постройка, начатая в startedMs, получит первую выдачу:
// начатое меньше чем за lockHours до выдачи ждёт следующих суток
// Как на сервере (payout_eligible): заложено строго раньше окна
// и достроено к самой выдаче
function svFirstPayoutFor(startedMs, completedMs) {
  var p = svNextPayoutMs();
  if (!p) return 0;
  for (var i = 0; i < 3; i++) {
    var lateStart = startedMs && startedMs >= p - svClock.lockHours * 3600000;
    var lateDone = completedMs && completedMs > p;
    if (!lateStart && !lateDone) break;
    p += 86400000;
  }
  return p;
}

// Календарный день в поясе сервера: «2026-10-03»
function svDayKey(ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: svClock.tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(ms));
  } catch (e) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
}

// Приставка ко времени: сегодня — ничего, завтра — «завтра », дальше — дата
function svDayWord(ms) {
  var now = svNow();
  var k = svDayKey(ms);
  if (k === svDayKey(now)) return '';
  if (k === svDayKey(now + 86400000)) return 'завтра ';
  var parts = k.split('-');
  return parts.length === 3 ? parts[2] + '.' + parts[1] + ' ' : '';
}

function svSyncClock() {
  if (typeof supabase === 'undefined') return;
  var sent = Date.now();
  supabase.rpc('get_server_clock').then(function(res) {
    if (res.error || !res.data || !res.data.length) {
      // Сеть моргнула — пробуем снова, не дожидаясь планового часа
      if (!svClock.ready && !svClock.retry) {
        svClock.retry = setTimeout(function() { svClock.retry = null; svSyncClock(); }, 15000);
      }
      return;
    }
    var r = res.data[0];
    // Половину пути запроса считаем задержкой ответа
    var mid = sent + (Date.now() - sent) / 2;
    svClock.offset = new Date(r.now_at).getTime() - mid;
    svClock.tz = r.tz || svClock.tz;
    svClock.label = r.tz_label || svClock.label;
    if (r.payout_hour !== null && r.payout_hour !== undefined) svClock.payoutHour = r.payout_hour;
    if (r.lock_hours !== null && r.lock_hours !== undefined) svClock.lockHours = r.lock_hours;
    svClock.nextPayout = new Date(r.next_payout).getTime();
    svClock.ready = true;
    svPaintClock();
  });
}

function svPaintClock() {
  var t = document.getElementById('sv-time');
  var z = document.getElementById('sv-zone');
  var p = document.getElementById('sv-payout');
  if (!t || !svClock.ready) return;
  var now = svNow();
  t.textContent = svFormatTime(now, false);
  z.textContent = svClock.label;
  var next = svNextPayoutMs();
  if (p) p.textContent = next ? 'Выдача через ' + svLeftText((next - now) / 1000) : '';
  // Меньше часа до выдачи — часы подсвечиваются
  var soon = next && next - now < 3600000;
  document.getElementById('sv-clock').classList.toggle('soon', !!soon);
}

function svToggleClockInfo() {
  var box = document.getElementById('sv-clock-info');
  if (!box) return;
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  var h = ('0' + svClock.payoutHour).slice(-2) + ':00';
  var lock = svClock.payoutHour - svClock.lockHours;
  var lockFrom = ('0' + ((lock + 24) % 24)).slice(-2) + ':00';
  box.innerHTML =
    '<b>Серверное время · ' + svClock.label + '</b>' +
    '<div id="sv-payout" class="sv-payout"></div>' +
    '<p>Ресурсы с добычи, кредиты с поселений и кантин приходят раз в сутки — в <em>' + h + '</em> по серверу.</p>' +
    (svClock.lockHours > 0
      ? '<p>Постройка, заложенная с <em>' + lockFrom + '</em> до <em>' + h + '</em> или ещё не достроенная к выдаче, в неё не попадает: первый доход — через сутки.</p>'
      : '<p>Постройка, не достроенная к выдаче, в неё не попадает: первый доход — через сутки.</p>');
  box.style.display = 'block';
  svPaintClock();
}

function initServerClock() {
  if (document.getElementById('sv-clock')) return;
  // Часы живут в той же пилюле, что и кредиты: справа вверху на каждом
  // экране уже есть место, а отдельная плашка налезала на подсказки курса
  var el = document.createElement('button');
  el.id = 'sv-clock';
  el.type = 'button';
  el.innerHTML = '<span id="sv-icon">◷</span><span id="sv-time">--:--</span><span id="sv-zone"></span>';
  el.addEventListener('click', function(e) { e.stopPropagation(); svToggleClockInfo(); });
  var bar = document.getElementById('credits-bar');
  if (bar) bar.insertBefore(el, bar.firstChild);
  else { el.classList.add('alone'); document.body.appendChild(el); }

  var info = document.createElement('div');
  info.id = 'sv-clock-info';
  info.addEventListener('click', function() { info.style.display = 'none'; });
  document.body.appendChild(info);
  // Тап мимо подсказки тоже её закрывает
  document.addEventListener('click', function(e) {
    if (info.style.display === 'block' && e.target !== el && !el.contains(e.target)) {
      info.style.display = 'none';
    }
  }, true);

  svSyncClock();
  setInterval(svSyncClock, 600000);
  setInterval(svPaintClock, 1000);
}

document.addEventListener('DOMContentLoaded', initServerClock);
