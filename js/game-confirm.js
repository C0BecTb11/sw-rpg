// Окно «Точно?» перед стройкой и сносом. Нативный confirm на телефоне
// выглядит как системная ошибка и не умеет показать цену, поэтому
// игровое окно в стиле панелей: что строим или сносим, сколько спишется,
// сколько вернётся, и две кнопки. Тап мимо окна и Esc — отмена.
//
// gameConfirm({
//   tone:   'build' | 'danger',        // золото — стройка, красный — снос
//   kicker: 'Подтверди стройку',       // строка над названием
//   title:  'Казарма',
//   image:  '../assets/...png',        // необязательно
//   sub:    'Участок 4 · 1 мин',       // необязательно
//   rows:   [{ label: 'Спишется', items: [{ text: '1000 кр.', kind: 'credits' },
//                                         { text: 'Дюрасталь 100', color: '#8fa8c4', bad: true }] }],
//   note:   'Пояснение мелким шрифтом',
//   warn:   'Предупреждение жёлтым',
//   ok:     'Построить', cancel: 'Отмена',
//   tag:    'rep_barracks'             // необязательно: метка для подсказок обучения
// }, onOk, onCancel)

var gcState = null;   // { el, onOk, onCancel } — открытое окно

function gcEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function gameConfirmOpen() {
  return !!gcState;
}

function gcClose(ok) {
  var st = gcState;
  if (!st) return;
  gcState = null;
  document.removeEventListener('keydown', gcKey, true);
  document.body.classList.remove('gc-open');
  var el = st.el;
  el.classList.remove('open');
  // Даём доиграть затуханию, но обработчик вызываем сразу — окно уже
  // не принимает нажатий, второй раз оно не сработает
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 180);
  var fn = ok ? st.onOk : st.onCancel;
  if (typeof fn === 'function') fn();
}

function gcKey(e) {
  if (!gcState) return;
  if (e.key === 'Escape' || e.keyCode === 27) {
    e.preventDefault(); e.stopPropagation();
    gcClose(false);
  } else if (e.key === 'Enter' || e.keyCode === 13) {
    e.preventDefault(); e.stopPropagation();
    // Enter на сфокусированной «Отмене» — это отмена, а не согласие
    var a = document.activeElement;
    gcClose(!(a && a.classList && a.classList.contains('gc-cancel')));
  }
}

function gcItemHtml(it) {
  var cls = 'gc-chip' + (it.kind === 'credits' ? ' credits' : '') +
            (it.bad ? ' bad' : '') + (it.lost ? ' lost' : '');
  var style = it.color ? ' style="border-left-color:' + gcEsc(it.color) + '"' : '';
  return '<span class="' + cls + '"' + style + '>' +
    (it.kind === 'credits' ? '<i>◈</i>' : '') + gcEsc(it.text) + '</span>';
}

function gameConfirm(o, onOk, onCancel) {
  o = o || {};
  // Второе окно поверх первого не открываем: старое считаем отменённым
  if (gcState) gcClose(false);

  var tone = o.tone === 'danger' ? 'danger' : 'build';
  var el = document.createElement('div');
  el.id = 'gc-confirm';
  el.className = 'gc-' + tone;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  if (o.tag) el.setAttribute('data-tag', String(o.tag));

  var rows = (o.rows || []).filter(function(r) { return r && r.items && r.items.length; });

  el.innerHTML =
    '<div class="gc-box">' +
      '<div class="gc-kicker">' + gcEsc(o.kicker || (tone === 'danger' ? 'Подтверди снос' : 'Подтверди стройку')) + '</div>' +
      '<div class="gc-head' + (o.image ? '' : ' no-art') + '">' +
        (o.image ? '<div class="gc-art"><img src="' + gcEsc(o.image) + '" alt=""></div>' : '') +
        '<div class="gc-titles">' +
          '<div class="gc-title">' + gcEsc(o.title || '') + '</div>' +
          (o.sub ? '<div class="gc-sub">' + gcEsc(o.sub) + '</div>' : '') +
        '</div>' +
      '</div>' +
      (rows.length ? '<div class="gc-ledger">' + rows.map(function(r) {
        return '<div class="gc-line ' + (r.dir === 'in' ? 'in' : 'out') + '">' +
          '<span class="gc-lbl">' + gcEsc(r.label) + '</span>' +
          '<span class="gc-vals">' + r.items.map(gcItemHtml).join('') + '</span>' +
        '</div>';
      }).join('') + '</div>' : '') +
      (o.warn ? '<div class="gc-warn">' + gcEsc(o.warn) + '</div>' : '') +
      (o.note ? '<div class="gc-note">' + gcEsc(o.note) + '</div>' : '') +
      '<div class="gc-btns">' +
        '<button type="button" class="gc-cancel">' + gcEsc(o.cancel || 'Отмена') + '</button>' +
        '<button type="button" class="gc-ok">' + gcEsc(o.ok || (tone === 'danger' ? 'Снести' : 'Построить')) + '</button>' +
      '</div>' +
    '</div>';

  // Картинка не нашлась — убираем рамку, а не показываем битый значок
  var img = el.querySelector('.gc-art img');
  if (img) img.onerror = function() {
    var art = el.querySelector('.gc-art');
    if (art && art.parentNode) art.parentNode.removeChild(art);
    var head = el.querySelector('.gc-head');
    if (head) head.classList.add('no-art');
  };

  el.addEventListener('click', function(e) {
    if (e.target === el) { gcClose(false); return; }
    var t = e.target;
    while (t && t !== el) {
      if (t.classList && t.classList.contains('gc-ok')) { gcClose(true); return; }
      if (t.classList && t.classList.contains('gc-cancel')) { gcClose(false); return; }
      t = t.parentNode;
    }
  });
  // Касания не должны проваливаться на карту под окном
  ['touchstart', 'touchmove', 'wheel', 'pointerdown'].forEach(function(ev) {
    el.addEventListener(ev, function(e) { e.stopPropagation(); }, { passive: true });
  });

  document.body.appendChild(el);
  gcState = { el: el, onOk: onOk, onCancel: onCancel };
  document.addEventListener('keydown', gcKey, true);
  // Подсказка обучения поднимается над окном, пока оно открыто
  document.body.classList.add('gc-open');

  // Класс со следующего кадра — иначе браузер не проиграет появление
  void el.offsetWidth;
  el.classList.add('open');
  return el;
}
