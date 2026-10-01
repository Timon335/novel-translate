require('dotenv').config();

async function testFix() {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

  const chunk = `She raised her right hand overhead. A small creature made of shadow spawned — resembling a rat — then transformed into a long black scimitar.\n\nCassius cursed.`;

  console.log('Testing with /api/chat and explicit system prompt...');

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert English-to-Thai novel translator. Target language is THAI ONLY (ภาษาไทย). You are STRICTLY FORBIDDEN from using any Chinese characters (汉字/中文). Every single word must be translated into fluent, natural Thai.'
        },
        {
          role: 'user',
          content: `แปลข้อความนิยายภาษาอังกฤษต่อไปนี้เป็นภาษาไทยที่สละสลวย เป็นธรรมชาติ (ห้ามมีภาษาจีนเด็ดขาด):\n\n"""\n${chunk}\n"""\n\nตอบในรูปแบบ JSON:\n{"translation":"ข้อความภาษาไทยล้วน","newTerms":{}}`
        }
      ],
      stream: false,
      format: 'json',
      options: {
        temperature: 0.3
      }
    })
  });

  const data = await res.json();
  const content = data.message ? data.message.content : '';
  console.log('Chat API Result:\n', content);
  const hasChinese = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(content);
  console.log('Contains Chinese?:', hasChinese);
}

testFix();
