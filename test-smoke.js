require('dotenv').config();
const { Pool } = require('pg');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

async function runSmokeTest() {
  console.log('🧪 Starting Novel Translator Smoke Test...\n');
  let passed = 0;
  let total = 0;

  // 1. PostgreSQL Connection
  total++;
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set in environment');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const res = await pool.query('SELECT NOW() as current_time, count(*) as count FROM novels');
    console.log(`✅ [1/4] PostgreSQL: Connected successfully (${res.rows[0].count} novels in DB)`);
    await pool.end();
    passed++;
  } catch (err) {
    console.error('❌ [1/4] PostgreSQL failed:', err.message);
  }

  // 2. Ollama Connectivity & Model Check
  total++;
  try {
    const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
    const tagsRes = await fetch(`${baseUrl}/api/tags`);
    if (!tagsRes.ok) throw new Error(`Ollama returned status ${tagsRes.status}`);
    const tags = await tagsRes.json();
    const hasModel = tags.models && tags.models.some(m => m.name === model || m.name.startsWith(model.split(':')[0]));
    if (!hasModel) throw new Error(`Model ${model} not found in Ollama`);
    console.log(`✅ [2/4] Ollama: Connected, model "${model}" is ready`);
    passed++;
  } catch (err) {
    console.error('❌ [2/4] Ollama failed:', err.message);
  }

  // 3. Edge TTS Check
  total++;
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata('th-TH-PremwadeeNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream('ทดสอบเสียง', { rate: '+0%' });
    await new Promise((resolve, reject) => {
      audioStream.once('data', () => resolve());
      audioStream.once('error', reject);
    });
    console.log('✅ [3/4] MsEdgeTTS: Voice stream generated successfully');
    passed++;
  } catch (err) {
    console.error('❌ [3/4] MsEdgeTTS failed:', err.message);
  }

  // 4. Data Access Layer Check
  total++;
  try {
    const db = require('./db-postgres.js');
    if (typeof db.getNovels !== 'function') throw new Error('db.getNovels is not a function');
    console.log('✅ [4/4] Data Layer: db-postgres.js loaded cleanly');
    passed++;
  } catch (err) {
    console.error('❌ [4/4] Data Layer failed:', err.message);
  }

  console.log(`\n📊 Smoke Test Result: ${passed}/${total} passed\n`);
  if (passed < total) process.exit(1);
}

runSmokeTest();
