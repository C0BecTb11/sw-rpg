// Загружает профиль текущего игрока (никнейм, код доступа, фракция).
// Если профиля нет вообще — просит создать ник (старые аккаунты).
// Если профиль есть, но фракция ещё не назначена администратором —
// показывает экран ожидания с личным кодом доступа и подписывается
// на Realtime, чтобы разблокироваться само, как только фракция появится.

var currentUserId = null;

function showNicknamePrompt() {
  var prompt = document.getElementById('nickname-prompt');
  var input = document.getElementById('nickname-prompt-input');
  var saveBtn = document.getElementById('nickname-prompt-save');
  var messageEl = document.getElementById('nickname-prompt-message');

  prompt.style.display = 'flex';

  saveBtn.addEventListener('click', function() {
    var nickname = input.value.trim();
    if (!nickname) {
      messageEl.textContent = 'Введи ник';
      return;
    }

    saveBtn.disabled = true;
    messageEl.textContent = '';

    supabase.from('profiles').insert({ id: currentUserId, nickname: nickname }).select().single().then(function(res) {
      saveBtn.disabled = false;
      if (res.error) {
        messageEl.textContent = res.error.message;
        return;
      }
      prompt.style.display = 'none';
      document.getElementById('profile-nickname').textContent = nickname;
      handleFactionState(res.data);
    });
  });
}

function showWaitingScreen(accessCode) {
  var waiting = document.getElementById('faction-waiting');
  var codeEl = document.getElementById('access-code-value');
  var mapScroll = document.getElementById('map-scroll');

  codeEl.textContent = accessCode;
  waiting.style.display = 'flex';
  if (mapScroll) mapScroll.style.display = 'none';
}

function hideWaitingScreen() {
  var waiting = document.getElementById('faction-waiting');
  var mapScroll = document.getElementById('map-scroll');

  waiting.style.display = 'none';
  if (mapScroll) mapScroll.style.display = 'block';
}

// Реагирует на текущее состояние профиля: если фракции нет — показывает
// экран ожидания и слушает изменения; если есть — открывает карту как обычно.
function handleFactionState(profile) {
  if (!profile.faction) {
    showWaitingScreen(profile.access_code);
    subscribeToOwnProfile();
  } else {
    hideWaitingScreen();
  }
}

function subscribeToOwnProfile() {
  supabase
    .channel('own-profile-changes')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'profiles',
      filter: 'id=eq.' + currentUserId
    }, function(payload) {
      var updated = payload.new;
      if (updated.faction) {
        hideWaitingScreen();
      }
    })
    .subscribe();
}

function initProfileBadge() {
  var nicknameEl = document.getElementById('profile-nickname');
  if (!nicknameEl) return;

  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return; // galaxy.js уже сделает редирект на auth.html

    currentUserId = res.data.session.user.id;

    supabase.from('profiles').select('nickname, faction, access_code').eq('id', currentUserId).maybeSingle().then(function(profileRes) {
      if (profileRes.error) {
        nicknameEl.textContent = 'Игрок';
        return;
      }
      if (!profileRes.data) {
        // профиля нет вообще — просим создать ник (старый аккаунт)
        nicknameEl.textContent = 'Игрок';
        showNicknamePrompt();
        return;
      }
      nicknameEl.textContent = profileRes.data.nickname;
      handleFactionState(profileRes.data);
    });
  });
}

document.addEventListener('DOMContentLoaded', initProfileBadge);
