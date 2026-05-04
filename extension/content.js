// ============================================================
// ApplyPilot Extension — Content Script
// Injected into Naukri pages
// Handles: search scraping, applying, ALL screening questions
// ============================================================

if (window.__applyPilotRunning) {
  // already running on this page
} else {
  window.__applyPilotRunning = true;
  init();
}

async function init() {
  const url = window.location.href;

  // Search results page
  if (url.match(/naukri\.com\/.*-jobs(-in-.*)?(\?|$|\/)/)) {
    await handleSearchPage();
    return;
  }

  // Job detail page
  if (url.includes('naukri.com/job-listings-')) {
    await handleJobPage();
    return;
  }
}

// ============================================================
// SEARCH PAGE — collect job links
// ============================================================
async function handleSearchPage() {
  await sleep(3000);

  const cardSels = [
    '.jobTupleHeader', '.job-tuple-wrapper',
    '[class*="jobTuple"]', '.cust-job-tuple', 'article',
  ];

  let cards = [];
  for (const sel of cardSels) {
    cards = document.querySelectorAll(sel);
    if (cards.length) break;
  }

  if (!cards.length) {
    chrome.runtime.sendMessage({ type: 'NEXT_JOB', reason: 'No job cards found' });
    return;
  }

  const jobs = [];
  for (const card of Array.from(cards).slice(0, 20)) {
    const titleEl = card.querySelector('.title a, .jobTitle a, h2 a, h3 a, [class*="title"] a');
    if (!titleEl) continue;
    const title    = titleEl.innerText?.trim() || '';
    const url      = titleEl.href || '';
    const compEl   = card.querySelector('.companyInfo a, .comp-name, [class*="company"] a, .subTitle');
    const company  = compEl?.innerText?.trim() || 'Unknown';
    const locEl    = card.querySelector('.locWdth, [class*="location"], .loc');
    const location = locEl?.innerText?.trim() || '';
    if (!title || !url) continue;
    jobs.push({ title, company, location, url });
  }

  if (!jobs.length) {
    chrome.runtime.sendMessage({ type: 'NEXT_JOB', reason: 'No valid jobs found' });
    return;
  }

  await chrome.storage.local.set({ pendingJobs: jobs, pendingIndex: 0 });
  openNextJob();
}

// ============================================================
// JOB DETAIL PAGE — apply + handle screening
// ============================================================
async function handleJobPage() {
  await sleep(2000);
  pressEsc();
  await sleep(600);

  // Get saved job list and user config
  const stored = await chrome.storage.local.get(['pendingJobs','pendingIndex','userConfig']);
  const jobs   = stored.pendingJobs || [];
  const idx    = stored.pendingIndex || 0;
  const user   = stored.userConfig  || {};
  const job    = jobs[idx] || { title: document.title, company: '', location: '', url: window.location.href };

  // Check for login wall
  const bodyTxt = document.body.innerText.toLowerCase();
  if (['register to apply','login to apply','sign in to apply'].some(t => bodyTxt.includes(t))) {
    chrome.runtime.sendMessage({ type: 'JOB_SKIPPED', reason: 'Not logged into Naukri' });
    return;
  }

  // Find apply button
  const applyBtn = findApplyBtn();
  if (!applyBtn) {
    chrome.runtime.sendMessage({ type: 'JOB_SKIPPED', reason: `No apply button: ${job.title}` });
    goNextJob(jobs, idx);
    return;
  }

  // Already applied?
  const btnTxt = applyBtn.innerText?.toLowerCase() || '';
  if (btnTxt.includes('applied') || btnTxt.includes('withdraw')) {
    chrome.runtime.sendMessage({ type: 'JOB_SKIPPED', reason: `Already applied: ${job.title}` });
    goNextJob(jobs, idx);
    return;
  }

  // Click Apply
  applyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(800);
  applyBtn.click();
  await sleep(3000);

  // Handle ALL screening questions
  await handleAllScreening(user, job);

  // Done — report back
  chrome.runtime.sendMessage({
    type: 'JOB_APPLIED',
    data: { title: job.title, company: job.company, location: job.location, url: job.url }
  });

  await sleep(2000);
  goNextJob(jobs, idx);
}

// ============================================================
// SCREENING QUESTIONS — handles everything Naukri can ask
// ============================================================
async function handleAllScreening(user, job) {
  // Run up to 20 question steps
  for (let step = 0; step < 20; step++) {
    await sleep(1200);

    // Is there a popup/chatbot open?
    const popup = findPopup();
    if (!popup) {
      // No popup — check for inline form on page
      const inlineForm = document.querySelector('form.apply-form, [class*="applyForm"], [class*="apply-form"]');
      if (!inlineForm) break; // Nothing to answer
    }

    const container = popup || document.body;

    // Get question text (what Naukri is asking)
    const qText = getQuestionText(container);

    // Find what input type is shown
    const input = findInput(container);

    if (!input) {
      // No input — just try clicking Next/Submit
      const clicked = clickNextBtn(container);
      if (!clicked) break;
      await sleep(1000);
      continue;
    }

    // Answer based on input type
    await answerQuestion(input, qText, user);
    await sleep(500);

    // Click Next/Send/Submit
    clickNextBtn(container);
    await sleep(1200);

    // If popup closed — we are done
    if (!findPopup() && !document.querySelector('form.apply-form, [class*="applyForm"]')) {
      break;
    }
  }
}

// ============================================================
// FIND POPUP
// ============================================================
function findPopup() {
  const sels = [
    '.chatbot_Drawer',
    '.chatbot_DrawerContentWrapper',
    '[class*="chatbot_Drawer"]',
    '[class*="ChatbotDrawer"]',
    '[class*="questionnaire"]',
    '[class*="Questionnaire"]',
    '[class*="applyModal"]',
    '[class*="ApplyModal"]',
    '[class*="screeningQuestion"]',
    '.apply-questionnaire',
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

// ============================================================
// GET QUESTION TEXT
// ============================================================
function getQuestionText(container) {
  // Naukri shows question as bot message in chatbot
  const msgSels = [
    '[class*="botMessage"]',
    '[class*="bot-message"]',
    '[class*="BotMessage"]',
    '[class*="questionText"]',
    '[class*="QuestionText"]',
    '[class*="question-text"]',
    'label',
    'legend',
    'h3', 'h4',
  ];

  for (const sel of msgSels) {
    const els = container.querySelectorAll(sel);
    const visible = Array.from(els).filter(e =>
      e.offsetParent !== null && e.innerText?.trim().length > 3
    );
    if (visible.length) {
      // Get the LAST visible one (current question)
      return visible[visible.length - 1].innerText.trim().toLowerCase();
    }
  }

  // Fallback — get all text in container
  return container.innerText?.slice(0, 300).toLowerCase() || '';
}

// ============================================================
// FIND ACTIVE INPUT
// ============================================================
function findInput(container) {
  // 1. Text / Number input
  const textInput = Array.from(container.querySelectorAll(
    'input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input:not([type])'
  )).find(el =>
    el.offsetParent !== null &&
    !el.readOnly &&
    !el.disabled &&
    el.type !== 'hidden' &&
    el.type !== 'checkbox' &&
    el.type !== 'radio' &&
    el.type !== 'file'
  );
  if (textInput) return { el: textInput, type: 'text' };

  // 2. Select dropdown
  const select = Array.from(container.querySelectorAll('select'))
    .find(el => el.offsetParent !== null && !el.disabled);
  if (select) return { el: select, type: 'select' };

  // 3. Radio buttons
  const radios = Array.from(container.querySelectorAll('input[type="radio"]'))
    .filter(el => el.offsetParent !== null);
  if (radios.length) return { el: radios, type: 'radio' };

  // 4. Checkboxes
  const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'))
    .filter(el => el.offsetParent !== null);
  if (checkboxes.length) return { el: checkboxes, type: 'checkbox' };

  // 5. Textarea
  const textarea = Array.from(container.querySelectorAll('textarea'))
    .find(el => el.offsetParent !== null && !el.readOnly && !el.disabled);
  if (textarea) return { el: textarea, type: 'textarea' };

  return null;
}

// ============================================================
// ANSWER THE QUESTION
// ============================================================
async function answerQuestion(input, qText, user) {
  const q = qText.toLowerCase();

  if (input.type === 'text') {
    const answer = getTextAnswer(q, user);
    const val = String(answer !== null ? answer : user.totalExpYears || 2);
    fillInput(input.el, val);
  }

  else if (input.type === 'select') {
    const bestOption = getBestOption(input.el, q, user);
    if (bestOption !== null) {
      input.el.value = bestOption;
      input.el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  else if (input.type === 'radio') {
    const bestRadio = getBestRadio(input.el, q, user);
    if (bestRadio) {
      bestRadio.click();
      bestRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  else if (input.type === 'checkbox') {
    // For checkboxes — check all relevant ones
    // Usually "I agree" type — just check first one
    const cb = input.el[0];
    if (cb && !cb.checked) {
      cb.click();
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  else if (input.type === 'textarea') {
    const answer = getTextareaAnswer(q, user);
    fillInput(input.el, answer);
  }
}

// ============================================================
// GET TEXT/NUMBER ANSWER
// Covers every question Naukri asks
// ============================================================
function getTextAnswer(q, user) {
  const sk  = user.skillExp   || {};
  const exp = user.totalExpYears || 2;

  // ── Total experience ─────────────────────────────
  if (matchQ(q, ['total experience','overall experience','relevant experience',
    'total years','years of experience','years experience',
    'total exp','how many years','work experience'])) return exp;

  // ── QA / Testing skills ──────────────────────────
  if (matchQ(q, ['selenium']))       return sk.selenium   || exp;
  if (matchQ(q, ['cypress']))        return sk.cypress    || 1;
  if (matchQ(q, ['playwright']))     return sk.selenium   || 1;
  if (matchQ(q, ['appium']))         return sk.selenium   || 1;
  if (matchQ(q, ['testng','test ng'])) return sk.java     || exp;
  if (matchQ(q, ['junit']))          return sk.java       || exp;
  if (matchQ(q, ['cucumber']))       return sk.selenium   || exp;
  if (matchQ(q, ['jmeter','j meter'])) return sk.manual  || 1;
  if (matchQ(q, ['postman']))        return sk.api        || exp;
  if (matchQ(q, ['rest assured','restassured'])) return sk.api || exp;
  if (matchQ(q, ['api testing','api test'])) return sk.api || exp;
  if (matchQ(q, ['manual testing','manual test'])) return sk.manual || exp;
  if (matchQ(q, ['automation testing','test automation'])) return sk.selenium || exp;
  if (matchQ(q, ['performance testing','load testing'])) return sk.manual || 1;

  // ── Languages ────────────────────────────────────
  if (matchQ(q, ['java']) && !matchQ(q,['javascript'])) return sk.java || exp;
  if (matchQ(q, ['python']))     return sk.python     || 1;
  if (matchQ(q, ['javascript','java script'])) return sk.javascript || exp;
  if (matchQ(q, ['typescript','type script'])) return sk.javascript || 1;
  if (matchQ(q, ['c#','csharp','c sharp','.net','dotnet'])) return sk.java || 1;
  if (matchQ(q, ['php']))        return 1;
  if (matchQ(q, ['ruby']))       return 0;
  if (matchQ(q, ['golang','go lang'])) return 0;
  if (matchQ(q, ['kotlin']))     return 0;
  if (matchQ(q, ['swift']))      return 0;
  if (matchQ(q, ['scala']))      return 0;

  // ── Frontend ─────────────────────────────────────
  if (matchQ(q, ['react','reactjs','react.js'])) return sk.react   || 1;
  if (matchQ(q, ['angular','angularjs']))        return sk.angular  || 1;
  if (matchQ(q, ['vue','vuejs','vue.js']))        return sk.javascript || 1;
  if (matchQ(q, ['html','css']))                 return sk.javascript || exp;
  if (matchQ(q, ['jquery']))                     return sk.javascript || exp;

  // ── Backend / Frameworks ─────────────────────────
  if (matchQ(q, ['node','nodejs','node.js']))    return sk.node    || 1;
  if (matchQ(q, ['spring','springboot','spring boot'])) return sk.java || exp;
  if (matchQ(q, ['hibernate']))                  return sk.java    || exp;
  if (matchQ(q, ['microservice','micro service'])) return exp;
  if (matchQ(q, ['rest api','restful']))         return sk.api     || exp;
  if (matchQ(q, ['graphql']))                    return sk.api     || 1;

  // ── Database ─────────────────────────────────────
  if (matchQ(q, ['sql','mysql','postgresql','postgres','oracle'])) return sk.sql || exp;
  if (matchQ(q, ['mongodb','mongo','nosql']))    return sk.sql     || 1;
  if (matchQ(q, ['redis']))                      return sk.devops  || 1;
  if (matchQ(q, ['elasticsearch']))              return 1;

  // ── Cloud / DevOps ───────────────────────────────
  if (matchQ(q, ['aws','amazon web service']))   return sk.aws     || 1;
  if (matchQ(q, ['azure','microsoft azure']))    return sk.azure   || 1;
  if (matchQ(q, ['gcp','google cloud']))         return sk.aws     || 1;
  if (matchQ(q, ['docker']))                     return sk.devops  || 1;
  if (matchQ(q, ['kubernetes','k8s']))           return sk.devops  || 1;
  if (matchQ(q, ['jenkins']))                    return sk.devops  || exp;
  if (matchQ(q, ['devops','ci/cd','cicd']))      return sk.devops  || 1;
  if (matchQ(q, ['git','github','gitlab','bitbucket'])) return exp;
  if (matchQ(q, ['linux','unix','bash','shell'])) return exp;
  if (matchQ(q, ['terraform']))                  return sk.devops  || 1;
  if (matchQ(q, ['ansible']))                    return sk.devops  || 1;

  // ── Project management ───────────────────────────
  if (matchQ(q, ['jira']))                       return sk.jira    || exp;
  if (matchQ(q, ['agile','scrum','kanban']))      return sk.agile   || exp;
  if (matchQ(q, ['confluence']))                 return exp;
  if (matchQ(q, ['project management']))         return exp;

  // ── CTC / Salary ─────────────────────────────────
  if (matchQ(q, ['current ctc','current salary','present ctc','present salary','existing salary'])) {
    return (user.currentCTC || 6) * 100000; // convert LPA to rupees
  }
  if (matchQ(q, ['expected ctc','expected salary','desired salary','target salary'])) {
    return (user.expectedCTC || 9) * 100000;
  }
  if (matchQ(q, ['hike','increment','salary hike'])) return 50; // 50% hike
  if (matchQ(q, ['ctc']) || matchQ(q, ['salary']) || matchQ(q, ['compensation'])) {
    return (user.currentCTC || 6) * 100000;
  }
  if (matchQ(q, ['lpa','lakh per annum','lakhs'])) return user.currentCTC || 6;

  // ── Notice period ────────────────────────────────
  if (matchQ(q, ['notice period','notice','joining period','joining time',
    'last working day','available from','when can you join','how soon'])) {
    return user.noticePeriod || 30;
  }

  // ── Personal ─────────────────────────────────────
  if (matchQ(q, ['age']))                        return user.age   || 26;
  if (matchQ(q, ['phone','mobile','contact number','phone number'])) return user.phone || '9999999999';
  if (matchQ(q, ['pincode','zip code','postal'])) return '500001';
  if (matchQ(q, ['location','city','preferred location','work location'])) {
    return (user.locations || ['Hyderabad'])[0];
  }

  // ── Other common questions ───────────────────────
  if (matchQ(q, ['team size','team members','team strength'])) return 5;
  if (matchQ(q, ['test cases','test scripts','number of test'])) return 500;
  if (matchQ(q, ['bugs','defects','issues raised'])) return 100;
  if (matchQ(q, ['clients','number of clients'])) return 3;
  if (matchQ(q, ['projects','number of projects'])) return 5;

  return null; // unknown — skip
}

// ============================================================
// GET BEST DROPDOWN OPTION
// ============================================================
function getBestOption(select, q, user) {
  const opts   = Array.from(select.options);
  const exp    = String(user.totalExpYears || 2);
  const notice = parseInt(user.noticePeriod) || 30;

  const find = (...terms) => {
    const opt = opts.find(o =>
      terms.some(t => o.text.toLowerCase().includes(t.toLowerCase()) ||
                      o.value.toLowerCase().includes(t.toLowerCase()))
    );
    return opt ? opt.value : null;
  };

  // Yes / No → pick Yes
  if (opts.some(o => o.text.toLowerCase() === 'yes')) return find('yes');
  if (opts.some(o => o.value.toLowerCase() === 'yes')) return 'yes';

  // Notice period
  if (matchQ(q, ['notice','joining','available','when can you join'])) {
    if (notice === 0) return find('immediate','0 day','no notice','currently serving') || opts[0]?.value;
    if (notice <= 15) return find('15','two week','15 days') || opts[1]?.value;
    if (notice <= 30) return find('30','1 month','one month','30 days') || opts[1]?.value;
    if (notice <= 60) return find('60','2 month','two month','60 days') || opts[2]?.value;
    return find('90','3 month','three month','90 days') || opts[opts.length-1]?.value;
  }

  // Experience range
  if (matchQ(q, ['exp','year','experience'])) {
    return find(exp,'2','1-3','1 to 3','2-3','0-3') || opts[1]?.value;
  }

  // Location
  if (matchQ(q, ['location','city','preferred'])) {
    const locs = user.locations || ['Hyderabad'];
    return find(...locs,'hyderabad','remote') || opts[1]?.value;
  }

  // Work mode
  if (matchQ(q, ['work from home','remote','wfh','hybrid','work mode'])) {
    const mode = user.workMode || 'any';
    if (mode === 'remote') return find('remote','work from home','wfh') || opts[0]?.value;
    if (mode === 'hybrid') return find('hybrid') || opts[0]?.value;
    if (mode === 'office') return find('office','on-site','onsite') || opts[0]?.value;
    return find('any','hybrid','flexible') || opts[1]?.value;
  }

  // CTC ranges
  if (matchQ(q, ['ctc','salary','lpa'])) {
    const ctc = String(Math.floor(user.currentCTC || 6));
    return find(ctc, ctc+'-', '-'+ctc) || opts[1]?.value;
  }

  // Gender
  if (matchQ(q, ['gender'])) return find(user.gender||'male','male') || opts[0]?.value;

  // Education
  if (matchQ(q, ['education','qualification','degree'])) {
    return find('b.tech','btech','b.e','be','bachelor','graduate') || opts[1]?.value;
  }

  // Relocation
  if (matchQ(q, ['relocat'])) {
    return user.relocate === 'yes'
      ? find('yes','willing','open') || opts[0]?.value
      : find('no','not willing') || opts[0]?.value;
  }

  // Default — skip placeholder (first option), pick second
  return opts[1]?.value || opts[0]?.value;
}

// ============================================================
// GET BEST RADIO OPTION
// ============================================================
function getBestRadio(radios, q, user) {
  // Yes / No → Yes
  const yesRadio = radios.find(r =>
    ['yes','true','1','agree','ok'].includes(r.value.toLowerCase()) ||
    r.closest('label')?.innerText?.trim().toLowerCase() === 'yes'
  );

  // Notice period
  if (matchQ(q, ['notice','joining','available'])) {
    const notice = String(user.noticePeriod || 30);
    const match = radios.find(r =>
      r.value.includes(notice) ||
      r.closest('label')?.innerText?.includes(notice) ||
      (notice <= 30 && r.closest('label')?.innerText?.toLowerCase().includes('1 month')) ||
      (notice <= 30 && r.closest('label')?.innerText?.toLowerCase().includes('30'))
    );
    return match || radios[0];
  }

  // Experience range
  if (matchQ(q, ['exp','year','experience'])) {
    const exp = String(user.totalExpYears || 2);
    const match = radios.find(r =>
      r.value.includes(exp) ||
      r.closest('label')?.innerText?.includes(exp) ||
      r.closest('label')?.innerText?.includes('1-3') ||
      r.closest('label')?.innerText?.includes('2-5')
    );
    return match || yesRadio || radios[0];
  }

  // Location
  if (matchQ(q, ['location','city','relocat'])) {
    const locs = user.locations || ['Hyderabad'];
    const match = radios.find(r =>
      locs.some(l => r.value.toLowerCase().includes(l.toLowerCase()) ||
                     r.closest('label')?.innerText?.toLowerCase().includes(l.toLowerCase()))
    );
    return match || radios[0];
  }

  // Default → Yes or first option
  return yesRadio || radios[0];
}

// ============================================================
// GET TEXTAREA ANSWER
// ============================================================
function getTextareaAnswer(q, user) {
  const exp    = user.totalExpYears || 2;
  const skills = user.skills || 'Selenium, TestNG, Java, Python, API Testing, JIRA';
  const name   = user.name   || 'Applicant';
  const curCTC = user.currentCTC  || 6;
  const expCTC = user.expectedCTC || 9;

  if (matchQ(q, ['cover letter','covering letter','message to employer','write to'])) {
    return `Dear Hiring Manager,\n\nI am writing to express my strong interest in this position. With ${exp}+ years of experience in ${skills}, I have a proven track record of delivering quality results in agile environments.\n\nI am confident I can contribute effectively to your team from day one.\n\nBest regards,\n${name}`;
  }

  if (matchQ(q, ['about yourself','introduce yourself','tell us about','describe yourself'])) {
    return `I am a software professional with ${exp}+ years of hands-on experience. My core expertise includes ${skills}. I am passionate about quality engineering and thrive in collaborative, fast-paced environments.`;
  }

  if (matchQ(q, ['skill','technical skill','expertise','key skill','core competenc'])) {
    return skills;
  }

  if (matchQ(q, ['achievement','accomplishment','proud of','significant work'])) {
    return `Built an end-to-end test automation framework that reduced regression testing time by 70% and improved release confidence significantly. Also mentored junior team members on automation best practices.`;
  }

  if (matchQ(q, ['strength','positive quality','good at'])) {
    return 'Strong analytical and problem-solving skills, attention to detail, quick learner, effective communicator, and collaborative team player.';
  }

  if (matchQ(q, ['weakness','area of improvement','develop further'])) {
    return 'I tend to be thorough with details, but I have been actively working on balancing quality with delivery speed by setting clear time-boxing strategies.';
  }

  if (matchQ(q, ['why','reason for applying','why this company','why us','why join'])) {
    return 'I am impressed by the company\'s growth trajectory, engineering culture, and the challenging work environment. I believe my skills and experience align well with this role and I can add immediate value.';
  }

  if (matchQ(q, ['career goal','5 year','future plan','long term','where do you see'])) {
    return `In the next 5 years, I aim to grow into a senior technical role, deepen my expertise in ${skills.split(',')[0]?.trim()} and related technologies, and contribute to building scalable, high-quality software systems.`;
  }

  if (matchQ(q, ['project','describe a project','tell about project','recent project'])) {
    return `In my recent project, I designed and implemented a comprehensive automation framework using ${skills.split(',').slice(0,3).join(', ')}. This reduced manual testing effort by over 60% and significantly improved team velocity and software quality.`;
  }

  if (matchQ(q, ['notice','joining','when can you start','availability'])) {
    return `I can join within ${user.noticePeriod || 30} days of receiving the offer letter.`;
  }

  if (matchQ(q, ['salary','ctc','compensation','package','hike'])) {
    return `My current CTC is ${curCTC} LPA and I am looking for ${expCTC} LPA based on my skills and market standards.`;
  }

  if (matchQ(q, ['relocation','willing to relocate','open to move'])) {
    return user.relocate === 'yes'
      ? 'Yes, I am open to relocation based on the job requirements.'
      : 'I prefer to work from my current location but am open to discussing this further.';
  }

  if (matchQ(q, ['team','leadership','manage','handled team'])) {
    return `I have worked in cross-functional agile teams of 5-10 members, collaborating closely with developers, product managers, and business stakeholders to deliver high-quality releases.`;
  }

  // Generic fallback
  return `I have ${exp}+ years of professional experience with expertise in ${skills}. I am confident in my ability to contribute effectively to your team and deliver results from day one.`;
}

// ============================================================
// CLICK NEXT / SUBMIT BUTTON
// ============================================================
function clickNextBtn(container) {
  // Find any action button
  const btn = Array.from(container.querySelectorAll('button, input[type="submit"]'))
    .find(el =>
      el.offsetParent !== null &&
      !el.disabled &&
      /next|send|submit|continue|proceed|ok|done|save|go|apply/i.test(
        el.innerText?.trim() || el.value || ''
      )
    );

  if (btn) { btn.click(); return true; }

  // Try pressing Enter
  const activeInput = document.activeElement;
  if (activeInput && activeInput.tagName !== 'BODY') {
    activeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }

  return false;
}

// ============================================================
// FILL INPUT WITH VALUE (triggers React events)
// ============================================================
function fillInput(el, value) {
  el.focus();
  // Clear first
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ) || Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  );

  if (nativeInputValueSetter?.set) {
    nativeInputValueSetter.set.call(el, value);
  } else {
    el.value = value;
  }

  // Trigger all possible events so React/Vue/Angular detect the change
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup',  { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown',{ bubbles: true }));
}

// ============================================================
// HELPERS
// ============================================================

// Check if question matches any keyword
function matchQ(q, keywords) {
  return keywords.some(k => q.includes(k.toLowerCase()));
}

function findApplyBtn() {
  const sels = [
    '#apply-button',
    'button[id*="apply" i]',
    'a[id*="apply" i]',
    'button[class*="apply" i]',
    'a[class*="apply" i]',
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  // By text
  return Array.from(document.querySelectorAll('button, a'))
    .find(el =>
      el.offsetParent !== null &&
      /^apply$|^apply now$/i.test(el.innerText?.trim())
    ) || null;
}

function pressEsc() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function goNextJob(jobs, idx) {
  const next = idx + 1;
  chrome.storage.local.set({ pendingIndex: next });
  if (next >= jobs.length) {
    chrome.runtime.sendMessage({ type: 'NEXT_JOB' });
    return;
  }
  setTimeout(() => {
    window.location.href = jobs[next].url;
  }, 3000 + Math.random() * 4000);
}

function openNextJob() {
  chrome.storage.local.get(['pendingJobs', 'pendingIndex'], stored => {
    const jobs = stored.pendingJobs || [];
    const idx  = stored.pendingIndex || 0;
    if (idx >= jobs.length) {
      chrome.runtime.sendMessage({ type: 'NEXT_JOB' });
      return;
    }
    window.location.href = jobs[idx].url;
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}