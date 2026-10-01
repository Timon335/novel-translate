require('dotenv').config();
const express = require('express');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const db = require('./db-postgres.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);
// Local 14B models can take several minutes per chunk on CPU or low-memory GPUs.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 600000);
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 30000);
const MAX_HTML_BYTES = Number(process.env.MAX_HTML_BYTES || 10 * 1024 * 1024);
const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || 100);
const JOB_RETENTION_MS = Number(process.env.JOB_RETENTION_MS || 60 * 60 * 1000);

// เก็บสถานะงานแปลแต่ละงานไว้ใน memory
const jobs = new Map();

function validateHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error('ลิงก์ไม่ถูกต้อง');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('รองรับเฉพาะลิงก์ http หรือ https เท่านั้น');
  }
  if (parsed.username || parsed.password) {
    throw new Error('ลิงก์ต้องไม่มี username หรือ password');
  }
  return parsed.toString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`การเชื่อมต่อหมดเวลา (${timeoutMs / 1000} วินาที)`);
    const code = error.cause?.code ? ` (${error.cause.code})` : '';
    throw new Error(`${error.message || 'การเชื่อมต่อล้มเหลว'}${code}`);
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleJobCleanup(jobId) {
  setTimeout(() => jobs.delete(jobId), JOB_RETENTION_MS).unref();
}

// ---------- ส่วนที่ 1: ดึงเนื้อหานิยายจากลิงก์ (กรองปุ่ม เมนู คอมเมนต์ ออกอย่างหมดจด) ----------
async function scrapeNovelText(url) {
  const safeUrl = validateHttpUrl(url);
  let res;
  try {
    res = await fetchWithTimeout(safeUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
  } catch (err) {
    throw new Error(`เชื่อมต่อเว็บนิยายไม่สำเร็จ: ${err.message}`);
  }
  if (!res.ok) throw new Error(`เปิดลิงก์ไม่ได้ (HTTP ${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_HTML_BYTES) {
    throw new Error(`หน้าเว็บมีขนาดใหญ่เกินไป (จำกัด ${Math.round(MAX_HTML_BYTES / 1024 / 1024)} MB)`);
  }
  const html = buffer.toString('utf8');
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

function selectEnglishSourceText(text) {
  const paragraphs = text.split(/\n\n+/).map(paragraph => paragraph.trim()).filter(Boolean);
  const englishParagraphs = paragraphs.filter(paragraph => {
    const englishCount = (paragraph.match(/[A-Za-z]/g) || []).length;
    const thaiCount = (paragraph.match(/[\u0E00-\u0E7F]/g) || []).length;
    const cjkCount = (paragraph.match(/[\u3400-\u9FFF]/g) || []).length;
    const nonEnglishCount = thaiCount + cjkCount;
    return englishCount >= 12 && englishCount >= nonEnglishCount;
  });

  return englishParagraphs.length >= 2 ? englishParagraphs.join('\n\n') : text;
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

// ใช้โมเดลเดียวจาก Ollama ซึ่งทำงานในเครื่องหรือ Cloud ตาม OLLAMA_BASE_URL
const ALL_MODELS = [OLLAMA_MODEL];
let _lastWorkingModelIndex = 0;

function parseRetryDelay(errMsg) {
  const match = errMsg.match(/Please retry in ([\d.]+)s/);
  if (match) return Math.ceil(parseFloat(match[1])) * 1000 + 500;
  return null;
}

async function callOllamaAPI(model, prompt) {
  await waitForRateLimit();
  const url = `${OLLAMA_BASE_URL}/api/generate`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
        // Lower randomness keeps names, meaning, and sentence-level decisions consistent.
        options: { temperature: 0.3 }
      })
    }, OLLAMA_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`เชื่อมต่อ Ollama ที่ ${OLLAMA_BASE_URL} ไม่สำเร็จ: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, data: { error: { message: data.error || `HTTP ${res.status}` } } };
  }
  return {
    ok: true,
    status: res.status,
    data: { candidates: [{ content: { parts: [{ text: data.response || '' }] } }] }
  };
}

function filterGlossaryTerms(terms = {}) {
  const filtered = {};
  for (const [english, thai] of Object.entries(terms || {})) {
    const englishText = String(english).trim();
    const thaiText = String(thai).trim();
    const hasEnglish = /[A-Za-z]/.test(englishText);
    const hasCjk = /[\u3400-\u9FFF]/.test(englishText) || /[\u3400-\u9FFF]/.test(thaiText);
    const hasThai = /[\u0E00-\u0E7F]/.test(thaiText);
    if (hasEnglish && hasThai && !hasCjk && englishText.length <= 80 && thaiText.length <= 80) {
      filtered[englishText] = thaiText;
    }
  }
  return filtered;
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
          Object.assign(newTerms, filterGlossaryTerms({ [en]: th }));
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
        newTerms: filterGlossaryTerms(parsed.newTerms || {})
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
          if (m) Object.assign(newTerms, filterGlossaryTerms({ [m[1]]: m[2] }));
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

// ตรวจว่าผลลัพธ์มีภาษาจีนปนมากเกินไปหรือไม่
function hasTooMuchChinese(text) {
  const chineseCount = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
  const thaiCount = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  return chineseCount > 5 && chineseCount > thaiCount * 0.3;
}

// กรอง glossary เฉพาะคำที่ปรากฏใน chunk นั้นจริงๆ (ประหยัด token)
function filterRelevantGlossary(glossary, chunkText) {
  const relevant = {};
  for (const [en, th] of Object.entries(glossary)) {
    if (chunkText.toLowerCase().includes(en.toLowerCase())) {
      relevant[en] = th;
    }
  }
  return relevant;
}

function isUsableThaiTranslation(sourceText, translation) {

  if (!translation || translation.trim().length < 10) return false;
  const sourceEnglishCount = (sourceText.match(/[A-Za-z]/g) || []).length;
  const translationThaiCount = (translation.match(/[\u0E00-\u0E7F]/g) || []).length;
  const translationEnglishCount = (translation.match(/[A-Za-z]/g) || []).length;
  const minimumThaiCount = Math.max(10, Math.min(40, Math.floor(sourceEnglishCount * 0.04)));
  return translationThaiCount >= minimumThaiCount && translationThaiCount >= translationEnglishCount;
}

async function translateChunk(chunkText, glossary) {
  if (!OLLAMA_MODEL) {
    throw new Error('ยังไม่ได้ตั้งค่า OLLAMA_MODEL ในไฟล์ .env');
  }

  // กรองเฉพาะ glossary ที่ปรากฏใน chunk นี้ (ประหยัด token)
  const relevantGlossary = filterRelevantGlossary(glossary, chunkText);
  const glossaryEntries = Object.entries(relevantGlossary);
  const glossaryText = glossaryEntries.length
    ? `\n\nคำศัพท์/ชื่อเฉพาะที่กำหนดไว้ (ต้องแปลให้ตรงตามนี้):\n${glossaryEntries.map(([en, th]) => `- ${en} = ${th}`).join('\n')}`
    : '';

  const prompt = `คุณคือนักแปลวรรณกรรมนิยายภาษาอังกฤษเป็นภาษาไทย และเป็นบรรณาธิการภาษาไทยเจ้าของภาษา
จงแปลต้นฉบับด้านล่างให้ครบถ้วน ซื่อตรงต่อความหมาย และอ่านเป็นนิยายไทยที่ลื่นไหลเป็นธรรมชาติ

แนวทางการแปล:
- ถ่ายทอดความหมาย น้ำเสียง อารมณ์ บรรยากาศ มุมมองผู้เล่า และบุคลิกของตัวละครให้ตรงต้นฉบับ
- เขียนไทยให้เป็นธรรมชาติ ไม่เรียงคำตามไวยากรณ์อังกฤษ ไม่ใช้สำนวนแปลตรงตัวที่ฟังแข็ง
- ตรวจรายละเอียดให้ตรงทุกจุด โดยเฉพาะเวลา จำนวน การปฏิเสธ เหตุและผล ผู้กระทำ/ผู้ถูกกระทำ และคำนามนามธรรม อย่าสลับความหมายหรือทำข้อมูลตกหล่น
- ถอดสำนวนเปรียบเทียบเป็นสำนวนไทยที่สื่อความหมายเดียวกัน เช่น การทรยศให้ใช้ “หักหลัง” แทนการแปลภาพคำต่อคำ
- รักษาระดับภาษาและน้ำเสียงบทสนทนาของแต่ละตัวละครให้สม่ำเสมอ รวมถึงสรรพนามและคำเรียก
- แปลสำนวน มุก คำเปรียบเทียบ และนัยตามบริบทให้ผู้อ่านไทยเข้าใจ โดยไม่แต่งข้อมูลเพิ่ม
- ห้ามตัด ย่อ สรุป ขยายความ หรือเติมรายละเอียดที่ต้นฉบับไม่มี
- แปลประโยคและคำบรรยายเป็นไทยทั้งหมด คงภาษาอังกฤษไว้เฉพาะชื่อเฉพาะ ตัวย่อ หรือศัพท์ระบบที่จำเป็นจริงๆ ห้ามมีประโยคภาษาอังกฤษจากต้นฉบับหลงเหลือ
- ใช้คำเรียกศัพท์ระบบและชื่อเฉพาะให้ตรงกับ glossary และสม่ำเสมอภายในข้อความ
- ห้ามมีอักษรจีนหรือญี่ปุ่นหลงมาแทนคำแปล
- คงลำดับเนื้อหาและจำนวนย่อหน้าให้ตรงต้นฉบับ โดยคั่นแต่ละย่อหน้าด้วยบรรทัดว่าง
- ตรวจความครบถ้วน ความหมาย การสะกด และความลื่นไหลก่อนตอบ
- ตอบเป็น JSON เท่านั้น ห้ามมี Markdown คำนำ หรือคำอธิบาย${glossaryText}

ตอบเป็น JSON เท่านั้น ห้ามมี Markdown:
{"translation":"ข้อความภาษาไทยที่แปลและตรวจสอบแล้ว","newTerms":{"English name":"ชื่อไทย"}}
ถ้าไม่พบชื่อใหม่ให้ newTerms เป็น {}

SOURCE:
"""
${chunkText}
"""`;

  // เรียงโมเดลให้เริ่มจากโมเดลที่สำเร็จล่าสุด
  const orderedModels = [
    ...ALL_MODELS.slice(_lastWorkingModelIndex),
    ...ALL_MODELS.slice(0, _lastWorkingModelIndex)
  ];

  let lastError = null;

  // รอบแรก: ลองทุกโมเดล
  for (let mi = 0; mi < orderedModels.length; mi++) {
    const model = orderedModels[mi];
    try {
      const { ok, status, data } = await callOllamaAPI(model, prompt);
      if (ok) {
        _lastWorkingModelIndex = ALL_MODELS.indexOf(model);
        const result = parseGeminiResponse(data);

        // ตรวจจับภาษาจีนปน → retry ด้วย prompt เข้มข้นกว่า
        if (hasTooMuchChinese(result.translation)) {
          console.warn(`[Ollama] ${model} ส่งภาษาจีนมา — retry ด้วย prompt เข้มข้นกว่า`);
          const retryPrompt = prompt.replace(
            'ห้ามเขียนคำนำหรือคำอธิบายใดๆ',
            '⚠️ ห้ามตอบเป็นภาษาจีนโดยเด็ดขาด ตอบเป็นภาษาไทยเท่านั้น ห้ามเขียนคำนำหรือคำอธิบายใดๆ'
          );
          const { ok: ok2, data: data2 } = await callOllamaAPI(model, retryPrompt);
          if (ok2) {
            const result2 = parseGeminiResponse(data2);
            if (!hasTooMuchChinese(result2.translation) && isUsableThaiTranslation(chunkText, result2.translation)) {
              console.log(`[Ollama] ✓ retry สำเร็จ ไม่มีภาษาจีนแล้ว`);
              return result2;
            }
          }
          lastError = new Error('ผลลัพธ์มีภาษาจีนปน');
          continue;
        }

        if (isUsableThaiTranslation(chunkText, result.translation)) {
          console.log(`[Ollama] ✓ แปลสำเร็จด้วย ${model}`);
          return result;
        }
        console.warn(`[Ollama] ${model} ส่งคำแปลไม่ครบ — ลองโมเดลถัดไป`);
        lastError = new Error('คำแปลภาษาไทยไม่ครบถ้วน');
      } else {
        const errMsg = data?.error?.message || `HTTP ${status}`;
        lastError = new Error(errMsg);
      }
    } catch (err) {
      lastError = err;
    }
  }

  // รอบสอง: ลองใหม่อีกครั้ง
  console.warn('[Ollama] เรียกโมเดลไม่สำเร็จ — กำลังลองใหม่...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  _lastApiCallTime = 0;

  for (const model of ALL_MODELS) {
    try {
      const { ok, status, data } = await callOllamaAPI(model, prompt);
      if (ok) {
        _lastWorkingModelIndex = ALL_MODELS.indexOf(model);
        const result = parseGeminiResponse(data);
        if (!hasTooMuchChinese(result.translation) && isUsableThaiTranslation(chunkText, result.translation)) {
          console.log(`[Ollama] ✓ แปลสำเร็จ (หลังลองใหม่) ด้วย ${model}`);
          return result;
        }
      }
      lastError = new Error(data?.error?.message || `HTTP ${status}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Ollama ไม่พร้อมใช้งาน กรุณาตรวจสอบว่า Ollama กำลังทำงานอยู่');
}

// ---------- API: แปลด่วน (Quick Translate) ----------
app.post('/api/translate-book', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'กรุณาส่งลิงก์มาด้วย' });
  try {
    validateHttpUrl(url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'scraping', chunks: [], glossary: {}, error: null, savedChapterId: null });
  res.json({ jobId });

  runTranslationJob(jobId, url).catch(err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
      scheduleJobCleanup(jobId);
    }
  });
});

// ---------- API: แปลตอนใหม่และบันทึกลง Database ของนิยาย ----------
app.post('/api/novels/:id/chapters/translate', async (req, res) => {
  const novelId = parseInt(req.params.id, 10);
  const novel = await db.getNovelById(novelId);
  if (!novel) return res.status(404).json({ error: 'ไม่พบนิยายเรื่องนี้' });

  const { url, chapter_number, title } = req.body;
  if (!url) return res.status(400).json({ error: 'กรุณาส่งลิงก์มาด้วย' });
  try {
    validateHttpUrl(url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const jobId = crypto.randomUUID();
  // ดึงคำศัพท์ที่เคยบันทึกไว้ในนิยายเรื่องนี้มาใช้เริ่มต้น
  const existingGlossary = await db.getNovelGlossary(novelId);
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
      scheduleJobCleanup(jobId);
    }
  });
});

// ---------- ส่วนที่ 4: ตรวจสอบและแก้ไขคำภาษาไทย ----------
async function proofreadThai(sourceText, translatedText) {
  const thaiCount = (translatedText.match(/[\u0E00-\u0E7F]/g) || []).length;
  if (thaiCount < 10) return translatedText;

  const prompt = `คุณคือบรรณาธิการนิยายแปลภาษาไทย เปรียบเทียบคำแปลกับต้นฉบับแล้วแก้ให้ถูกต้อง อ่านเป็นธรรมชาติ และครบถ้วน
- ตรวจว่าคำแปลรักษารายละเอียดทุกจุดจากต้นฉบับ โดยเฉพาะเวลา จำนวน การปฏิเสธ เหตุและผล ผู้กระทำ/ผู้ถูกกระทำ และความหมายของคำ
- แก้คำแปลผิดหรือตกหล่นโดยอ้างอิงต้นฉบับ ห้ามเดา เติมเหตุการณ์ หรือเปลี่ยนข้อเท็จจริง
- แก้คำสะกด วรรคตอน การเว้นวรรค ไวยากรณ์ และสำนวนที่แข็งหรือแปลตรงตัว ให้เป็นภาษาไทยนิยายที่ลื่นไหล
- ถอดสำนวนอังกฤษตามความหมายเป็นสำนวนไทย ห้ามแปลภาพคำต่อคำจนผิดธรรมชาติ
- แปลประโยคภาษาอังกฤษที่หลงเหลือเป็นไทย แต่คงชื่อเฉพาะ ตัวย่อ หรือศัพท์ระบบที่จำเป็นไว้
- ห้ามตัด ย่อ สรุป หรือเพิ่มเนื้อหา และคงน้ำเสียง มุมมอง บุคลิกตัวละคร สรรพนาม คำเรียก และโครงสร้างย่อหน้า
- ตอบเป็น JSON เท่านั้นในรูปแบบ {"translation":"ข้อความที่แก้ไขแล้ว","newTerms":{}} ห้ามมี Markdown หรือคำอธิบายเพิ่มเติม

ต้นฉบับภาษาอังกฤษ:
"""
${sourceText}
"""

คำแปลภาษาไทย:
"""
${translatedText}
"""`;

  const orderedModels = [
    ...ALL_MODELS.slice(_lastWorkingModelIndex),
    ...ALL_MODELS.slice(0, _lastWorkingModelIndex)
  ];

  for (const model of orderedModels) {
    try {
      const { ok, data } = await callOllamaAPI(model, prompt);
      if (ok) {
        const parsed = parseGeminiResponse(data);
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let corrected = parsed.translation || '';
        if (!corrected && rawText) {
          try {
            const rawJson = JSON.parse(rawText);
            corrected = rawJson.translation || rawJson.text_corrected || '';
          } catch {
            corrected = rawText;
          }
        }
        return corrected.trim() || translatedText; // fallback to original if empty
      }
    } catch { /* ลองโมเดลถัดไป */ }
  }
  return translatedText; // ถ้าตรวจไม่ได้ ให้คืนต้นฉบับ
}

async function runTranslationJob(jobId, url, novelMeta = null) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('ไม่พบงานแปลนี้');
  const rawText = await scrapeNovelText(url);
  const sourceText = selectEnglishSourceText(rawText);
  const textChunks = splitIntoChunks(sourceText, 1400);

  job.status = 'translating';
  job.total = textChunks.length;

  for (let i = 0; i < textChunks.length; i++) {
    const result = await translateChunk(textChunks[i], job.glossary);
    Object.assign(job.glossary, result.newTerms);
    job.chunks.push({ en: textChunks[i], th: result.translation });
  }

  job.status = 'proofreading';
  job.proofreadTotal = job.chunks.length;
  job.proofreadDone = 0;
  for (const chunk of job.chunks) {
    chunk.th = await proofreadThai(chunk.en, chunk.th);
    job.proofreadDone++;
  }

  // บันทึกตอนและ glossary ใน transaction เดียวกันเพื่อไม่ให้ข้อมูลค้างครึ่งหนึ่ง
  if (novelMeta && novelMeta.novelId) {
    const chapterId = await db.createChapter({
      novel_id: novelMeta.novelId,
      chapter_number: novelMeta.chapterNumber,
      title: novelMeta.chapterTitle,
      source_url: url,
      chunks: job.chunks,
      glossary: job.glossary
    });
    job.savedChapterId = chapterId;
    console.log(`[Database] บันทึกตอนสำเร็จ ID: ${chapterId} เข้าเรื่อง ID: ${novelMeta.novelId}`);
  }

  job.status = 'done';
  scheduleJobCleanup(jobId);
}

// ---------- API: แปลหลายตอนพร้อมกัน (Batch Translate) ----------
app.post('/api/novels/:id/chapters/batch-translate', async (req, res) => {
  const novelId = parseInt(req.params.id, 10);
  const novel = await db.getNovelById(novelId);
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
  if (endId - startId + 1 > MAX_BATCH_SIZE) {
    return res.status(400).json({ error: `Batch จำกัดไม่เกิน ${MAX_BATCH_SIZE} ตอนต่อครั้ง` });
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
    const existingGlossary = await db.getNovelGlossary(novelId);
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
        const failedJob = jobs.get(jobId);
        if (failedJob) {
          failedJob.status = 'error';
          failedJob.error = err.message;
          scheduleJobCleanup(jobId);
        }
        batchJob.failed++;
        batchJob.errors.push({ index: i, url, error: err.message });
        console.error(`[Batch] ✗ ตอน ${i + 1}/${urls.length} ล้มเหลว: ${err.message}`);
        // ยังคงแปลตอนถัดไปต่อ
      }
      batchJob.currentStatus = 'done';
    }
    batchJob.status = batchJob.failed > 0 && batchJob.done === 0 ? 'error' : 'done';
    scheduleJobCleanup(batchJobId);
    console.log(`[Batch] เสร็จสิ้น ${batchJob.done}/${urls.length} ตอน, ล้มเหลว ${batchJob.failed} ตอน`);
  })().catch(err => {
    batchJob.status = 'error';
    batchJob.errors.push({ error: err.message });
    scheduleJobCleanup(batchJobId);
  });
});

// ---------- API: ข้อมูลนิยาย (Novels CRUD) ----------
app.get('/api/novels', async (req, res) => {
  try {
    const novels = await db.getNovels();
    res.json(novels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/novels', async (req, res) => {
  try {
    const { title, author, description } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'กรุณาระบุชื่อเรื่อง' });
    }
    const id = await db.createNovel({ title, author, description });
    res.json({ id, message: 'สร้างนิยายสำเร็จ' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/novels/:id', async (req, res) => {
  try {
    const novel = await db.getNovelById(req.params.id);
    if (!novel) return res.status(404).json({ error: 'ไม่พบนิยายเรื่องนี้' });
    res.json(novel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/novels/:id', async (req, res) => {
  try {
    await db.deleteNovel(req.params.id);
    res.json({ success: true, message: 'ลบนิยายเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: ตอนนิยาย (Chapters) ----------
app.get('/api/chapters/:id', async (req, res) => {
  try {
    const chapter = await db.getChapterById(req.params.id);
    if (!chapter) return res.status(404).json({ error: 'ไม่พบตอนนี้' });
    res.json(chapter);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chapters/:id', async (req, res) => {
  try {
    await db.deleteChapter(req.params.id);
    res.json({ success: true, message: 'ลบตอนเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: ศัพท์เฉพาะประจำเรื่อง (Glossary) ----------
app.get('/api/novels/:id/glossary', async (req, res) => {
  try {
    const glossary = await db.getNovelGlossary(req.params.id);
    res.json(glossary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/novels/:id/glossary', async (req, res) => {
  try {
    const { terms } = req.body;
    await db.saveNovelGlossary(req.params.id, terms || {});
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
  if (String(text).length > 20000) return res.status(400).json({ error: 'ข้อความยาวเกินไป (จำกัด 20,000 ตัวอักษร)' });
  const allowedVoices = new Set(['th-TH-PremwadeeNeural', 'th-TH-NiwatNeural']);
  if (voice && !allowedVoices.has(voice)) return res.status(400).json({ error: 'ไม่รองรับเสียงนี้' });
  if (rate && !/^[+-](?:[0-9]|[1-9][0-9]|100)%$/.test(rate)) return res.status(400).json({ error: 'อัตราความเร็วไม่ถูกต้อง' });

  try {
    res.setTimeout(TTS_TIMEOUT_MS, () => res.destroy(new Error('การสร้างเสียงหมดเวลา')));
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
