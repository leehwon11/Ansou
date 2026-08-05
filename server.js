const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');

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
  process.env.SUPABASE_ANON_KEY
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

// ── AI API 프록시 ──
app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages } = req.body;
    const response = await fetch(
      'https://factchat-cloud.mindlogic.ai/v1/gateway/claude/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.API_KEY
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system,
          messages
        })
      }
    );
    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '...';
    res.json({ content: text });
  } catch (e) {
    console.error('API 에러:', e);
    res.status(500).json({ content: '...' });
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
