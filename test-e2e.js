require('dotenv').config();
const db = require('./db-postgres.js');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

async function testE2E() {
  console.log('🚀 Running End-to-End Test (Translate -> PostgreSQL -> TTS)...\n');
  let testNovelId = null;

  try {
    // 1. Create a test novel in PostgreSQL
    console.log('📌 [Step 1] Creating test novel in PostgreSQL...');
    testNovelId = await db.createNovel({
      title: 'E2E Test Novel - ' + Date.now(),
      author: 'Test Author',
      description: 'Automated E2E Verification'
    });
    console.log(`✅ Novel created with ID: ${testNovelId}`);

    // 2. Call Ollama directly with a sample chapter paragraph
    console.log('\n📌 [Step 2] Translating sample English paragraph with Ollama...');
    const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
    
    const sampleEnglish = "Cassius smiled as the morning sun broke through the misty clouds. His journey was only beginning, yet his heart felt light.";
    
    const prompt = `คุณคือนักแปลและบรรณาธิการนิยายภาษาไทยมืออาชีพ แปลข้อความภาษาอังกฤษต่อไปนี้เป็นภาษาไทย:
- ภาษาเป้าหมาย: ภาษาไทยเท่านั้น ห้ามใช้ภาษาจีนหรือภาษาอื่น
- สำนวนสละสลวย เป็นธรรมชาติ

ตอบเป็น JSON เท่านั้น:
{"translation":"ข้อความภาษาไทย","newTerms":{"Cassius":"คาสซิอุส"}}

SOURCE:
"""
${sampleEnglish}
"""`;

    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.3 }
      })
    });

    if (!res.ok) throw new Error(`Ollama returned status ${res.status}`);
    const data = await res.json();
    let parsed;
    try {
      parsed = JSON.parse(data.response);
    } catch {
      parsed = { translation: data.response, newTerms: {} };
    }

    const translatedThai = parsed.translation || data.response;
    console.log(`✅ Translation output: "${translatedThai.trim()}"`);
    console.log(`✅ Glossary terms extracted:`, parsed.newTerms || {});

    // 3. Save chapter and glossary to PostgreSQL
    console.log('\n📌 [Step 3] Saving chapter & glossary to PostgreSQL...');
    const chapterId = await db.createChapter({
      novel_id: testNovelId,
      chapter_number: 1,
      title: 'Chapter 1: The Beginning',
      source_url: 'https://example.com/test-chapter-1',
      chunks: [{ en: sampleEnglish, th: translatedThai }]
    });
    console.log(`✅ Chapter saved with ID: ${chapterId}`);

    if (parsed.newTerms && Object.keys(parsed.newTerms).length > 0) {
      await db.saveNovelGlossary(testNovelId, parsed.newTerms);
      console.log('✅ Glossary terms saved to DB');
    }

    // 4. Retrieve chapter from PostgreSQL and verify integrity
    console.log('\n📌 [Step 4] Retrieving chapter from PostgreSQL...');
    const chapter = await db.getChapterById(chapterId);
    if (!chapter || !chapter.chunks || chapter.chunks.length === 0) {
      throw new Error('Retrieved chapter is empty or missing chunks');
    }
    console.log(`✅ Chapter retrieved successfully: "${chapter.title}" with ${chapter.chunks.length} chunk(s)`);

    // 5. Test Edge TTS generation on the translated Thai text
    console.log('\n📌 [Step 5] Testing MsEdgeTTS on translated Thai text...');
    const tts = new MsEdgeTTS();
    await tts.setMetadata('th-TH-PremwadeeNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(translatedThai, { rate: '+0%' });

    let receivedAudioBytes = 0;
    await new Promise((resolve, reject) => {
      audioStream.on('data', chunk => { receivedAudioBytes += chunk.length; });
      audioStream.on('end', () => resolve());
      audioStream.on('error', reject);
    });
    console.log(`✅ TTS Audio generated successfully: ${receivedAudioBytes} bytes received`);

    // 6. Clean up test novel
    console.log('\n📌 [Step 6] Cleaning up test novel from PostgreSQL...');
    await db.deleteNovel(testNovelId);
    console.log(`✅ Test novel ID ${testNovelId} cleaned up`);

    console.log('\n🎉 ALL END-TO-END TESTS PASSED SUCCESSFULLY! 🎉\n');
  } catch (err) {
    console.error('\n❌ E2E Test Failed:', err.message);
    if (testNovelId) {
      try { await db.deleteNovel(testNovelId); } catch {}
    }
    process.exit(1);
  } finally {
    await db.close();
  }
}

testE2E();
