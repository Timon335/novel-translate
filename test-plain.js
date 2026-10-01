require('dotenv').config();

async function testPlain() {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

  const chunk = `She raised her right hand overhead. A small creature made of shadow spawned — resembling a rat — then transformed into a long black scimitar.\n\nCassius cursed.`;

  console.log('Testing plain text (no json mode)...');

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a professional literary translator. Your job is to translate English novels into Thai (ภาษาไทย). You must NEVER write in Chinese (中文). Only write in natural Thai.'
        },
        {
          role: 'user',
          content: `แปลข้อความเป็นภาษาไทยโดยตรง ไม่ต้องมีคำอธิบาย:\n\n${chunk}`
        }
      ],
      stream: false,
      options: {
        temperature: 0.3
      }
    })
  });

  const data = await res.json();
  const content = data.message ? data.message.content : '';
  console.log('Result:\n', content);
  const hasChinese = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(content);
  console.log('Contains Chinese?:', hasChinese);
}

testPlain();
