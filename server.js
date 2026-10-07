const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// DB 연결
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

// Supabase Storage 클라이언트
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
);

// multer - 메모리에 저장 (최대 5MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능해요'));
  }
});

// DB 테이블 초기화
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ansou_data (
      key VARCHAR(100) PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('DB 초기화 완료');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── 잠금 (APP_PASSWORD 환경변수가 있을 때만 켜짐) ──
// 비밀번호는 코드가 아니라 Render 환경변수에 둠 (저장소가 공개라서)
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_TOKEN = APP_PASSWORD
  ? crypto.createHmac('sha256', APP_PASSWORD).update('ansou-auth-v1').digest('hex')
  : '';
function readCookie(req, name) {
  const pair = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(name + '='));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
}
function isAuthed(req) {
  return !APP_PASSWORD || readCookie(req, 'ansou_auth') === AUTH_TOKEN;
}
// 4자리 비밀번호라 연속 실패 시 잠깐 막음
const loginFails = new Map();
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const f = loginFails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).json({ ok: false, error: '잠시 후 다시 시도해줘' });
  const hash = v => crypto.createHash('sha256').update(String(v)).digest();
  if (!crypto.timingSafeEqual(hash(req.body?.password ?? ''), hash(APP_PASSWORD))) {
    f.n += 1;
    if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
    loginFails.set(ip, f);
    return res.status(401).json({ ok: false });
  }
  loginFails.delete(ip);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ansou_auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  res.json({ ok: true });
});
app.get('/api/session', (req, res) => res.json({ ok: isAuthed(req), locked: !!APP_PASSWORD }));
app.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ ok: false, error: 'locked' });
});

// ── AI API 프록시 ──
// 모델/게이트웨이는 환경변수로 바꿀 수 있음 (게이트웨이가 지원하는 모델이어야 함)
const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL ||
  'https://factchat-cloud.mindlogic.ai/v1/gateway/claude/v1/messages';
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const AI_MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS, 10) || 2000;

async function callAI(system, messages, maxTokens = AI_MAX_TOKENS) {
  if (!process.env.API_KEY) throw new Error('API_KEY 환경변수가 설정되지 않았어요');
  const response = await fetch(AI_GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data.error?.message || data.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`게이트웨이 오류 ${response.status}: ${msg}`);
  }
  const text = data.content?.find(b => b.type === 'text')?.text?.trim() || '';
  if (!text) throw new Error(`빈 응답 (stop_reason: ${data.stop_reason || '알 수 없음'})`);
  if (data.stop_reason === 'max_tokens') console.warn('AI 응답이 max_tokens에서 잘림');
  return { text, data };
}

app.post('/api/chat', async (req, res) => {
  try {
    const { system } = req.body;
    // 빈 메시지는 API가 거부하므로 제거
    const messages = (req.body.messages || []).filter(m => m && typeof m.content === 'string' && m.content.trim());
    if (!messages.length) return res.status(400).json({ content: '', error: '메시지가 비어 있어요' });
    const { text } = await callAI(system, messages);
    res.json({ content: text });
  } catch (e) {
    console.error('API 에러:', e.message);
    res.status(502).json({ content: '', error: e.message });
  }
});

// ── 사진 설명 (이미지 인식) ──
// 사진을 한 번만 보고 짧은 설명을 만들어 둠 → 캐릭터들은 이 설명을 보고 반응
const IMG_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
async function describeImage(dataUrl, hint) {
  const m = IMG_RE.exec(dataUrl || '');
  if (!m) throw new Error('이미지 형식이 올바르지 않아요');
  const { text } = await callAI(
    '사진을 보고 무엇이 찍혀 있는지 한국어로 1~2문장으로 구체적으로 묘사해. 사람·사물·장소·분위기·색감 위주로. 추측은 "~같다"로. 묘사만 출력.',
    [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      { type: 'text', text: hint ? `참고(올린 사람이 쓴 글): ${String(hint).slice(0, 200)}` : '이 사진을 묘사해줘.' }
    ] }],
    300
  );
  return text;
}
app.post('/api/vision', async (req, res) => {
  try {
    res.json({ ok: true, description: await describeImage(req.body?.image, req.body?.hint) });
  } catch (e) {
    console.error('이미지 인식 에러:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
// 게이트웨이가 이미지를 받아주는지 확인용 (빨간 사각형)
const TEST_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAG0lEQVR4nGP4z8BAEmIY1TCqYVTDqIbhqgEAQ2tfoQeyaGEAAAAASUVORK5CYII=';
app.get('/api/health/vision', async (req, res) => {
  try { res.json({ ok: true, description: await describeImage(TEST_IMG) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ── AI 연결 상태 확인 ──
app.get('/api/health', async (req, res) => {
  const started = Date.now();
  try {
    const { text, data } = await callAI(
      '한국어로 한 문장만 답해.',
      [{ role: 'user', content: '연결 테스트야. "연결 성공!"이라고만 답해줘.' }],
      50
    );
    res.json({ ok: true, model: AI_MODEL, servedModel: data.model || null, latencyMs: Date.now() - started, sample: text });
  } catch (e) {
    res.status(502).json({ ok: false, model: AI_MODEL, latencyMs: Date.now() - started, error: e.message });
  }
});

// ── 이미지 업로드 ──
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '파일 없음' });
    const ext = req.file.originalname.split('.').pop();
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { data, error } = await supabase.storage
      .from('ansou-images')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
    if (error) throw error;
    const { data: urlData } = supabase.storage
      .from('ansou-images')
      .getPublicUrl(fileName);
    res.json({ ok: true, url: urlData.publicUrl });
  } catch (e) {
    console.error('업로드 에러:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 데이터 저장 ──
app.post('/api/data', async (req, res) => {
  try {
    const { key, value } = req.body;
    await pool.query(
      `INSERT INTO ansou_data (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [key, JSON.stringify(value)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('저장 에러:', e);
    res.status(500).json({ ok: false });
  }
});

// ── 데이터 불러오기 ──
app.get('/api/data/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const result = await pool.query(
      'SELECT value FROM ansou_data WHERE key=$1',
      [key]
    );
    if (result.rows.length > 0) {
      res.json({ value: result.rows[0].value });
    } else {
      res.json({ value: null });
    }
  } catch (e) {
    console.error('불러오기 에러:', e);
    res.status(500).json({ value: null });
  }
});

// ── 드림주 프로필 저장/불러오기 ──
app.post('/api/profile', async (req, res) => {
  try {
    const profile = req.body;
    await pool.query(
      `INSERT INTO ansou_data (key, value, updated_at)
       VALUES ('dreamProfile', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [JSON.stringify(profile)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.get('/api/profile', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM ansou_data WHERE key='dreamProfile'"
    );
    if (result.rows.length > 0) {
      res.json({ profile: result.rows[0].value });
    } else {
      res.json({ profile: null });
    }
  } catch (e) {
    res.status(500).json({ profile: null });
  }
});

// SPA 라우팅
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`서버 실행 중 : ${PORT}`));
}).catch((e) => {
  console.error('DB 초기화 실패 — DATABASE_URL을 확인하세요:', e.message);
  process.exit(1);
});
