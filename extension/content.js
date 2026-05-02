// ============================================================
// ApplyPilot Extension — Content Script
// Injected into every Naukri page.
// Handles: job search scraping, applying, screening questions
// ============================================================

// Prevent running multiple times
console.log("🔥 content.js loaded");

console.log("🔥 content.js loaded");

// TEMP TEST — send NEXT_JOB after 5 seconds
setTimeout(() => {
  console.log("Sending NEXT_JOB");

  chrome.runtime.sendMessage({
    type: 'NEXT_JOB'
  });

}, 5000);
if (window.__applyPilotRunning) {
  // already injected
} else {
  window.__applyPilotRunning = true;
  init();
}

async function init() {
  const url = window.location.href;

  // ── Search results page ──────────────────────────────────
  if (url.includes('naukri.com') && (
    url.includes('-jobs-in-') ||
    url.includes('-jobs?') ||
    url.includes('-jobs/')
  )) {
    await handleSearchPage();
    return;
  }

  // ── Job detail page ──────────────────────────────────────
  if (url.includes('naukri.com/job-listings-')) {
    await handleJobPage();
    return;
  }
}

// ============================================================
// HANDLE SEARCH RESULTS PAGE
// Scrapes job listings and opens each one
// ============================================================
async function handleSearchPage() {
  await sleep(3000); // let page fully load

  // Find all job cards
  const cardSelectors = [
    '.jobTupleHeader',
    '.job-tuple-wrapper',
    '[class*="jobTuple"]',
    '.cust-job-tuple',
    'article',
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    cards = document.querySelectorAll(sel);
    if (cards.length > 0) break;
  }

  if (!cards.length) {
    chrome.runtime.sendMessage({ type: 'JOB_SKIPPED', reason: 'No job cards found on search page' });
    return;
  }

  // Extract job URLs from cards
  const jobLinks = [];
  for (const card of Array.from(cards).slice(0, 20)) {
    const titleEl = card.querySelector('.title a, .jobTitle a, h2 a, h3 a, [class*="title"] a');
    if (!titleEl) continue;

    const title   = titleEl.innerText?.trim() || '';
    const url     = titleEl.href || '';
    const compEl  = card.querySelector('.companyInfo a, .comp-name, [class*="company"] a, .subTitle');
    const company = compEl?.innerText?.trim() || 'Unknown';
    const locEl   = card.querySelector('.locWdth, [class*="location"], .loc');
    const location = locEl?.innerText?.trim() || '';

    if (!title || !url) continue;

    // Keyword filter — only apply to relevant jobs
    if (!isRelevantJob(title)) continue;

    jobLinks.push({ title, company, location, url });
  }

  if (!jobLinks.length) {
    chrome.runtime.sendMessage({ type: 'NEXT_JOB', reason: 'No relevant jobs on this page' });
    return;
  }

  // Store job list in local storage for background to process
  chrome.storage.local.set({ pendingJobs: jobLinks, pendingIndex: 0 });

  // Open first job
  openNextPendingJob();
}

// ============================================================
// HANDLE JOB DETAIL PAGE
// Clicks Apply, answers screening questions
// ============================================================
async function handleJobPage() {
  await sleep(2000);

  // Close any popup that appeared
  pressEscape();
  await sleep(500);

  // Get current job data from storage
  const stored = await chrome.storage.local.get(['pendingJobs', 'pendingIndex']);
  const jobs   = stored.pendingJobs || [];
  const idx    = stored.pendingIndex || 0;
  const job    = jobs[idx] || { title: document.title, company: '', location: '', url: window.location.href };

  // Check for login wall
  const bodyText = document.body.innerText.toLowerCase();
  if (['register to apply','login to apply','sign in to apply'].some(t => bodyText.includes(t))) {
    chrome.runtime.sendMessage({
      type: 'JOB_SKIPPED',
      reason: 'Login wall — user needs to be logged into Naukri'
    });
    return;
  }

  // Find apply button
  const applyBtn = findApplyButton();
  if (!applyBtn) {
    chrome.runtime.sendMessage({ type: 'JOB_SKIPPED', reason: `No apply button: ${job.title}` });
    advanceToNextJob(jobs, idx);
    return;
  }

  // Check if already applied
  const btnText = applyBtn.innerText?.toLowerCase() || '';
  if (btnText.includes('applied') || btnText.includes('withdraw')) {
    chrome.runtime.sendMessage({ type: 'JOB_SKIPPED', reason: `Already applied: ${job.title}` });
    advanceToNextJob(jobs, idx);
    return;
  }

  // Scroll and click apply
  applyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(800);
  applyBtn.click();
  await sleep(3000);

  // Handle screening questions (up to 15 steps)
  const screeningHandled = await handleScreening();

  // Report success
  chrome.runtime.sendMessage({
    type: 'JOB_APPLIED',
    data: { title: job.title, company: job.company, location: job.location, url: job.url }
  });

  // Move to next job after delay
  await sleep(2000);
  advanceToNextJob(jobs, idx);
}

// ============================================================
// FIND APPLY BUTTON
// ============================================================
function findApplyButton() {
  const selectors = [
    '#apply-button',
    'button[id*="apply" i]',
    'a[id*="apply" i]',
    'button[class*="apply" i]',
    'a[class*="apply" i]',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }

  // Find by text
  const all = document.querySelectorAll('button, a');
  for (const el of all) {
    const txt = el.innerText?.trim().toLowerCase();
    if ((txt === 'apply' || txt === 'apply now') && el.offsetParent !== null) return el;
  }

  return null;
}

// ============================================================
// HANDLE SCREENING QUESTIONS
// ============================================================
async function handleScreening() {
  // Get user config from storage
  const stored = await chrome.storage.local.get('userConfig');
  const user   = stored.userConfig || {};

  for (let step = 0; step < 15; step++) {
    await sleep(1000);

    // Check if popup/chatbot is still open
    const popup = findPopup();
    if (!popup) break;

    // Detect question text
    const qText = getQuestionText(popup);

    // Find current input
    const input = findActiveInput(popup);

    if (!input) {
      // Try clicking Next/Submit
      const nextClicked = clickNext(popup);
      if (!nextClicked) break;
      await sleep(1200);
      continue;
    }

    // Answer the question
    await answerInput(input, qText, user);
    await sleep(600);

    // Click Next/Submit
    clickNext(popup);
    await sleep(1200);
  }

  return true;
}

// Find Naukri's chatbot/questionnaire popup
function findPopup() {
  const sels = [
    '.chatbot_Drawer',
    '.chatbot_DrawerContentWrapper',
    '[class*="chatbot"]',
    '[class*="questionnaire"]',
    '[class*="applyModal"]',
    '[class*="ApplyModal"]',
    '.apply-questionnaire',
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

// Get the question text from popup
function getQuestionText(popup) {
  const msgSels = [
    '[class*="botMessage"]',
    '[class*="bot-message"]',
    '[class*="question"]',
    '[class*="Question"]',
    'label',
  ];
  for (const sel of msgSels) {
    const els = popup.querySelectorAll(sel);
    const visible = Array.from(els).filter(e => e.offsetParent !== null);
    if (visible.length) return visible[visible.length - 1].innerText?.trim().toLowerCase() || '';
  }
  return popup.innerText?.slice(0, 200).toLowerCase() || '';
}

// Find the active input in popup
function findActiveInput(popup) {
  // Text / number input
  const textInput = Array.from(popup.querySelectorAll(
    'input[type="text"], input[type="number"], input[type="tel"]'
  )).find(el => el.offsetParent !== null && !el.readOnly && !el.disabled);
  if (textInput) return { el: textInput, type: 'text' };

  // Select
  const select = Array.from(popup.querySelectorAll('select'))
    .find(el => el.offsetParent !== null && !el.disabled);
  if (select) return { el: select, type: 'select' };

  // Radio
  const radios = Array.from(popup.querySelectorAll('input[type="radio"]'))
    .filter(el => el.offsetParent !== null);
  if (radios.length) return { el: radios, type: 'radio' };

  // Textarea
  const textarea = Array.from(popup.querySelectorAll('textarea'))
    .find(el => el.offsetParent !== null && !el.readOnly);
  if (textarea) return { el: textarea, type: 'textarea' };

  return null;
}

// Answer an input based on question text
async function answerInput(input, qText, user) {
  const sk = user.skillExp || {};
  const exp = user.totalExpYears || 2;

  if (input.type === 'text') {
    const answer = getAnswerForQuestion(qText, user);
    const val = String(answer !== null ? answer : exp);
    setInputValue(input.el, val);
  }

  else if (input.type === 'select') {
    const answer = getBestSelectOption(input.el, qText, user);
    if (answer) {
      input.el.value = answer;
      input.el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  else if (input.type === 'radio') {
    const radios = input.el;
    const q = qText.toLowerCase();

    let target = null;

    // Yes/No → Yes
    target = radios.find(r => ['yes','true','1'].includes(r.value.toLowerCase()));

    // Notice period
    if (q.includes('notice') || q.includes('joining')) {
      target = radios.find(r =>
        r.value.includes(String(user.noticePeriod || 30)) ||
        r.closest('label')?.innerText?.includes('30') ||
        r.closest('label')?.innerText?.toLowerCase().includes('month')
      ) || radios[0];
    }

    if (!target) target = radios[0];
    if (target) {
      target.click();
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  else if (input.type === 'textarea') {
    const answer = getTextareaAnswer(qText, user);
    setInputValue(input.el, answer);
  }
}

// Set input value and trigger React events
function setInputValue(el, value) {
  el.focus();
  el.value = '';
  el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

// Click the next/submit button in popup
function clickNext(popup) {
  const btn = Array.from(popup.querySelectorAll('button'))
    .find(el => el.offsetParent !== null && !el.disabled &&
      /^(next|send|submit|continue|proceed|ok|done|save|go)$/i.test(el.innerText?.trim())
    );
  if (btn) { btn.click(); return true; }

  // Also try any submit button
  const submit = popup.querySelector('button[type="submit"]');
  if (submit && submit.offsetParent) { submit.click(); return true; }

  return false;
}

// ============================================================
// ANSWER LOGIC — maps question to correct answer
// ============================================================
function getAnswerForQuestion(label, user) {
  const l = label.toLowerCase();
  const sk = user.skillExp || {};
  const exp = user.totalExpYears || 2;

  // Skill experience
  if (l.includes('selenium'))    return sk.selenium    || exp;
  if (l.includes('cypress'))     return sk.cypress     || 1;
  if (l.includes('playwright'))  return sk.selenium    || 1;
  if (l.includes('java') && !l.includes('javascript')) return sk.java || exp;
  if (l.includes('python'))      return sk.python      || 1;
  if (l.includes('javascript') || l.includes('js')) return sk.javascript || exp;
  if (l.includes('react'))       return sk.react       || 1;
  if (l.includes('angular'))     return sk.angular     || 1;
  if (l.includes('node'))        return sk.node        || 1;
  if (l.includes('sql'))         return sk.sql         || exp;
  if (l.includes('aws'))         return sk.aws         || 1;
  if (l.includes('azure'))       return sk.azure       || 1;
  if (l.includes('devops') || l.includes('ci/cd')) return sk.devops || 1;
  if (l.includes('jira'))        return sk.jira        || exp;
  if (l.includes('git'))         return exp;
  if (l.includes('api') && l.includes('test')) return sk.api || exp;
  if (l.includes('manual') && l.includes('test')) return sk.manual || exp;
  if (l.includes('agile') || l.includes('scrum')) return sk.agile || exp;
  if (l.includes('docker'))      return sk.devops      || 1;
  if (l.includes('kubernetes') || l.includes('k8s')) return sk.devops || 1;
  if (l.includes('spring') || l.includes('springboot')) return sk.java || exp;
  if (l.includes('microservice')) return exp;
  if (l.includes('linux') || l.includes('unix')) return exp;

  // Total experience
  if (l.includes('total exp') || l.includes('overall exp') || l.includes('relevant exp')) return exp;
  if (l.includes('year') && l.includes('exp')) return exp;

  // CTC
  if (l.includes('current ctc') || l.includes('current salary')) return (user.currentCTC || 6) * 100000;
  if (l.includes('expected ctc') || l.includes('expected salary')) return (user.expectedCTC || 9) * 100000;
  if (l.includes('ctc') || l.includes('salary')) return (user.currentCTC || 6) * 100000;
  if (l.includes('lpa') || l.includes('lakh')) return user.currentCTC || 6;

  // Notice
  if (l.includes('notice') || l.includes('joining') || l.includes('available')) return user.noticePeriod || 30;

  // Personal
  if (l.includes('age'))    return user.age    || 26;
  if (l.includes('phone') || l.includes('mobile')) return user.phone || '9999999999';
  if (l.includes('location') || l.includes('city')) return (user.locations || ['Hyderabad'])[0];

  // Project/team
  if (l.includes('team size')) return 5;
  if (l.includes('test case') || l.includes('test script')) return 500;

  return null;
}

function getBestSelectOption(select, qText, user) {
  const opts = Array.from(select.options);
  const q    = qText.toLowerCase();
  const exp  = String(user.totalExpYears || 2);
  const notice = String(user.noticePeriod || 30);

  const find = (...terms) => opts.find(o =>
    terms.some(t => o.text.toLowerCase().includes(String(t).toLowerCase()) ||
                    o.value.toLowerCase().includes(String(t).toLowerCase()))
  );

  // Yes/No
  if (opts.some(o => o.text.toLowerCase() === 'yes')) return find('yes')?.value;

  // Notice period
  if (q.includes('notice') || q.includes('joining')) {
    const n = parseInt(notice);
    if (n === 0) return find('immediate','0 day')?.value || opts[0]?.value;
    if (n <= 15)  return find('15','two week')?.value || opts[1]?.value;
    if (n <= 30)  return find('30','1 month','one month')?.value || opts[1]?.value;
    if (n <= 60)  return find('60','2 month','two month')?.value || opts[2]?.value;
    return find('90','3 month')?.value || opts[opts.length - 1]?.value;
  }

  // Experience
  if (q.includes('exp') || q.includes('year')) {
    return find(exp, '2', '1-3', '2-3', '0-3')?.value || opts[1]?.value;
  }

  // Location
  if (q.includes('location') || q.includes('city')) {
    const locs = user.locations || ['Hyderabad'];
    return find(...locs, 'hyderabad', 'remote')?.value || opts[1]?.value;
  }

  // Work mode
  if (q.includes('work mode') || q.includes('remote') || q.includes('wfh')) {
    if (user.workMode === 'remote') return find('remote','wfh','work from home')?.value;
    if (user.workMode === 'hybrid') return find('hybrid')?.value;
    return find('any','hybrid','remote')?.value || opts[1]?.value;
  }

  // Default: skip first option (placeholder), pick second
  return opts[1]?.value || opts[0]?.value;
}

function getTextareaAnswer(label, user) {
  const l   = label.toLowerCase();
  const exp = user.totalExpYears || 2;
  const skills = user.skills || 'Selenium, TestNG, Java, Python, API Testing, JIRA';
  const name   = user.name || 'Applicant';

  if (l.includes('cover') || l.includes('message') || l.includes('write')) {
    return `Dear Hiring Manager,\n\nI am writing to express my strong interest in this position.\n\nWith ${exp}+ years of experience in ${skills}, I have built robust solutions that deliver results. I am eager to bring my expertise to your team and contribute from day one.\n\nBest regards,\n${name}`;
  }

  if (l.includes('about yourself') || l.includes('introduce')) {
    return `I am a software professional with ${exp}+ years of experience. My expertise includes ${skills}. I am passionate about quality and thrive in agile environments.`;
  }

  if (l.includes('skill') || l.includes('expertise')) return skills;

  if (l.includes('achievement') || l.includes('accomplish')) {
    return `Built automation frameworks that reduced manual testing effort by 70% and improved release velocity significantly.`;
  }

  if (l.includes('strength')) return 'Strong analytical skills, attention to detail, quick learner, and team player.';

  if (l.includes('weakness') || l.includes('improve')) {
    return 'I focus deeply on details, but I balance this by setting clear time boundaries for each task.';
  }

  if (l.includes('why') && (l.includes('company') || l.includes('join') || l.includes('us'))) {
    return 'I am impressed by your company\'s growth and the opportunity to contribute to meaningful work. My skills align well with your team\'s goals.';
  }

  if (l.includes('career') || l.includes('5 year') || l.includes('goal')) {
    return `In the next 5 years, I aim to grow into a senior role, deepen my expertise, and contribute to building impactful products.`;
  }

  if (l.includes('notice') || l.includes('joining')) {
    return `I can join within ${user.noticePeriod || 30} days of receiving an offer letter.`;
  }

  if (l.includes('salary') || l.includes('ctc')) {
    return `My current CTC is ${user.currentCTC || 6} LPA and I am expecting ${user.expectedCTC || 9} LPA.`;
  }

  // Generic fallback
  return `I have ${exp}+ years of experience with ${skills}. I am confident I can contribute effectively to your team from day one.`;
}

// ============================================================
// KEYWORD FILTER — only apply to relevant jobs
// ============================================================
function isRelevantJob(title) {
  const t = title.toLowerCase();

  // Skip senior roles if user is junior
  const skipWords = ['director','vp ','vice president','chief','cto','coo','ciso'];
  if (skipWords.some(w => t.includes(w))) return false;

  // Note: We allow all roles because user picked their own job titles
  // from the website preferences. The search URL already filters by title.
  // This is just a safety check.
  return true;
}

// ============================================================
// NAVIGATE TO NEXT JOB
// ============================================================
function advanceToNextJob(jobs, idx) {
  const nextIdx = idx + 1;
  chrome.storage.local.set({ pendingIndex: nextIdx });

  if (nextIdx >= jobs.length) {
    // All jobs in this search done — tell background to move to next search
    chrome.runtime.sendMessage({ type: 'NEXT_JOB' });
    return;
  }

  const nextJob = jobs[nextIdx];
  // Add small delay before opening next job
  setTimeout(() => {
    window.location.href = nextJob.url;
  }, 3000 + Math.random() * 5000);
}

function openNextPendingJob() {
  chrome.storage.local.get(['pendingJobs', 'pendingIndex'], (stored) => {
    const jobs = stored.pendingJobs || [];
    const idx  = stored.pendingIndex || 0;
    if (idx >= jobs.length) {
      chrome.runtime.sendMessage({ type: 'NEXT_JOB' });
      return;
    }
    window.location.href = jobs[idx].url;
  });
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}