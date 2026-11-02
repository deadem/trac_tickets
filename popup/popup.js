let sessionChecking = false;

const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

function decodeHtmlEntities(text) {
  return (text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (match, entity) {
    if (entity.charAt(0) === '#') {
      const code = entity.charAt(1).toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      if (!isFinite(code) || code < 0 || code > 0x10FFFF) {
        return match;
      }
      try {
        return String.fromCodePoint(code);
      } catch (err) {
        return match;
      }
    }

    const named = HTML_ENTITIES[entity.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function formatTime(timestamp) {
  if (!timestamp) {
    return 'никогда';
  }

  const date = new Date(timestamp);
  const now = new Date();
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const time = date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  });

  if (dateDay.getTime() === today.getTime()) {
    return 'сегодня в ' + time;
  }
  if (dateDay.getTime() === yesterday.getTime()) {
    return 'вчера в ' + time;
  }

  const dateStr = date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  return dateStr + ' в ' + time;
}

function isAuthError(message) {
  const text = message || '';
  return text.indexOf('401') !== -1 ||
    text.indexOf('403') !== -1 ||
    /нужно войти/i.test(text) ||
    /откройте trac/i.test(text) ||
    /authorization required/i.test(text);
}

function needsAuthScreen(data) {
  return !data.username || !!data.pendingAuthRetry || isAuthError(data.error);
}

function setChecking(checking) {
  document.body.classList.toggle('popup--checking', checking);
}

function setAuthScreen(data) {
  const show = needsAuthScreen(data);
  document.body.classList.toggle('popup--auth-required', show);

  if (!show) {
    return;
  }

  const authText = document.getElementById('auth-text');
  if (!data.username) {
    authText.textContent = 'Откройте Trac в браузере, чтобы расширение определило ваш логин и загрузило список тикетов.';
  } else {
    authText.textContent = 'Войдите в Trac в браузере. После авторизации список тикетов загрузится автоматически.';
  }
}

function setStatus(text) {
  const node = document.getElementById('status');
  node.textContent = text;
  node.className = 'popup__status';
  if (text) {
    node.classList.add('popup__status--visible', 'popup__status--error');
  }
}

function setLoading(loading) {
  const listWrap = document.getElementById('list-wrap');
  const empty = document.getElementById('empty');
  listWrap.classList.toggle('popup__list-wrap--visible', loading);
  listWrap.classList.toggle('popup__list-wrap--loading', loading);
  if (loading) {
    empty.classList.remove('popup__empty--visible');
  }
}

function setTitle(count) {
  document.getElementById('title').textContent = 'Тикеты на проверку (' + count + ')';
}

function render(data) {
  setAuthScreen(data);

  if (needsAuthScreen(data)) {
    setStatus('');
    return;
  }

  const meta = document.getElementById('meta');
  const user = document.getElementById('user');
  const list = document.getElementById('tickets');
  const listWrap = document.getElementById('list-wrap');
  const empty = document.getElementById('empty');
  const openQuery = document.getElementById('open-query');
  const autoRefresh = document.getElementById('auto-refresh');
  const tickets = data.tickets || [];

  autoRefresh.checked = data.autoRefreshEnabled !== false;
  user.textContent = data.username;
  user.classList.remove('popup__user--hidden');
  meta.textContent = 'Обновлено ' + formatTime(data.lastUpdated);
  openQuery.href = 'https://trac.consultant.ru/query?' + [
    'status=' + encodeURIComponent('для проверки'),
    'custom_field_order2=~' + encodeURIComponent(data.username),
    'or',
    'custom_field_order2=',
    'reporter=~' + encodeURIComponent(data.username),
    'status=' + encodeURIComponent('для проверки'),
    'CP_vrfstatus=',
    'CP_vrfstatus_not='
  ].join('&');
  openQuery.classList.remove('popup__button--hidden');

  list.innerHTML = '';
  tickets.forEach(function (ticket) {
    const item = document.createElement('a');
    item.className = 'popup__ticket';
    item.href = ticket.url;
    item.target = '_blank';
    item.rel = 'noopener';

    const id = document.createElement('span');
    id.className = 'popup__ticket-id';
    id.textContent = '#' + ticket.id;

    const summary = document.createElement('span');
    summary.className = 'popup__ticket-summary';
    summary.textContent = decodeHtmlEntities(ticket.summary) || 'Без названия';

    item.appendChild(id);
    item.appendChild(summary);
    list.appendChild(item);
  });

  const hasTickets = tickets.length > 0;
  listWrap.classList.remove('popup__list-wrap--loading');
  listWrap.classList.toggle('popup__list-wrap--visible', hasTickets);
  empty.classList.toggle('popup__empty--visible', !hasTickets);

  setTitle(tickets.length);
  setStatus(data.error || '');
}

function loadState() {
  if (sessionChecking) {
    return;
  }
  chrome.runtime.sendMessage({ type: 'getTickets' }, render);
}

document.getElementById('refresh').addEventListener('click', function () {
  const button = document.getElementById('refresh');
  let refreshTimeout = null;

  function finishRefresh(errorText) {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
      refreshTimeout = null;
    }
    button.disabled = false;
    chrome.runtime.sendMessage({ type: 'getTickets' }, function (state) {
      render(state);
      if (errorText) {
        setStatus(errorText);
      }
    });
  }

  button.disabled = true;
  setLoading(true);

  refreshTimeout = setTimeout(function () {
    finishRefresh('Превышено время ожидания ответа Trac');
  }, 45000);

  chrome.runtime.sendMessage({ type: 'refreshTickets' }, function () {
    if (chrome.runtime.lastError) {
      finishRefresh('Не удалось связаться с расширением');
      return;
    }
    finishRefresh();
  });
});

function initPopup() {
  chrome.runtime.sendMessage({ type: 'getPopupInit' }, function (init) {
    if (chrome.runtime.lastError || (init && init.sessionAuthChecked)) {
      loadState();
      return;
    }

    sessionChecking = true;
    setChecking(true);

    const checkTimeout = setTimeout(function () {
      sessionChecking = false;
      setChecking(false);
      loadState();
    }, 15000);

    chrome.runtime.sendMessage({ type: 'checkSession' }, function () {
      clearTimeout(checkTimeout);
      sessionChecking = false;
      setChecking(false);
      loadState();
    });
  });
}

document.getElementById('auto-refresh').addEventListener('change', function (event) {
  chrome.runtime.sendMessage({
    type: 'setAutoRefresh',
    enabled: event.target.checked
  });
});

initPopup();

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || sessionChecking) {
    return;
  }
  if (changes.tickets || changes.error || changes.lastUpdated || changes.pendingAuthRetry) {
    loadState();
  }
});
