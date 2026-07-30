// Подгружает partials/banner.html в элемент #banner-placeholder.
// Так HTML баннера хранится в одном файле и меняется в одном месте
// для всех страниц сайта, а не копипастится в каждую.

function loadBanner() {
  var placeholder = document.getElementById('banner-placeholder');
  if (!placeholder) return;

  fetch('partials/banner.html')
    .then(function(res) { return res.text(); })
    .then(function(html) {
      placeholder.innerHTML = html;
    })
    .catch(function() {
      // если fetch не сработал (например открыто напрямую как file://, без сервера) —
      // тихо ничего не делаем, страница остаётся рабочей просто без баннера
    });
}

document.addEventListener('DOMContentLoaded', loadBanner);
