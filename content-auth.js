function detectUsername() {
  const link = document.querySelector('div#metanav a[data-usr]');
  if (link) {
    return link.getAttribute('data-usr') || '';
  }

  const prefs = document.querySelector('#prefs a[href*="/prefs"]');
  if (prefs) {
    const text = (prefs.textContent || '').trim();
    if (text) {
      return text;
    }
  }

  return '';
}

let lastReportedUsername = '';

function reportTracSession() {
  const username = detectUsername();
  if (!username || username === lastReportedUsername) {
    return;
  }

  lastReportedUsername = username;
  chrome.runtime.sendMessage({
    type: 'tracReady',
    username: username
  });
}

reportTracSession();

let reportTimer = null;
const observer = new MutationObserver(function () {
  if (reportTimer) {
    clearTimeout(reportTimer);
  }
  reportTimer = setTimeout(reportTracSession, 300);
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}
