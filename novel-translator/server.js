require('dotenv').config();
const express = require('express');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

// เก็บสถานะงานแปลแต่ละงานไว้ใน memory (พอสำหรับใช้คนเดียวในเครื่อง)
const jobs = new Map();

// ---------- ส่วนที่ 1: ดึงเนื้อหานิยายจากลิงก์ ----------
async function scrapeNovelText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) throw new Error(`เปิดลิงก์ไม่ได้ (HTTP ${res.status})`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // ตัดส่วนที่ไม่ใช่เนื้อเรื่องออกก่อน
  $('script, style, nav, header, footer, .ads, .advertisement, .comments, .comment, .sidebar, iframe').remove();

  // หา container ที่มีข้อความยาวที่สุด (heuristic ใช้ได้กับเว็บนิยายทั่วไป)
  let bestEl = null;
  let bestLength = 0;
  $('div, article, section').each((_, el) => {
    const text = $(el).text().trim();
    // เลือก element ที่มีข้อความเยอะสุด แต่ไม่นับซ้ำ (ไม่เอา parent ที่ครอบทั้งหน้า)
    if (text.length > bestLength && text.length < 200000) {
      const childrenCount = $(el).children('div, article, section').length;
      if (childrenCount <= 3) {
        bestLength = text.length;
        bestEl = el;
      }
    }
  });

  let text = bestEl ? $(bestEl).text() : $('body').text();
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

  if (text.length < 200) {
    throw new Error('ดึงเนื้อหาไม่สำเร็จ หรือหน้านี้มีเนื้อหาน้อยเกินไป ลองเช็คลิงก์อีกครั้ง');
  }
  return text;
}

// ---------- ส่วนที่ 2: แบ่งข้อความเป็น chunk ----------
function splitIntoChunks(text, maxChars = 3000) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ---------- ส่วนที่ 3: เรียก Gemini แปลทีละ chunk ----------
async function translateChunk(chunkText, glossary) {
  if (!GEMINI_API_KEY) {
    throw new Error('ยังไม่ได้ตั้งค่า GEMINI_API_KEY ในไฟล์ .env');
  }

  const glossaryText = Object.keys(glossary).length
    ? `\n\nศัพท์เฉพาะที่ต้องแปลให้ตรงกับที่เคยใช้มาก่อน:\n${Object.entries(glossary).map(([en, th]) => `${en} = ${th}`).join('\n')}`
    : '';

  const prompt = `คุณคือนักแปลนิยายมืออาชีพ แปลข้อความภาษาอังกฤษต่อไปนี้เป็นภาษาไทยที่อ่านลื่น เป็นธรรมชาติ ไม่แปลตรงตัวแบบเครื่อง รักษาโทนเสียงและบุคลิกของตัวละครแต่ละคนให้ตรงกับต้นฉบับ (พูดหยาบก็แปลหยาบ พูดสุภาพก็แปลสุภาพ) แปลสำนวน/มุกตลก/คำสแลงให้เข้าใจง่ายในบริบทไทย ถ้าเนื้อหามีฉากผู้ใหญ่ ให้แปลตรงไปตรงมาตามต้นฉบับโดยไม่เซ็นเซอร์หรือปรับให้อ่อนลง

สำคัญมาก: ต้นฉบับแบ่งเป็นย่อหน้าโดยขึ้นบรรทัดใหม่คั่นด้วยบรรทัดว่าง (\\n\\n) ให้แปลแล้วจัดย่อหน้าในคำแปลให้ตรงกับต้นฉบับทุกประการ ห้ามรวมทุกย่อหน้าเป็นก้อนเดียว แต่ละย่อหน้าของต้นฉบับ = หนึ่งย่อหน้าของคำแปล คั่นด้วย \\n\\n เหมือนกัน ถ้าในต้นฉบับมีการขึ้นบรรทัดใหม่ในบทสนทนา (เช่นแต่ละคนพูดคนละบรรทัด) ให้คงการขึ้นบรรทัดนั้นไว้เหมือนเดิม${glossaryText}

ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON รูปแบบนี้ (ใน field translation ให้ใส่ \\n\\n จริงๆ ระหว่างย่อหน้า ไม่ใช่รวมเป็นบรรทัดเดียว):
{"translation": "ย่อหน้าที่ 1...\\n\\nย่อหน้าที่ 2...\\n\\nย่อหน้าที่ 3...", "newTerms": {"ชื่อเฉพาะภาษาอังกฤษ": "คำแปลไทยที่ใช้"}}

ข้อความที่ต้องแปล:
"""
${chunkText}
"""`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7 }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini API error (HTTP ${res.status})`);
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleaned = rawText.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      translation: parsed.translation || cleaned,
      newTerms: parsed.newTerms || {}
    };
  } catch {
    // ถ้า model ไม่ตอบเป็น JSON ตามที่ขอ ให้ใช้ข้อความดิบไปเลย
    return { translation: cleaned, newTerms: {} };
  }
}

// ---------- API: เริ่มงานแปล ----------
app.post('/api/translate-book', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'กรุณาส่งลิงก์มาด้วย' });

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'scraping', chunks: [], glossary: {}, error: null });
  res.json({ jobId });

  runTranslationJob(jobId, url).catch(err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
    }
  });
});

async function runTranslationJob(jobId, url) {
  const job = jobs.get(jobId);
  const rawText = await scrapeNovelText(url);
  const textChunks = splitIntoChunks(rawText);

  job.status = 'translating';
  job.total = textChunks.length;

  for (let i = 0; i < textChunks.length; i++) {
    const result = await translateChunk(textChunks[i], job.glossary);
    Object.assign(job.glossary, result.newTerms);
    job.chunks.push({ en: textChunks[i], th: result.translation });
  }

  job.status = 'done';
}

// ---------- API: เช็คสถานะงานแปล (frontend จะ poll ทุก 1-2 วิ) ----------
app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'ไม่พบงานแปลนี้' });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`เปิดเบราว์เซอร์ไปที่ http://localhost:${PORT}`);
});

// ---------- API: อ่านออกเสียงด้วยเสียงพากย์คุณภาพสูง (ฟรี ไม่ต้องใช้ API key) ----------
app.post('/api/tts', async (req, res) => {
  const { text, voice, rate } = req.body;
  if (!text) return res.status(400).json({ error: 'ไม่มีข้อความให้อ่าน' });

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice || 'th-TH-PremwadeeNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: rate || '+0%' });

    res.setHeader('Content-Type', 'audio/mpeg');
    audioStream.pipe(res);
    audioStream.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'สร้างเสียงไม่สำเร็จ' });
  }
});
