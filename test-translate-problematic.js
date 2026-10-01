require('dotenv').config();

async function test() {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

  const testTexts = [
    `'Please, Ananke, I am trying not to cry here.' He answered, irritated, lifting his head to stare at his siblings. 'This is not the time for stupid questions.'\n\nThe Goddess scoffed.\n\n"Back with us, Youngest?" Lucian spoke again, still smiling freely, as if he hadn't just nearly broken both his brother's arms.`,
    `She raised her right hand overhead. A small creature made of shadow spawned — resembling a rat — then transformed into a long black scimitar.\n\nCassius cursed.`,
    `"Then begin." He ordered, turning back to the window. "Undress yourself and lie down on the bed."`
  ];

  for (let i = 0; i < testTexts.length; i++) {
    console.log(`\n--- Test Chunk ${i + 1} ---`);
    const prompt = `คุณคือนักแปลและบรรณาธิการนิยายภาษาไทยมืออาชีพ แปลข้อความภาษาอังกฤษต่อไปนี้เป็นภาษาไทย:
- กฎเด็ดขาด: แปลเป็นภาษาไทยล้วน 100% ห้ามมีตัวอักษรจีน (Chinese characters / 汉字) หรือภาษาอื่นปนเด็ดขาด แม้แต่ตัวเดียวก็ห้าม
- แปลสำนวนสละสลวย เป็นธรรมชาติ คงอารมณ์ตัวละครและการเว้นบรรทัด
- ตอบเป็น JSON เท่านั้น: {"translation":"ข้อความภาษาไทย","newTerms":{}}

SOURCE:
"""
${testTexts[i]}
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
    const data = await res.json();
    console.log('Response:', data.response);
    const hasChinese = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(data.response);
    console.log('Contains Chinese?:', hasChinese);
  }
}

test();
