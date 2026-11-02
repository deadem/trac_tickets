const TRAC_BASE = 'https://trac.consultant.ru';
const VERIFY_STATUS = 'для проверки';
const REFRESH_ALARM = 'refreshVerifyTickets';
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const REFRESH_CHECK_MINUTES = 60;
let sessionAuthChecked = false;

function markSessionAuthChecked() {
  sessionAuthChecked = true;
}

function buildVerifyQueryUrl(username) {
  const status = encodeURIComponent(VERIFY_STATUS);
  const user = encodeURIComponent(username);
  const params = [
    'status=' + status,
    'custom_field_order2=~' + user,
    'or',
    'custom_field_order2=',
    'reporter=~' + user,
    'status=' + status,
    'CP_vrfstatus=',
    'CP_vrfstatus_not='
  ];
  return TRAC_BASE + '/query?' + params.join('&');
}

function isAuthError(message) {
  const text = message || '';
  return text.indexOf('401') !== -1 ||
    text.indexOf('403') !== -1 ||
    /нужно войти/i.test(text) ||
    /authorization required/i.test(text);
}

function isLoginPage(html) {
  return /Authorization Required|login_form|name="password"/i.test(html);
}

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

function stripHtml(text) {
  return decodeHtmlEntities((text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function getRowCellHtml(rowHtml, headerPart) {
  const classCell = rowHtml.match(new RegExp('<td[^>]*class="[^"]*\\b' + headerPart + '\\b[^"]*"[^>]*>[\\s\\S]*?<\\/td>', 'i'));
  if (classCell) {
    return classCell[0];
  }

  const cells = rowHtml.match(/<td[\s\S]*?<\/td>/gi) || [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const headersMatch = cell.match(/headers="([^"]*)"/i);
    if (headersMatch && headersMatch[1].indexOf(headerPart) !== -1) {
      return cell;
    }
  }

  return '';
}

function getTicketsTableBody(html) {
  const tableMatch = html.match(/<table[^>]*class="[^"]*\btickets\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i) ||
    html.match(/<table[^>]*class="[^"]*\blisting\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i) ||
    html.match(/<table[^>]*id="ticketlist"[^>]*>([\s\S]*?)<\/table>/i);

  if (!tableMatch) {
    return null;
  }

  const tableInner = tableMatch[1];
  const bodies = [];
  const tbodyRegex = /<tbody[^>]*>([\s\S]*?)<\/tbody>/gi;
  let tbodyMatch;

  while ((tbodyMatch = tbodyRegex.exec(tableInner)) !== null) {
    bodies.push(tbodyMatch[1]);
  }

  return bodies.length ? bodies.join('\n') : tableInner;
}

function getRowStatusFromHtml(rowHtml) {
  return stripHtml(getRowCellHtml(rowHtml, 'status'));
}

function parseTicketsFromHtml(html) {
  const tbodyHtml = getTicketsTableBody(html);
  if (!tbodyHtml) {
    return [];
  }

  const tickets = [];
  const seen = {};
  const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tbodyHtml)) !== null) {
    const rowHtml = rowMatch[0];
    const status = getRowStatusFromHtml(rowHtml).toLowerCase();
    if (status && status !== VERIFY_STATUS) {
      continue;
    }

    const idMatch = rowHtml.match(/<td[^>]*class="[^"]*\bid\b[^"]*"[^>]*>[\s\S]*?<a[^>]*href="[^"]*\/ticket\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      rowHtml.match(/<a[^>]*href="[^"]*\/ticket\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!idMatch || seen[idMatch[1]]) {
      continue;
    }

    seen[idMatch[1]] = true;
    const summaryMatch = rowHtml.match(/<td[^>]*class="[^"]*\bsummary\b[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    tickets.push({
      id: idMatch[1],
      summary: stripHtml(summaryMatch ? summaryMatch[1] : idMatch[2]),
      url: TRAC_BASE + '/ticket/' + idMatch[1]
    });
  }

  return tickets;
}

function isPendingVerificationForUser(html, username) {
  if (!/id="ticket_head_verify"/.test(html)) {
    return true;
  }

  const verifyIndex = html.indexOf('id="ticket_head_verify"');
  const block = html.slice(verifyIndex, verifyIndex + 50000);
  const rowRegex = /<tr[^>]*class="[^"]*\bintermediate\b[^"]*"[\s\S]*?<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(block)) !== null) {
    const row = rowMatch[0];
    const userMatch = row.match(/<td[^>]*class="[^"]*\buser\b[^"]*"[^>]*>[\s\S]*?data-usr="([^"]+)"/i);
    if (!userMatch || userMatch[1] !== username) {
      continue;
    }
    return /<td[^>]*class="[^"]*\bbranch\b[^"]*"[^>]*>[\s\S]*?class="[^"]*\bresult\b[^"]*\bwait\b[^"]*"/i.test(row);
  }

  return false;
}

function filterTicketsPendingVerify(tickets, username) {
  if (!username || !tickets.length) {
    return Promise.resolve(tickets);
  }

  return Promise.all(tickets.map(function (ticket) {
    return fetch(ticket.url, {
      credentials: 'include',
      cache: 'no-cache'
    }).then(function (response) {
      if (!response.ok) {
        return null;
      }
      return response.text();
    }).then(function (html) {
      if (typeof html !== 'string') {
        return html;
      }
      return isPendingVerificationForUser(html, username) ? ticket : null;
    }).catch(function () {
      return null;
    });
  })).then(function (results) {
    return results.filter(Boolean);
  });
}

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d32f2f' });
  chrome.action.setTitle({
    title: count > 0
      ? 'Тикетов на проверку: ' + count
      : 'Нет тикетов на проверку'
  });
}

function saveState(data, callback) {
  chrome.storage.local.set(data, callback);
}

function saveTicketsSuccess(username, tickets, callback) {
  saveState({
    username: username,
    tickets: tickets,
    lastUpdated: Date.now(),
    error: '',
    pendingAuthRetry: false
  }, function () {
    updateBadge(tickets.length);
    markSessionAuthChecked();
    if (callback) {
      callback({ tickets: tickets, error: '' });
    }
  });
}

function saveAuthError(username, message, callback) {
  const errorText = 'Нужно войти в Trac в браузере';

  chrome.storage.local.get(['lastUpdated', 'tickets'], function (stored) {
    const cachedTickets = stored.tickets || [];
    saveState({
      username: username,
      tickets: cachedTickets,
      lastUpdated: stored.lastUpdated || 0,
      error: errorText,
      pendingAuthRetry: true
    }, function () {
      updateBadge(cachedTickets.length);
      markSessionAuthChecked();
      if (callback) {
        callback({ tickets: cachedTickets, error: errorText });
      }
    });
  });
}

function probeSessionBackground(username, callback) {
  fetch(buildVerifyQueryUrl(username), {
    credentials: 'include',
    cache: 'no-cache'
  }).then(function (response) {
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Нужно войти в Trac в браузере');
      }
      throw new Error('HTTP ' + response.status);
    }
    return response.text();
  }).then(function (html) {
    if (isLoginPage(html)) {
      throw new Error('Нужно войти в Trac в браузере');
    }
    callback(true);
  }).catch(function (err) {
    callback(false, err && err.message ? err.message : String(err));
  });
}

function clearAuthError(callback) {
  chrome.storage.local.get(['error', 'pendingAuthRetry'], function (data) {
    if (!isAuthError(data.error) && !data.pendingAuthRetry) {
      callback();
      return;
    }

    saveState({
      error: '',
      pendingAuthRetry: false
    }, callback);
  });
}

function checkSession(username, sendResponse) {
  function finish(result) {
    markSessionAuthChecked();
    sendResponse(result);
  }

  if (!username) {
    finish({ ok: false, needsAuth: true });
    return;
  }

  probeSessionBackground(username, function (ok, err) {
    if (ok) {
      clearAuthError(function () {
        finish({ ok: true });
      });
      return;
    }

    if (isAuthError(err)) {
      saveAuthError(username, err, function (result) {
        finish({ ok: false, needsAuth: true, error: result.error });
      });
      return;
    }

    finish({ ok: false, error: err });
  });
}

function refreshTickets(username, callback) {
  if (!username) {
    saveState({
      username: '',
      tickets: [],
      lastUpdated: Date.now(),
      error: 'Откройте Trac, чтобы расширение узнало ваш логин'
    }, function () {
      updateBadge(0);
      if (callback) {
        callback({ tickets: [], error: 'Откройте Trac, чтобы расширение узнало ваш логин' });
      }
    });
    return;
  }

  fetch(buildVerifyQueryUrl(username), {
    credentials: 'include',
    cache: 'no-cache'
  }).then(function (response) {
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Нужно войти в Trac в браузере');
      }
      throw new Error('HTTP ' + response.status);
    }
    return response.text();
  }).then(function (html) {
    if (isLoginPage(html)) {
      throw new Error('Нужно войти в Trac в браузере');
    }

    const tickets = parseTicketsFromHtml(html);
    return filterTicketsPendingVerify(tickets, username);
  }).then(function (tickets) {
    saveTicketsSuccess(username, tickets, callback);
  }).catch(function (err) {
    const message = err && err.message ? err.message : String(err);

    if (!isAuthError(message)) {
      saveState({
        username: username,
        tickets: [],
        lastUpdated: Date.now(),
        error: message,
        pendingAuthRetry: false
      }, function () {
        updateBadge(0);
        if (callback) {
          callback({ tickets: [], error: message });
        }
      });
      return;
    }

    saveAuthError(username, message, callback);
  });
}

function shouldAutoRefresh(lastUpdated) {
  return !lastUpdated || (Date.now() - lastUpdated >= REFRESH_INTERVAL_MS);
}

function restoreBadgeFromStorage() {
  chrome.storage.local.get(['tickets'], function (data) {
    updateBadge((data.tickets || []).length);
  });
}

function maybeAutoRefresh(username) {
  chrome.storage.local.get(['autoRefreshEnabled', 'lastUpdated'], function (data) {
    if (data.autoRefreshEnabled === false) {
      restoreBadgeFromStorage();
      return;
    }
    if (!username) {
      restoreBadgeFromStorage();
      return;
    }
    if (shouldAutoRefresh(data.lastUpdated)) {
      refreshTickets(username, null);
    } else {
      restoreBadgeFromStorage();
    }
  });
}

function scheduleRefresh() {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_CHECK_MINUTES });
}

function updateAlarmState(enabled) {
  if (enabled) {
    scheduleRefresh();
  } else {
    chrome.alarms.clear(REFRESH_ALARM);
  }
}

function initExtension() {
  chrome.storage.local.get(['autoRefreshEnabled', 'username'], function (data) {
    const autoRefresh = data.autoRefreshEnabled !== false;
    if (data.autoRefreshEnabled === undefined) {
      chrome.storage.local.set({ autoRefreshEnabled: true });
    }
    updateAlarmState(autoRefresh);
    maybeAutoRefresh(data.username || '');
  });
}

chrome.runtime.onInstalled.addListener(initExtension);

chrome.runtime.onStartup.addListener(function () {
  sessionAuthChecked = false;
  initExtension();
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === REFRESH_ALARM) {
    chrome.storage.local.get(['username'], function (data) {
      maybeAutoRefresh(data.username || '');
    });
  }
});

function handleTracSession(username, sendResponse) {
  chrome.storage.local.get([
    'username', 'lastUpdated', 'autoRefreshEnabled', 'pendingAuthRetry', 'error'
  ], function (data) {
    const changed = data.username !== username;
    const canAutoRefresh = data.autoRefreshEnabled !== false;
    const needsAuthRetry = !!data.pendingAuthRetry || isAuthError(data.error);
    const shouldRefresh = canAutoRefresh && (
      changed || shouldAutoRefresh(data.lastUpdated) || needsAuthRetry
    );

    function finish() {
      if (shouldRefresh) {
        refreshTickets(username, sendResponse);
      } else if (sendResponse) {
        sendResponse({ ok: true });
      }
    }

    if (changed) {
      chrome.storage.local.set({ username: username }, finish);
    } else {
      finish();
    }
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'tracReady' && message.username) {
    handleTracSession(message.username, sendResponse);
    return true;
  }

  if (message.type === 'getPopupInit') {
    sendResponse({ sessionAuthChecked: sessionAuthChecked });
    return true;
  }

  if (message.type === 'checkSession') {
    chrome.storage.local.get(['username'], function (data) {
      checkSession(data.username || '', sendResponse);
    });
    return true;
  }

  if (message.type === 'setAutoRefresh') {
    const enabled = !!message.enabled;
    chrome.storage.local.set({ autoRefreshEnabled: enabled }, function () {
      updateAlarmState(enabled);
      sendResponse({ autoRefreshEnabled: enabled });
    });
    return true;
  }

  if (message.type === 'getTickets') {
    chrome.storage.local.get([
      'username', 'tickets', 'lastUpdated', 'error', 'autoRefreshEnabled', 'pendingAuthRetry'
    ], function (data) {
      sendResponse({
        username: data.username || '',
        tickets: data.tickets || [],
        lastUpdated: data.lastUpdated || 0,
        error: data.error || '',
        autoRefreshEnabled: data.autoRefreshEnabled !== false,
        pendingAuthRetry: !!data.pendingAuthRetry
      });
    });
    return true;
  }

  if (message.type === 'refreshTickets') {
    chrome.storage.local.get(['username'], function (data) {
      refreshTickets(data.username || '', sendResponse);
    });
    return true;
  }
});
