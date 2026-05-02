// ============================================================
// ApplyPilot Extension — Background Service Worker
// Manages the bot loop, opens tabs, coordinates with content.js
// Talks to your backend API to get user config + save results
// ============================================================

// ── Config — change to your live URL when deployed ───────────
const API_BASE = 'applypilot-ext-production.up.railway.app';
// For local testing: 
// const API_BASE = 'http://localhost:3000/api';

// ── State ─────────────────────────────────────────────────────
let botRunning   = false;
let botPaused    = false;
let currentTabId = null;
let appliedToday = 0;
let userConfig   = null;
let jobQueue     = [];
let currentJobIndex = 0;

// ============================================================
// MESSAGES FROM POPUP
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_BOT') {
    startBot().then(r => sendResponse(r));
    return true; // async response
  }

  if (msg.type === 'PAUSE_BOT') {
    botPaused = !botPaused;
    sendResponse({ paused: botPaused });
    notifyPopup();
    return true;
  }

  if (msg.type === 'STOP_BOT') {
    stopBot();
    sendResponse({ stopped: true });
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      running:      botRunning,
      paused:       botPaused,
      appliedToday,
      dailyLimit:   userConfig?.dailyLimit || 20,
      currentJob:   jobQueue[currentJobIndex]?.title || null,
    });
    return true;
  }

  // Message from content.js — job applied
  if (msg.type === 'JOB_APPLIED') {
    handleJobApplied(msg.data);
    sendResponse({ ok: true });
    return true;
  }

  // Message from content.js — move to next job
  if (msg.type === 'NEXT_JOB') {
    currentJobIndex++;
    processNextJob();
    sendResponse({ ok: true });
    return true;
  }

  // Message from content.js — job skipped
  if (msg.type === 'JOB_SKIPPED') {
    logToAPI('info', `Skipped: ${msg.reason}`);
    currentJobIndex++;
    processNextJob();
    sendResponse({ ok: true });
    return true;
  }
});

// ============================================================
// START BOT
// ============================================================
async function startBot() {
  if (botRunning) return { error: 'Bot already running' };

  try {
    // 1. Load config from Chrome storage
    const stored = await chrome.storage.local.get(['token', 'config']);
    if (!stored.token) return { error: 'Not logged in. Please login on applypilot.in first.' };

    // 2. Fetch fresh config from API
    const res = await fetch('https://applypilot-ext-production.up.railway.app/me', {
      headers: { Authorization: `Bearer ${stored.token}` }
    });
    const data = await res.json();
    if (data.error) return { error: 'Session expired. Login again on applypilot.in' };

    userConfig = {
      token:        stored.token,
      userId:       data.user.userId,
      name:         data.user.name,
      jobTitles:    data.user.jobTitles   || ['QA Automation Engineer'],
      locations:    data.user.locations   || ['Hyderabad'],
      dailyLimit:   data.user.dailyLimit  || 20,
      plan:         data.user.plan        || 'free',
      skillExp:     data.user.skillExp    || {},
      currentCTC:   data.user.currentCTC  || 6,
      expectedCTC:  data.user.expectedCTC || 9,
      noticePeriod: data.user.noticePeriod || 30,
      workMode:     data.user.workMode    || 'any',
      totalExpYears: data.user.totalExpYears || 2,
      skills:       data.user.skills || 'Selenium, TestNG, Java, Python, API Testing',
      phone:        data.user.phone || '',
      age:          data.user.age   || 26,
    };

    // 3. Check today's count from API
    const statusRes = await fetch(`${API_BASE}/status`, {
      headers: { Authorization: `Bearer ${userConfig.token}` }
    });
    const statusData = await statusRes.json();
    appliedToday = statusData.todayCount || 0;

    if (appliedToday >= userConfig.dailyLimit) {
      return { error: `Daily limit of ${userConfig.dailyLimit} already reached for today.` };
    }

    // 4. Build job search queue
    jobQueue = buildJobQueue(userConfig.jobTitles, userConfig.locations);
    currentJobIndex = 0;

    botRunning = true;
    botPaused  = false;

    await logToAPI('ok', '🚀 Bot started! Looking for jobs...');
    notifyPopup();

    // 5. Open first search
    processNextJob();

    return { success: true, message: 'Bot started!' };

  } catch (err) {
    return { error: 'Could not start bot: ' + err.message };
  }
}

// ============================================================
// STOP BOT
// ============================================================
function stopBot() {
  botRunning = false;
  botPaused  = false;
  jobQueue   = [];
  currentJobIndex = 0;

  // Close the bot tab if open
  if (currentTabId) {
    chrome.tabs.remove(currentTabId).catch(() => {});
    currentTabId = null;
  }

  logToAPI('warn', `Bot stopped. Applied ${appliedToday} jobs today.`);
  notifyPopup();
}

// ============================================================
// BUILD JOB SEARCH QUEUE
// Creates list of search URLs from user's preferences
// ============================================================
function buildJobQueue(jobTitles, locations) {
  const queue = [];
  for (const title of jobTitles) {
    for (const location of locations) {
      const slug = title.toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,'-');
      const loc  = location.toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,'-');
      const url  = location.toLowerCase() === 'remote'
        ? `https://www.naukri.com/${slug}-jobs?wfhType=2&jobAge=1`
        : `https://www.naukri.com/${slug}-jobs-in-${loc}?jobAge=1`;

      queue.push({ title, location, url, type: 'search' });
    }
  }
  return queue;
}

// ============================================================
// PROCESS NEXT JOB IN QUEUE
// ============================================================
async function processNextJob() {
  if (!botRunning) return;

  // Check daily limit
  if (appliedToday >= userConfig.dailyLimit) {
    await logToAPI('ok', `✅ Daily limit of ${userConfig.dailyLimit} reached! Done for today.`);
    stopBot();
    return;
  }

  // Wait if paused
  if (botPaused) {
    setTimeout(processNextJob, 3000);
    return;
  }

  // All searches done
  if (currentJobIndex >= jobQueue.length) {
    await logToAPI('ok', `✅ All searches complete. Applied ${appliedToday} jobs today.`);
    stopBot();
    return;
  }

  const item = jobQueue[currentJobIndex];
  await logToAPI('info', `🔍 Searching: "${item.title}" in "${item.location}"...`);

  // Open or reuse tab
  try {
    if (currentTabId) {
      await chrome.tabs.update(currentTabId, { url: item.url });
    } else {
      const tab = await chrome.tabs.create({ url: item.url, active: false });
      currentTabId = tab.id;
    }
  } catch (err) {
    // Tab was closed — create new one
    const tab = await chrome.tabs.create({ url: item.url, active: false });
    currentTabId = tab.id;
  }

  // Content script will handle it and message us back
}

// ============================================================
// HANDLE JOB APPLIED (called by content.js)
// ============================================================
async function handleJobApplied(jobData) {
  appliedToday++;

  // Save to backend
  try {
    await fetch(`${API_BASE}/application`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userConfig.token}`,
      },
      body: JSON.stringify({
        jobTitle:  jobData.title,
        company:   jobData.company,
        location:  jobData.location,
        platform:  'Naukri',
        url:       jobData.url,
        status:    'applied',
      }),
    });
  } catch {}

  await logToAPI('ok', `✅ Applied (${appliedToday}/${userConfig.dailyLimit}): ${jobData.title} @ ${jobData.company}`);
  notifyPopup();

  // Check if limit reached
  if (appliedToday >= userConfig.dailyLimit) {
    await logToAPI('ok', `✅ Daily limit reached! Done for today.`);
    stopBot();
    return;
  }

  // Move to next job after delay (human-like)
  const delay = 5000 + Math.random() * 8000; // 5–13 seconds
  setTimeout(() => {
    currentJobIndex++;
    processNextJob();
  }, delay);
}

// ============================================================
// LOG TO API (shows in dashboard)
// ============================================================
async function logToAPI(type, text) {
  console.log(`[${type}] ${text}`);
  if (!userConfig?.token) return;
  try {
    await fetch(`${API_BASE}/log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userConfig.token}`,
      },
      body: JSON.stringify({ type, text }),
    });
  } catch {}
}

// ============================================================
// NOTIFY POPUP (update UI if open)
// ============================================================
function notifyPopup() {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    data: {
      running:      botRunning,
      paused:       botPaused,
      appliedToday,
      dailyLimit:   userConfig?.dailyLimit || 20,
    },
  }).catch(() => {}); // Popup might not be open — that's ok
}