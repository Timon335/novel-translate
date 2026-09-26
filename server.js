require('dotenv').config();
const express = require('express');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const db = require('./db.js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

// เก็บสถานะงานแปลแต่ละงานไว้ใน memory
const jobs = new Map();

// ---------- ส่วนที่ 1: ดึงเนื้อหานิยายจากลิงก์ (กรองปุ่ม เมนู คอมเมนต์ ออกอย่างหมดจด) ----------
async function scrapeNovelText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) throw new Error(`เปิดลิงก์ไม่ได้ (HTTP ${res.status})`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // ลบส่วนประกอบที่ไม่ใช่เนื้อหานิยายทั้งหมด
  const junkSelectors = [
    'script', 'style', 'nav', 'header', 'footer', 'aside', '.sidebar', 'iframe',
    '#comments', '.comments-area', '#respond', '.commentlist', '.comment', '.comments', '.comment-respond', '#reply-title',
    '.sharedaddy', '.jp-relatedposts', '#jp-post-flair', '.entry-utility', '.post-ratings', '.wpcnt', '.inline-ad',
    '.ads', '.advertisement', '.nav-links', '.navigation', '.chapter-nav', '.nav-single', '.post-navigation',
    '.header', '.footer', '.menu', '.widget'
  ];
  $(junkSelectors.join(', ')).remove();

  // ลำดับการหาคอนเทนเนอร์เนื้อหายอดนิยมของเว็บนิยาย (WordPress, RoyalRoad, Webnovel, NovelFull ฯลฯ)
  const novelSelectors = [
    '.entry-content',
    '#chapter-content',
    '.chapter-content',
    '.reading-content',
    '#chr-content',
    '.chapter-c',
    '.text-left',
    '.content-area',
    '#content',
    'article'
  ];

  let container = null;
  for (const sel of novelSelectors) {
    const el = $(sel);
    if (el.length) {
      const pCount = el.find('p').length;
      const textLen = el.text().trim().length;
      if (pCount >= 3 || textLen > 500) {
        container = el.first();
        break;
      }
    }
  }

  // หากไม่เจอ selector เฉพาะ ให้หา element ที่มีจำนวนย่อหน้าหรือข้อความที่สมเหตุสมผลที่สุด
  if (!container) {
    let bestEl = null;
    let maxScore = 0;
    $('div, article, section').each((_, el) => {
      const id = $(el).attr('id') || '';
      if (/^(page|wrapper|container|main-container|site|app)$/i.test(id)) return;

      const pCount = $(el).find('p').length;
      const text = $(el).text().trim();
      const score = pCount * 100 + Math.min(text.length, 50000);
      if (score > maxScore && text.length < 300000) {
        maxScore = score;
        bestEl = el;
      }
    });
    container = bestEl ? $(bestEl) : $('body');
  }

  // สกัดย่อหน้าทีละส่วน และคัดกรองปุ่มกด/ข้อความส่วนเกิน
  const paragraphs = [];
  const pElements = container.find('p');

  if (pElements.length >= 3) {
    pElements.each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (!t) return;
      // กรองปุ่มนำทาง / ลิงก์ตอนก่อนหน้า-ถัดไป / ปุ่มแชร์ / คอมเมนต์
      if (/^(last|next|previous)\s+chapter/i.test(t)) return;
      if (/^(chapter\s+navigation|table\s+of\s+contents|share\s+this|like\s+loading)/i.test(t)) return;
      if (/^(thoughts\s+on|leave\s+a\s+comment|cancel\s+reply)/i.test(t)) return;
      paragraphs.push(t);
    });
  } else {
    // กรณีใช้ <br> แทน <p>
    container.find('br').replaceWith('\n');
    const rawLines = container.text().split(/\n+/);
    for (const line of rawLines) {
      const t = line.replace(/\s+/g, ' ').trim();
      if (!t || t.length < 5) continue;
      if (/^(last|next|previous)\s+chapter/i.test(t)) continue;
      if (/^(share\s+this|like\s+loading)/i.test(t)) continue;
      paragraphs.push(t);
    }
  }

  const cleanText = paragraphs.join('\n\n').trim();
  if (cleanText.length < 100) {
    throw new Error('ดึงเนื้อหาไม่สำเร็จ หรือหน้านี้มีเนื้อหาน้อยเกินไป ลองเช็คลิงก์อีกครั้ง');
  }
  return cleanText;
}

// ---------- ส่วนที่ 2: แบ่งข้อความเป็น chunk ตามย่อหน้า ----------
function splitIntoChunks(text, maxChars = 2500) {
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

// ---------- ส่วนที่ 3: Global Rate Limiter + translateChunk ----------

// ติดตามเวลาที่ส่ง API ล่าสุด เพื่อบังคับ delay ขั้นต่ำระหว่าง request
let _lastApiCallTime = 0;
const MIN_REQUEST_INTERVAL_MS = 4500; // 4.5 วินาที = ปลอดภัยสำหรับ limit 20 req/min

async function waitForRateLimit() {
  const now = Date.now();
  const elapsed = now - _lastApiCallTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  _lastApiCallTime = Date.now();
}

// โมเดล Gemini ที่ทำงานได้จริง เรียงตามลำดับความเสถียร
const ALL_MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
let _lastWorkingModelIndex = 0;

function parseRetryDelay(errMsg) {
  const match = errMsg.match(/Please retry in ([\d.]+)s/);
  if (match) return Math.ceil(parseFloat(match[1])) * 1000 + 500;
  return null;
}

async function callGeminiAPI(model, prompt) {
  await waitForRateLimit();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7 }
    })
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ระบบแกะคำแปลที่ปลอดภัย ไร้ข้อผิดพลาด JSON และกรองแท็กส่วนเกินออกทั้งหมด
function parseGeminiResponse(data) {
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let text = rawText.trim();

  // 1. ตรวจจับรูปแบบ ===TRANSLATION=== และ ===GLOSSARY===
  if (text.includes('===TRANSLATION===')) {
    const parts = text.split(/===GLOSSARY===/i);
    const translation = parts[0].replace(/===TRANSLATION===/i, '').trim();
    const glossaryPart = parts[1] || '';
    const newTerms = {};

    glossaryPart.split('\n').forEach(line => {
      const match = line.match(/^[-*•]?\s*([^=:]+?)\s*[=:]\s*(.+)$/);
      if (match) {
        const en = match[1].trim();
        const th = match[2].trim();
        if (en && th && en.length < 50 && th.length < 50) {
          newTerms[en] = th;
        }
      }
    });

    return { translation, newTerms };
  }

  // 2. ถ้าเผลอตอบมาเป็น JSON
  let cleaned = text.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.translation) {
      return {
        translation: parsed.translation.trim(),
        newTerms: parsed.newTerms || {}
      };
    }
  } catch {
    // พยายามดึง translation ออกจาก JSON ที่พัง
    const transMatch = cleaned.match(/["']translation["']\s*:\s*["']([\s\S]*?)["']\s*,\s*["']newTerms["']/);
    if (transMatch) {
      const termsMatch = cleaned.match(/["']newTerms["']\s*:\s*\{([\s\S]*?)\}/);
      const newTerms = {};
      if (termsMatch) {
        termsMatch[1].split(/[,\n]/).forEach(l => {
          const m = l.match(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/);
          if (m) newTerms[m[1]] = m[2];
        });
      }
      return {
        translation: transMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim(),
        newTerms
      };
    }
  }

  // 3. ป้องกันกรณีมี JSON tag หรือ Delimiter หลงเหลือ
  cleaned = cleaned.replace(/^\s*\{\s*["']translation["']\s*:\s*["']?/, '');
  cleaned = cleaned.replace(/["']?\s*,\s*["']newTerms["'][\s\S]*$/, '');
  cleaned = cleaned.replace(/\s*\}\s*$/, '');
  cleaned = cleaned.replace(/===TRANSLATION===/gi, '').replace(/===GLOSSARY===[\s\S]*$/gi, '');

  return { translation: cleaned.trim(), newTerms: {} };
}

async function translateChunk(chunkText, glossary) {
  if (!GEMINI_API_KEY) {
    throw new Error('ยังไม่ได้ตั้งค่า GEMINI_API_KEY ในไฟล์ .env');
  }

  const glossaryEntries = Object.entries(glossary);
  const glossaryText = glossaryEntries.length
    ? `\n\nคำศัพท์/ชื่อเฉพาะที่กำหนดไว้ (ต้องแปลให้ตรงตามนี้เพื่อความต่อเนื่อง):\n${glossaryEntries.map(([en, th]) => `- ${en} = ${th}`).join('\n')}`
    : '';

  const prompt = `คุณคือนักแปลนิยายมืออาชีพ แปลเนื้อหานิยายภาษาอังกฤษต่อไปนี้เป็นภาษาไทย:
- สำนวนสละสลวย เป็นธรรมชาติ เหมือนวรรณกรรมแปลมืออาชีพ ไม่แปลแข็งทื่อแบบโปรแกรมแปล
- คงโทนเสียง อารมณ์ และบุคลิกของตัวละครแต่ละคนให้ตรงต้นฉบับ
- การจัดย่อหน้า: สำคัญมาก! ต้องคงการจัดย่อหน้าตามต้นฉบับเป๊ะๆ แต่ละย่อหน้าของต้นฉบับต้องแปลเป็นหนึ่งย่อหน้าในภาษาไทย และคั่นระหว่างย่อหน้าด้วยบรรทัดว่าง (\\n\\n) เสมอ
- ห้ามเขียนคำนำ คำอธิบายเพิ่มเติม หรือข้อความใดๆ นอกเหนือจากรูปแบบที่กำหนดด้านล่าง${glossaryText}

รูปแบบคำตอบที่ต้องการ:
===TRANSLATION===
(ข้อความที่แปลเป็นภาษาไทย โดยเว้นบรรทัดว่างระหว่างย่อหน้าให้ตรงกับต้นฉบับ)
===GLOSSARY===
(ถ้าพบชื่อตัวละคร สถานที่ หรือศัพท์เฉพาะใหม่ ให้ระบุ: คำอังกฤษ = คำแปลไทย บรรทัดละ 1 คำ)

ข้อความต้นฉบับที่ต้องแปล:
"""
${chunkText}
"""`;

  // เรียงโมเดลให้เริ่มจากโมเดลที่สำเร็จล่าสุด
  const orderedModels = [
    ...ALL_MODELS.slice(_lastWorkingModelIndex),
    ...ALL_MODELS.slice(0, _lastWorkingModelIndex)
  ];

  let lastError = null;

  // รอบแรก: ลองทุกโมเดล (หากติด rate limit ให้ข้ามไปโมเดลถัดไปทันที)
  for (let mi = 0; mi < orderedModels.length; mi++) {
    const model = orderedModels[mi];
    try {
      const { ok, status, data } = await callGeminiAPI(model, prompt);
      if (ok) {
        _lastWorkingModelIndex = ALL_MODELS.indexOf(model);
        console.log(`[Gemini API] ✓ แปลสำเร็จด้วย ${model}`);
        return parseGeminiResponse(data);
      }
      const errMsg = data?.error?.message || `HTTP ${status}`;
      const isRateLimit = status === 429 || status === 503 ||
        errMsg.includes('high demand') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('UNAVAILABLE');
      if (isRateLimit) {
        console.warn(`[Gemini API] ${model} ติด Rate Limit/High Demand — สลับโมเดลถัดไปทันที`);
        lastError = new Error(errMsg);
      } else {
        lastError = new Error(errMsg);
      }
    } catch (err) {
      lastError = err;
    }
  }

  // รอบสอง: ทุกโมเดลติด rate limit — รอตามคำแนะนำของ API แล้วลองใหม่
  console.warn('[Gemini API] ทุกโมเดลติด Rate Limit — กำลังรอตามเวลาที่ API แจ้ง...');
  const apiWait = parseRetryDelay(lastError?.message || '') || 65000;
  const waitMs = Math.min(apiWait, 70000);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  _lastApiCallTime = 0;

  for (const model of ALL_MODELS) {
    try {
      const { ok, status, data } = await callGeminiAPI(model, prompt);
      if (ok) {
        _lastWorkingModelIndex = ALL_MODELS.indexOf(model);
        console.log(`[Gemini API] ✓ แปลสำเร็จ (หลังรอ) ด้วย ${model}`);
        return parseGeminiResponse(data);
      }
      lastError = new Error(data?.error?.message || `HTTP ${status}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Gemini API ติด Quota Limit — กรุณารอสักครู่แล้วลองใหม่');
}

// ---------- API: แปลด่วน (Quick Translate) ----------
app.post('/api/translate-book', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'กรุณาส่งลิงก์มาด้วย' });

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'scraping', chunks: [], glossary: {}, error: null, savedChapterId: null });
  res.json({ jobId });

  runTranslationJob(jobId, url).catch(err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
    }
  });
});

// ---------- API: แปลตอนใหม่และบันทึกลง Database ของนิยาย ----------
app.post('/api/novels/:id/chapters/translate', async (req, res) => {
  const novelId = parseInt(req.params.id, 10);
  const novel = db.getNovelById(novelId);
  if (!novel) return res.status(404).json({ error: 'ไม่พบนิยายเรื่องนี้' });

  const { url, chapter_number, title } = req.body;
  if (!url) return res.status(400).json({ error: 'กรุณาส่งลิงก์มาด้วย' });

  const jobId = crypto.randomUUID();
  // ดึงคำศัพท์ที่เคยบันทึกไว้ในนิยายเรื่องนี้มาใช้เริ่มต้น
  const existingGlossary = db.getNovelGlossary(novelId);
  const chapterTitle = title && title.trim() ? title.trim() : (chapter_number ? `ตอนที่ ${chapter_number}` : 'ตอนที่ไม่มีชื่อ');

  jobs.set(jobId, {
    status: 'scraping',
    novelId,
    chapterNumber: chapter_number,
    chapterTitle,
    url,
    chunks: [],
    glossary: { ...existingGlossary },
    error: null,
    savedChapterId: null
  });

  res.json({ jobId });

  runTranslationJob(jobId, url, {
    novelId,
    chapterNumber: chapter_number,
    chapterTitle
  }).catch(err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
    }
  });
});

// ---------- ส่วนที่ 4: ตรวจสอบและแก้ไขคำภาษาไทย ----------
async function proofreadThai(translatedText) {
  const prompt = `คุณคือบรรณาธิการนิยายภาษาไทยมืออาชีพ หน้าที่ของคุณคือตรวจสอบและแก้ไขข้อความภาษาไทยต่อไปนี้ให้ถูกต้องสมบูรณ์:
- แก้ไขการสะกดคำผิด เช่น "ไม่ใช้" → "ไม่ใช่", "กรุณา" → "กรุณา"
- แก้ไขการเว้นวรรคที่ผิด เช่น การเว้นวรรคเกินหรือขาด
- แก้ไขการใช้คำเชื่อมหรือไวยากรณ์ที่ผิดเพี้ยน
- คงย่อหน้าและโครงสร้างข้อความเดิมไว้ทุกอย่าง ห้ามเพิ่มหรือลบเนื้อหา
- ห้ามแปลใหม่ ห้ามเปลี่ยนความหมาย ให้แก้เฉพาะการสะกดและไวยากรณ์เท่านั้น
- ห้ามเขียนคำอธิบาย คำนำ หรือข้อความเพิ่มเติมใดๆ ทั้งสิ้น ตอบเฉพาะข้อความที่แก้ไขแล้วเท่านั้น

ข้อความที่ต้องตรวจสอบ:
"""
${translatedText}
"""`;

  const orderedModels = [
    ...ALL_MODELS.slice(_lastWorkingModelIndex),
    ...ALL_MODELS.slice(0, _lastWorkingModelIndex)
  ];

  for (const model of orderedModels) {
    try {
      const { ok, data } = await callGeminiAPI(model, prompt);
      if (ok) {
        const corrected = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return corrected.trim() || translatedText; // fallback to original if empty
      }
    } catch { /* ลองโมเดลถัดไป */ }
  }
  return translatedText; // ถ้าตรวจไม่ได้ ให้คืนต้นฉบับ
}

async function runTranslationJob(jobId, url, novelMeta = null) {
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

  // ตรวจสอบและแก้ไขคำภาษาไทยทั้งตอน
  job.status = 'proofreading';
  job.proofreadDone = 0;
  job.proofreadTotal = job.chunks.length;

  for (let i = 0; i < job.chunks.length; i++) {
    job.chunks[i].th = await proofreadThai(job.chunks[i].th);
    job.proofreadDone = i + 1;
  }

  // หากเป็นงานแปลของนิยายในฐานข้อมูล ให้บันทึกลง SQLite อัตโนมัติ
  if (novelMeta && novelMeta.novelId) {
    try {
      const chapterId = db.createChapter({
        novel_id: novelMeta.novelId,
        chapter_number: novelMeta.chapterNumber,
        title: novelMeta.chapterTitle,
        source_url: url,
        chunks: job.chunks
      });
      // อัปเดตตารางศัพท์เฉพาะของเรื่อง
      db.saveNovelGlossary(novelMeta.novelId, job.glossary);
      job.savedChapterId = chapterId;
      console.log(`[Database] บันทึกตอนสำเร็จ ID: ${chapterId} เข้าเรื่อง ID: ${novelMeta.novelId}`);
    } catch (dbErr) {
      console.error('[Database Error] บันทึกตอนลงฐานข้อมูลไม่สำเร็จ:', dbErr);
    }
  }

  job.status = 'done';
}

// ---------- API: แปลหลายตอนพร้อมกัน (Batch Translate) ----------
app.post('/api/novels/:id/chapters/batch-translate', async (req, res) => {
  const novelId = parseInt(req.params.id, 10);
  const novel = db.getNovelById(novelId);
  if (!novel) return res.status(404).json({ error: 'ไม่พบนิยายเรื่องนี้' });

  const { startUrl, endUrl, startChapterNumber } = req.body;
  if (!startUrl || !endUrl) return res.status(400).json({ error: 'กรุณาส่ง startUrl และ endUrl' });

  // แยก chapter ID ออกจาก URL (ตัวเลขท้าย path)
  const extractId = (url) => {
    const m = url.trim().replace(/\/$/, '').match(/\/(\d+)(?:\?.*)?$/);
    if (!m) return null;
    return parseInt(m[1], 10);
  };
  const baseUrl = startUrl.trim().replace(/\/$/, '').replace(/\/\d+(\?.*)?$/, '');
  const startId = extractId(startUrl);
  const endId = extractId(endUrl);

  if (startId === null || endId === null) {
    return res.status(400).json({ error: 'ดึง chapter ID จาก URL ไม่ได้ กรุณาตรวจสอบลิงก์' });
  }
  if (endId < startId) {
    return res.status(400).json({ error: 'URL สุดท้ายต้องมี ID มากกว่าหรือเท่ากับ URL แรก' });
  }

  // สร้าง URL list step+1
  const urls = [];
  for (let id = startId; id <= endId; id++) {
    const suffix = startUrl.includes('?') ? startUrl.replace(/.*(\?.*)$/, '$1') : '';
    urls.push(`${baseUrl}/${id}${suffix}`);
  }

  // คำนวณเลขตอนเริ่มต้น
  let nextChapterNum = startChapterNumber || 1;
  if (!startChapterNumber) {
    const existingChapters = novel.chapters || [];
    const nums = existingChapters.map(c => c.chapter_number).filter(n => n !== null && !isNaN(n));
    nextChapterNum = nums.length > 0 ? Math.floor(Math.max(...nums)) + 1 : 1;
  }

  // สร้าง batch job ที่ track รายตอน
  const batchJobId = crypto.randomUUID();
  const batchJob = {
    status: 'running',
    type: 'batch',
    total: urls.length,
    done: 0,
    failed: 0,
    currentIndex: 0,
    currentUrl: '',
    currentStatus: '',
    jobIds: [],    // job ID แต่ละตอน
    savedChapterIds: [],
    errors: [],
  };
  jobs.set(batchJobId, batchJob);
  res.json({ batchJobId, total: urls.length });

  // รันแปลทีละตอนแบบ sequential
  (async () => {
    const existingGlossary = db.getNovelGlossary(novelId);
    let rollingGlossary = { ...existingGlossary };

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const chapterNum = nextChapterNum + i;
      const chapterTitle = `ตอนที่ ${chapterNum}`;

      batchJob.currentIndex = i;
      batchJob.currentUrl = url;
      batchJob.currentStatus = 'scraping';

      const jobId = crypto.randomUUID();
      batchJob.jobIds.push(jobId);
      jobs.set(jobId, {
        status: 'scraping',
        novelId,
        chapterNumber: chapterNum,
        chapterTitle,
        url,
        chunks: [],
        glossary: { ...rollingGlossary },
        error: null,
        savedChapterId: null
      });

      try {
        batchJob.currentStatus = 'translating';
        await runTranslationJob(jobId, url, { novelId, chapterNumber: chapterNum, chapterTitle });
        const finishedJob = jobs.get(jobId);
        if (finishedJob && finishedJob.savedChapterId) {
          batchJob.savedChapterIds.push(finishedJob.savedChapterId);
        }
        // สืบทอด glossary จากตอนที่เพิ่งแปลเสร็จ
        if (finishedJob && finishedJob.glossary) {
          rollingGlossary = { ...finishedJob.glossary };
        }
        batchJob.done++;
        console.log(`[Batch] ✓ ตอน ${i + 1}/${urls.length} แปลสำเร็จ (${url})`);
      } catch (err) {
        batchJob.failed++;
        batchJob.errors.push({ index: i, url, error: err.message });
        console.error(`[Batch] ✗ ตอน ${i + 1}/${urls.length} ล้มเหลว: ${err.message}`);
        // ยังคงแปลตอนถัดไปต่อ
      }
      batchJob.currentStatus = 'done';
    }
    batchJob.status = batchJob.failed > 0 && batchJob.done === 0 ? 'error' : 'done';
    console.log(`[Batch] เสร็จสิ้น ${batchJob.done}/${urls.length} ตอน, ล้มเหลว ${batchJob.failed} ตอน`);
  })().catch(err => {
    batchJob.status = 'error';
    batchJob.errors.push({ error: err.message });
  });
});

// ---------- API: ข้อมูลนิยาย (Novels CRUD) ----------
app.get('/api/novels', (req, res) => {
  try {
    const novels = db.getNovels();
    res.json(novels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/novels', (req, res) => {
  try {
    const { title, author, description } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'กรุณาระบุชื่อเรื่อง' });
    }
    const id = db.createNovel({ title, author, description });
    res.json({ id, message: 'สร้างนิยายสำเร็จ' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/novels/:id', (req, res) => {
  try {
    const novel = db.getNovelById(req.params.id);
    if (!novel) return res.status(404).json({ error: 'ไม่พบนิยายเรื่องนี้' });
    res.json(novel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/novels/:id', (req, res) => {
  try {
    db.deleteNovel(req.params.id);
    res.json({ success: true, message: 'ลบนิยายเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: ตอนนิยาย (Chapters) ----------
app.get('/api/chapters/:id', (req, res) => {
  try {
    const chapter = db.getChapterById(req.params.id);
    if (!chapter) return res.status(404).json({ error: 'ไม่พบตอนนี้' });
    res.json(chapter);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chapters/:id', (req, res) => {
  try {
    db.deleteChapter(req.params.id);
    res.json({ success: true, message: 'ลบตอนเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: ศัพท์เฉพาะประจำเรื่อง (Glossary) ----------
app.get('/api/novels/:id/glossary', (req, res) => {
  try {
    const glossary = db.getNovelGlossary(req.params.id);
    res.json(glossary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/novels/:id/glossary', (req, res) => {
  try {
    const { terms } = req.body;
    db.saveNovelGlossary(req.params.id, terms || {});
    res.json({ success: true, message: 'บันทึกคำศัพท์เรียบร้อย' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
