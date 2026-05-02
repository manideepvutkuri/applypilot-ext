// ============================================================
// ApplyPilot Extension — Popup Script
// ============================================================

const API_BASE = 'applypilot-ext-production.up.railway.app';
// For local testing:
//  const API_BASE = 'applypilot-ext-production.up.railway.app';

const WEBSITE = 'applypilot-ext-production.up.railway.app';

// ── DOM refs ──────────────────────────────────────────────────
const stateLogin = document.getElementById('state-login');
const stateMain  = document.getElementById('state-main');
const inpEmail   = document.getElementById('inp-email');
const inpPass    = document.getElementById('inp-pass');
const btnLogin   = document.getElementById('btn-login');
const btnReg     = document.getElementById('btn-register');
const loginErr   = document.getElementById('login-err');
const btnSignout = document.getElementById('btn-signout');
const btnStart   = document.getElementById('btn-start');
const btnPause   = document.getElementById('btn-pause');
const btnStop    = document.getElementById('btn-stop');
const openDash   = document.getElementById('open-dash');
const logWrap    = document.getElementById('log-wrap');
const naukriWarn = document.getElementById('naukri-warn');

// ── Init ──────────────────────────────────────────────────────
window.onload = async () => {
  const stored = await chrome.storage.local.get(['token', 'user']);

  if (stored.token && stored.user) {
    showMain(stored.user);
    loadStatus();
  } else {
    showLogin();
  }
};

// ── Login ─────────────────────────────────────────────────────
btnLogin.onclick = async () => {
  const email = inpEmail.value.trim();
  const pass  = inpPass.value;
  loginErr.classList.remove('show');

  if (!email || !pass) {
    showErr('Please enter email and password');
    return;
  }

  btnLogin.textContent = 'Signing in...';
  btnLogin.disabled = true;

  try {
    const res  = await fetch("https://applypilot-ext-production.up.railway.app/api/login", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });
    const data = await res.json();

    if (data.error) {
      showErr(data.error);
      btnLogin.textContent = 'Sign In →';
      btnLogin.disabled = false;
      return;
    }

    // Save token and user
    await chrome.storage.local.set({
      token: data.token,
      user:  data.user,
    });

    // Also save config for content.js
    await chrome.storage.local.set({ userConfig: data.user });

    showMain(data.user);
    loadStatus();

  } catch (err) {
    showErr('Cannot reach server. Check your internet connection.');
    btnLogin.textContent = 'Sign In →';
    btnLogin.disabled = false;
  }
};

// Enter key to login
inpPass.onkeydown = (e) => { if (e.key === 'Enter') btnLogin.click(); };

// Register — open website
 btnReg.onclick = () => chrome.tabs.create({ url: `${WEBSITE}/#register` });
//btnReg.onclick = () => window.open(`${WEBSITE}/#register`, '_blank');

// Sign out
btnSignout.onclick = async () => {
  // Stop bot first
  chrome.runtime.sendMessage({ type: 'STOP_BOT' });
  await chrome.storage.local.remove(['token', 'user', 'userConfig', 'pendingJobs', 'pendingIndex']);
  showLogin();
};

// Open dashboard
openDash.onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: WEBSITE });
};

// ── Bot controls ──────────────────────────────────────────────
btnStart.onclick = async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Starting...';
  addLog('info', 'Starting bot...');

  const res = await chrome.runtime.sendMessage({ type: 'START_BOT' });

  if (res.error) {
    addLog('err', res.error);
    btnStart.disabled = false;
    btnStart.textContent = '▶ Start';
    return;
  }

  addLog('ok', res.message || 'Bot started!');
  setBotUI('running');
};

btnPause.onclick = async () => {
  const res = await chrome.runtime.sendMessage({ type: 'PAUSE_BOT' });
  setBotUI(res.paused ? 'paused' : 'running');
  addLog(res.paused ? 'warn' : 'ok', res.paused ? 'Bot paused.' : 'Bot resumed.');
};

btnStop.onclick = async () => {
  chrome.runtime.sendMessage({ type: 'STOP_BOT' });
  setBotUI('stopped');
  addLog('warn', 'Bot stopped.');
};

// ── Load status from background ───────────────────────────────
async function loadStatus() {
  // Check if user is logged into Naukri
  checkNaukriLogin();

  // Get bot status
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (status) {
    updateStats(status.appliedToday, status.dailyLimit);
    if (status.running) setBotUI(status.paused ? 'paused' : 'running');
  }

  // Also load total from API
  const stored = await chrome.storage.local.get('token');
  if (!stored.token) return;

  try {
    const res  = await fetch(`${API_BASE}/status`, {
      headers: { Authorization: `Bearer ${stored.token}` }
    });
    const data = await res.json();
    if (data.totalApplied) {
      document.getElementById('s-total').textContent = data.totalApplied;
    }
    if (data.todayCount !== undefined) {
      updateStats(data.todayCount, data.dailyLimit);
    }
    // Show recent logs
    if (data.logs?.length) {
      data.logs.slice(-5).forEach(l => addLog(l.type, l.text, true));
    }
  } catch {}
}

async function checkNaukriLogin() {
  // Check if user has an active Naukri session
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.naukri.com/*' });
    // If no Naukri tab, show warning
    if (!tabs.length) {
      naukriWarn.classList.add('show');
    }
  } catch {
    naukriWarn.classList.add('show');
  }
}

// ── Listen for updates from background ───────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') {
    const d = msg.data;
    updateStats(d.appliedToday, d.dailyLimit);
    setBotUI(d.running ? (d.paused ? 'paused' : 'running') : 'idle');
  }
});

// ── UI Helpers ────────────────────────────────────────────────
function showLogin() {
  stateLogin.style.display = 'block';
  stateMain.style.display  = 'none';
}

function showMain(user) {
  stateLogin.style.display = 'none';
  stateMain.style.display  = 'block';

  document.getElementById('av').textContent    = (user.name || 'U').charAt(0).toUpperCase();
  document.getElementById('uname').textContent  = user.name || 'User';
  document.getElementById('uemail').textContent = user.email || '';
  document.getElementById('plan-badge').textContent =
    user.plan === 'pro' ? '⚡ Pro Plan' :
    user.plan === 'elite' ? '🔥 Elite' : 'Free Plan';
  document.getElementById('s-limit').textContent = user.dailyLimit || 20;
  openDash.href = WEBSITE;
}

function showErr(msg) {
  loginErr.textContent = msg;
  loginErr.classList.add('show');
}

function updateStats(applied, limit) {
  document.getElementById('s-applied').textContent = applied || 0;
  document.getElementById('s-limit').textContent   = limit   || 20;
  const pct = limit ? Math.round((applied / limit) * 100) : 0;
  document.getElementById('prog-fill').style.width = Math.min(pct, 100) + '%';
  document.getElementById('prog-pct').textContent  = pct + '%';
  document.getElementById('prog-label').textContent = applied
    ? `Applied ${applied} of ${limit} today`
    : 'Ready to start';
}

function setBotUI(status) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  dot.className = 'status-dot ' + status;

  const states = {
    running:   { text: 'Bot is running — applying jobs...', start: true,  pause: false, stop: false },
    paused:    { text: 'Bot is paused',                     start: true,  pause: false, stop: false },
    stopped:   { text: 'Bot stopped',                       start: false, pause: true,  stop: true  },
    idle:      { text: 'Bot is idle — click Start',         start: false, pause: true,  stop: true  },
    completed: { text: '✅ Done for today!',                 start: false, pause: true,  stop: true  },
    error:     { text: '❌ Bot error — check logs',          start: false, pause: true,  stop: true  },
  };

  const s = states[status] || states.idle;
  text.textContent  = s.text;
  btnStart.disabled = s.start;
  btnPause.disabled = s.pause;
  btnStop.disabled  = s.stop;
  btnStart.textContent = status === 'paused' ? '▶ Resume' : '▶ Start';
}

function addLog(type, text, prepend = false) {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const time = new Date().toTimeString().slice(0, 8);
  line.textContent = `${time} ${text}`;
  if (prepend) {
    logWrap.insertBefore(line, logWrap.firstChild);
  } else {
    logWrap.appendChild(line);
  }
  logWrap.scrollTop = logWrap.scrollHeight;

  // Keep only last 50 lines
  while (logWrap.children.length > 50) logWrap.removeChild(logWrap.firstChild);
}
