// ============================================================
// ApplyPilot — Backend Server (for Chrome Extension)
// No Playwright here — bot runs in user's Chrome extension
// This server only handles: auth, preferences, storing results
// ============================================================
// Install:
//   npm install express cors bcryptjs jsonwebtoken uuid razorpay dotenv @supabase/supabase-js
//   node server.js
// ============================================================

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const Razorpay     = require('razorpay');
const crypto       = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public')); // your website HTML

// ── Supabase ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL    || 'YOUR_SUPABASE_URL',
  process.env.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_KEY'
);

// ── Razorpay ──────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID     || 'rzp_test_REPLACE',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'REPLACE',
});

const JWT_SECRET = process.env.JWT_SECRET || 'applypilot_secret_change_this';

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ============================================================
// DB HELPERS
// ============================================================
async function getUser(userId) {
  const { data } = await supabase
    .from('users').select('*').eq('user_id', userId).single();
  return data;
}

async function getUserByEmail(email) {
  const { data } = await supabase
    .from('users').select('*').eq('email', email).single();
  return data;
}

// Format user for sending to client — never send password
function safeUser(u) {
  if (!u) return null;
  return {
    userId:        u.user_id,
    name:          u.name,
    email:         u.email,
    plan:          u.plan          || 'free',
    dailyLimit:    u.daily_limit   || 20,
    jobTitles:     u.job_titles    || ['QA Automation Engineer'],
    locations:     u.locations     || ['Hyderabad', 'Remote'],
    totalExpYears: u.total_exp_years || 2,
    currentCTC:    u.current_ctc   || 6,
    expectedCTC:   u.expected_ctc  || 9,
    noticePeriod:  u.notice_period || 30,
    workMode:      u.work_mode     || 'any',
    skillExp:      u.skill_exp     || {},
    skills:        u.skills        || '',
    phone:         u.phone         || '',
    age:           u.age           || 26,
    gender:        u.gender        || 'male',
    education:     u.education     || 'btech',
    relocate:      u.relocate      || 'yes',
    hasNaukri:     !!(u.naukri_email),
    createdAt:     u.created_at,
  };
}

// ============================================================
// AUTH ROUTES
// ============================================================

// REGISTER
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  // Check if email exists
  const existing = await getUserByEmail(email).catch(() => null);
  if (existing) return res.status(400).json({ error: 'This email is already registered' });

  const userId      = uuid();
  const passwordHash = await bcrypt.hash(password, 10);

  const { error } = await supabase.from('users').insert([{
    user_id:        userId,
    name,
    email,
    password_hash:  passwordHash,
    plan:           'free',
    daily_limit:    20,
    job_titles:     ['QA Automation Engineer'],
    locations:      ['Hyderabad', 'Remote'],
    total_exp_years: 2,
    current_ctc:    6,
    expected_ctc:   9,
    notice_period:  30,
    work_mode:      'any',
    skill_exp:      {},
    created_at:     new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  }]);

  if (error) return res.status(500).json({ error: error.message });

  const user  = await getUser(userId);
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });

  res.json({ success: true, token, user: safeUser(user) });
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const user = await getUserByEmail(email).catch(() => null);
  if (!user) return res.status(400).json({ error: 'Email not found' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(400).json({ error: 'Wrong password' });

  const token = jwt.sign({ userId: user.user_id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user: safeUser(user) });
});

// GET MY PROFILE
app.get('/api/me', auth, async (req, res) => {
  const user = await getUser(req.userId).catch(() => null);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(user) });
});

// ============================================================
// PREFERENCES
// ============================================================
app.post('/api/preferences', auth, async (req, res) => {
  const {
    naukriEmail, naukriPass,
    jobTitles, locations, dailyLimit,
    totalExpYears, currentCTC, expectedCTC,
    noticePeriod, workMode,
    phone, age, gender, education, relocate,
    skills, skillExp,
  } = req.body;

  const updates = { updated_at: new Date().toISOString() };

  if (naukriEmail)   updates.naukri_email    = naukriEmail;
  if (naukriPass)    updates.naukri_pass     = naukriPass;
  if (jobTitles)     updates.job_titles      = jobTitles;
  if (locations)     updates.locations       = locations;
  if (dailyLimit)    updates.daily_limit     = parseInt(dailyLimit);
  if (totalExpYears) updates.total_exp_years = parseFloat(totalExpYears);
  if (currentCTC)    updates.current_ctc     = parseFloat(currentCTC);
  if (expectedCTC)   updates.expected_ctc    = parseFloat(expectedCTC);
  if (noticePeriod !== undefined) updates.notice_period = parseInt(noticePeriod);
  if (workMode)      updates.work_mode       = workMode;
  if (phone)         updates.phone           = phone;
  if (age)           updates.age             = parseInt(age);
  if (gender)        updates.gender          = gender;
  if (education)     updates.education       = education;
  if (relocate)      updates.relocate        = relocate;
  if (skills)        updates.skills          = skills;
  if (skillExp)      updates.skill_exp       = skillExp;

  const { error } = await supabase
    .from('users').update(updates).eq('user_id', req.userId);

  if (error) return res.status(500).json({ error: error.message });

  const user = await getUser(req.userId);
  res.json({ success: true, user: safeUser(user) });
});

// ============================================================
// APPLICATIONS — extension saves here after each apply
// ============================================================

// Save one application
app.post('/api/application', auth, async (req, res) => {
  const { jobTitle, company, location, platform, url, status } = req.body;

  const { error } = await supabase.from('applications').insert([{
    id:         uuid(),
    user_id:    req.userId,
    job_title:  jobTitle  || 'Unknown',
    company:    company   || 'Unknown',
    location:   location  || '',
    platform:   platform  || 'Naukri',
    url:        url       || '',
    status:     status    || 'applied',
    applied_at: new Date().toISOString(),
  }]);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Get status + applications (dashboard polls this)
app.get('/api/status', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // Get applications
  const { data: apps } = await supabase
    .from('applications')
    .select('*')
    .eq('user_id', req.userId)
    .order('applied_at', { ascending: false })
    .limit(100);

  // Get logs
  const { data: logs } = await supabase
    .from('logs')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(30);

  // Get user
  const user = await getUser(req.userId).catch(() => null);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const allApps    = apps    || [];
  const allLogs    = logs    || [];

  const todayApps  = allApps.filter(a => a.applied_at?.startsWith(today) && a.status === 'applied');
  const totalApplied = allApps.filter(a => a.status === 'applied').length;
  const responses  = allApps.filter(a => ['viewed','interview'].includes(a.status)).length;
  const interviews = allApps.filter(a => a.status === 'interview').length;

  res.json({
    plan:         user.plan,
    dailyLimit:   user.daily_limit,
    todayCount:   todayApps.length,
    totalApplied,
    responses,
    interviews,
    applications: allApps.slice(0, 50).map(a => ({
      jobId:    a.id,
      title:    a.job_title,
      company:  a.company,
      location: a.location,
      platform: a.platform,
      status:   a.status,
      appliedAt: a.applied_at,
    })),
    logs: allLogs.reverse().map(l => ({
      type: l.type,
      text: l.text,
      time: l.created_at,
    })),
  });
});

// ============================================================
// LOGS — extension sends logs here
// ============================================================
app.post('/api/log', auth, async (req, res) => {
  const { type, text } = req.body;
  await supabase.from('logs').insert([{
    id:         uuid(),
    user_id:    req.userId,
    type:       type || 'info',
    text:       text || '',
    created_at: new Date().toISOString(),
  }]);
  res.json({ success: true });
});

// ============================================================
// PAYMENTS (Razorpay)
// ============================================================

// Create order
app.post('/api/payment/create-order', auth, async (req, res) => {
  const prices = { pro: 49900, elite: 99900 };
  const { plan } = req.body;
  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const order = await razorpay.orders.create({
      amount:   prices[plan],
      currency: 'INR',
      receipt:  `rcpt_${req.userId}_${Date.now()}`,
      notes:    { userId: req.userId, plan },
    });
    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID || 'rzp_test_REPLACE',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify and upgrade
app.post('/api/payment/verify', auth, async (req, res) => {
  const { orderId, paymentId, signature, plan } = req.body;

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'REPLACE')
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  if (expected !== signature)
    return res.status(400).json({ error: 'Invalid payment signature' });

  await supabase.from('users').update({
    plan,
    daily_limit: plan === 'elite' ? 999 : 50,
    paid_at:     new Date().toISOString(),
    updated_at:  new Date().toISOString(),
  }).eq('user_id', req.userId);

  res.json({ success: true, plan });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 ApplyPilot Backend running on port ${PORT}`);
  console.log(`   No bots here — bot runs in user's Chrome extension`);
  console.log(`   Database: Supabase\n`);
});