require('dotenv').config();

async function testRepair() {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

  const mixedText = `เธอ举右手过头顶。一个由阴影构成的小生物出现——形似老鼠——然后变成一把长长的黑色弯刀。\n\nแคสซิอุสสบถ`;

  console.log('Testing Chinese cleanup/translation to Thai...');

  const prompt = `ข้อความด้านล่างมีภาษาจีนปนอยู่ ให้แปลส่วนที่เป็นภาษาจีนทั้งหมดให้เป็นภาษาไทยที่ถูกต้องและเป็นธรรมชาติ:
- ข้อความเดิม:
"${mixedText}"

- ตอบเฉพาะข้อความภาษาไทยที่แก้ไขสมบูรณ์แล้วเท่านั้น ห้ามมีภาษาจีนเหลือแม้แต่ตัวเดียว ห้ามมีคำอธิบายอื่น:`;

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.2 }
    })
  });

  const data = await res.json();
  console.log('Repaired Result:\n', data.response);
  console.log('Contains Chinese?:', /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(data.response));
}

testRepair();
