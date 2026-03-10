/**
 * IDN LOGIN REST API — untuk Railway
 * Pakai @sparticuz/chromium (pre-built, tidak perlu apt install)
 *
 * Endpoints:
 *   POST /api/idn/send-otp    { email }
 *   POST /api/idn/verify-otp  { email, otp }
 *   GET  /health
 */

const express    = require('express');
const puppeteer  = require('puppeteer-core');
const chromium   = require('@sparticuz/chromium');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Session store ────────────────────────────────────────────────────────────
const sessionStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [email, s] of sessionStore.entries()) {
    if (now - s.createdAt > 10 * 60 * 1000) {
      console.log('[Cleanup] Session expired:', email);
      try { s.browser?.close(); } catch (_) {}
      sessionStore.delete(email);
    }
  }
}, 5 * 60 * 1000);

// ─── Launch browser pakai @sparticuz/chromium ─────────────────────────────────
async function launchBrowser() {
  const execPath = await chromium.executablePath();
  console.log('[Browser] executablePath:', execPath);

  return await puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
    defaultViewport: chromium.defaultViewport,
    executablePath: execPath,
    headless: chromium.headless,
  });
}

// ─── POST /api/idn/send-otp ───────────────────────────────────────────────────
app.post('/api/idn/send-otp', async (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter "email" wajib diisi dan harus valid',
      timestamp: new Date().toISOString(),
    });
  }

  // Tutup session lama kalau ada
  if (sessionStore.has(email)) {
    try { sessionStore.get(email).browser?.close(); } catch (_) {}
    sessionStore.delete(email);
  }

  console.log('\n[IDN] ══════════════════════════════════════════');
  console.log('[IDN] POST /api/idn/send-otp | email:', email);

  let browser = null;
  try {
    console.log('[*] Membuka browser...');
    browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Capture semua response penting
    const captured = {
      cognitoIDN:    null,
      initiateAuth:  null,
      respondToAuth: null,
      sendChallenge: null,
      tokens:        null,
      validateToken: null,
      profileDetail: null,
    };

    page.on('response', async (response) => {
      const url    = response.url();
      const method = response.request().method();
      if (method === 'OPTIONS') return;
      try {
        if (url.includes('/api/v1/user/cognito') && method === 'POST') {
          captured.cognitoIDN = await response.json();
          console.log('\n✅ /api/v1/user/cognito:', JSON.stringify(captured.cognitoIDN, null, 2));
        }
        if (url.includes('cognito-idp.ap-southeast-1.amazonaws.com') && method === 'POST') {
          const target = response.request().headers()['x-amz-target'] || '';
          const json   = await response.json();
          if (target.includes('InitiateAuth')) {
            captured.initiateAuth = json;
            console.log('\n✅ InitiateAuth:', JSON.stringify(json, null, 2));
          } else if (target.includes('RespondToAuthChallenge')) {
            captured.respondToAuth = json;
            console.log('\n✅ RespondToAuthChallenge:', JSON.stringify(json, null, 2));
          }
        }
        if (url.includes('/api/auth/send-challenge') && method === 'POST') {
          captured.sendChallenge = await response.json();
          console.log('\n✅ /api/auth/send-challenge:', JSON.stringify(captured.sendChallenge, null, 2));
        }
        if (url.includes('connect.idn.media') && method === 'POST' && url.includes('token')) {
          captured.tokens = await response.json();
          console.log('\n✅ Tokens:', JSON.stringify(captured.tokens, null, 2));
        }
        if (url.includes('validate-access-token-toggle')) {
          captured.validateToken = await response.json();
        }
        if (url.includes('/api/v2/profile/detail')) {
          captured.profileDetail = await response.json();
          console.log('\n✅ Profile Detail:', JSON.stringify(captured.profileDetail, null, 2));
        }
      } catch (_) {}
    });

    const loginUrl =
      'https://connect.idn.media/?client_id=6gnaj30oomhtl0t3qtkfp2uir9&redirect_uri=https://www.idn.app/&authorization_code=ef04562d-89e7-4322-b8ef-86dc4bf49814&state=dU5LvM8nvbI0REKm86t3hPjyXghAWS4m';

    // Step 1: Buka halaman login
    console.log('\n[1] Membuka halaman login...');
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input[name="identity"]', { timeout: 15000 });
    await page.type('input[name="identity"]', email, { delay: 80 });
    await page.click('button[type="submit"]');
    console.log('[+] Email diisi, klik Lanjutkan');

    // Step 2: Klik Kirim OTP
    console.log('\n[2] Menunggu halaman pilihan login...');
    await page.waitForFunction(
      () => document.body.innerText.includes('Kirim OTP'),
      { timeout: 20000 }
    );
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await btn.evaluate((el) => el.innerText.trim());
      if (text === 'Kirim OTP') { await btn.click(); break; }
    }
    console.log('[+] Klik Kirim OTP');

    // Step 3: Tunggu halaman input OTP
    console.log('\n[3] Menunggu halaman input OTP...');
    await page.waitForFunction(
      () => document.body.innerText.includes('Masukkan kode'),
      { timeout: 20000 }
    );
    console.log('[+] Halaman OTP muncul — OTP dikirim ke:', email);

    // Simpan browser ke session
    sessionStore.set(email, { browser, page, captured, createdAt: Date.now() });

    console.log('[IDN] ✅ OTP dikirim ke:', email);
    console.log('[IDN] ══════════════════════════════════════════\n');

    res.json({
      status:    'success',
      message:   `OTP berhasil dikirim ke ${email}`,
      email,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('[IDN] ❌ Error send-otp:', error.message);
    try { browser?.close(); } catch (_) {}
    sessionStore.delete(email);
    res.status(500).json({
      status:    'error',
      message:   error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── POST /api/idn/verify-otp ─────────────────────────────────────────────────
app.post('/api/idn/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter "email" wajib diisi dan harus valid',
      timestamp: new Date().toISOString(),
    });
  }
  if (!otp || !/^\d{6}$/.test(String(otp))) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter "otp" wajib 6 digit angka',
      timestamp: new Date().toISOString(),
    });
  }

  console.log('\n[IDN] ══════════════════════════════════════════');
  console.log('[IDN] POST /api/idn/verify-otp | email:', email, '| otp:', otp);

  const stored = sessionStore.get(email);
  if (!stored) {
    return res.status(400).json({
      status:    'error',
      message:   `Session tidak ditemukan untuk ${email}. Jalankan send-otp dulu.`,
      timestamp: new Date().toISOString(),
    });
  }
  if (Date.now() - stored.createdAt > 10 * 60 * 1000) {
    try { stored.browser?.close(); } catch (_) {}
    sessionStore.delete(email);
    return res.status(400).json({
      status:    'error',
      message:   'Session expired (>10 menit). Jalankan send-otp ulang.',
      timestamp: new Date().toISOString(),
    });
  }

  const { browser, page, captured } = stored;

  try {
    // Step 5: Input OTP
    console.log('\n[5] Memasukkan OTP...');
    const otpInputs = await page.$$('input');
    const otpDigits = String(otp).split('');

    if (otpInputs.length >= otpDigits.length) {
      for (let i = 0; i < otpDigits.length; i++) {
        if (otpInputs[i]) {
          await otpInputs[i].click();
          await otpInputs[i].type(otpDigits[i], { delay: 50 });
        }
      }
    } else if (otpInputs.length > 0) {
      await otpInputs[0].click();
      await otpInputs[0].type(String(otp), { delay: 50 });
    }

    // Klik Verifikasi
    await new Promise((r) => setTimeout(r, 500));
    const allButtons = await page.$$('button');
    for (const btn of allButtons) {
      const text = await btn.evaluate((el) => el.innerText.trim());
      if (text === 'Verifikasi' || text.toLowerCase().includes('verif')) {
        await btn.click();
        console.log('[+] Klik Verifikasi');
        break;
      }
    }

    // Step 6: Tunggu login selesai
    console.log('\n[6] Menunggu login selesai...');
    await new Promise((r) => setTimeout(r, 5000));

    // Capture cookies
    const cookies      = await page.cookies();
    const important    = ['id_token', 'access_token', 'refresh_token', 'client_id'];
    const savedCookies = {};
    cookies.forEach((c) => { if (important.includes(c.name)) savedCookies[c.name] = c.value; });

    console.log('\n✅ Cookies/Tokens tersimpan:', JSON.stringify(savedCookies, null, 2));

    const currentUrl = page.url();

    // Step 7: Susun output — format sama persis dengan script Puppeteer asli
    const allData = {
      timestamp:  new Date().toISOString(),
      email,
      uuid:       captured.cognitoIDN?.data?.uuid || null,
      cookies:    savedCookies,
      tokens: {
        id_token:      savedCookies.id_token      || captured.tokens?.id_token      || null,
        access_token:  savedCookies.access_token  || captured.tokens?.access_token  || null,
        refresh_token: savedCookies.refresh_token || captured.tokens?.refresh_token || null,
      },
      responses: {
        cognitoIDN:    captured.cognitoIDN,
        initiateAuth:  captured.initiateAuth,
        respondToAuth: captured.respondToAuth,
        sendChallenge: captured.sendChallenge,
        profileDetail: captured.profileDetail,
      },
      currentUrl,
    };

    const hasTokens = allData.tokens.access_token || allData.tokens.id_token
      || captured.initiateAuth || captured.respondToAuth;

    if (!hasTokens && !currentUrl.includes('idn.app')) {
      throw new Error(`Login tidak berhasil. URL: ${currentUrl}. OTP mungkin salah.`);
    }

    console.log('[IDN] ✅ Login berhasil | uuid:', allData.uuid);
    console.log('[IDN] ══════════════════════════════════════════\n');

    try { await browser.close(); } catch (_) {}
    sessionStore.delete(email);

    res.json({ status: 'success', message: 'Login IDN berhasil', ...allData });

  } catch (error) {
    console.error('[IDN] ❌ Error verify-otp:', error.message);
    try { await browser.close(); } catch (_) {}
    sessionStore.delete(email);
    res.status(500).json({
      status:    'error',
      message:   error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:          'ok',
    timestamp:       new Date().toISOString(),
    uptime:          process.uptime(),
    active_sessions: sessionStore.size,
  });
});

// ─── GET / ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:      'success',
    message:     'IDN Login API — Railway',
    version:     '2.0.0',
    server_time: new Date().toISOString(),
    endpoints: {
      'GET  /health':             'Health check',
      'POST /api/idn/send-otp':   '{ email }',
      'POST /api/idn/verify-otp': '{ email, otp }',
    },
  });
});

app.use((req, res) => res.status(404).json({
  status: 'error', message: 'Endpoint not found', path: req.path, timestamp: new Date().toISOString(),
}));
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ status: 'error', message: 'Internal server error', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('           🚀 IDN LOGIN API SERVER STARTED 🚀');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Port : ${PORT}`);
  console.log(`Env  : ${process.env.NODE_ENV || 'development'}`);
  console.log(`Time : ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════\n');
});

process.on('SIGTERM', async () => {
  for (const [, s] of sessionStore.entries()) {
    try { await s.browser?.close(); } catch (_) {}
  }
  process.exit(0);
});
