require('dotenv').config();

async function testFewShot() {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

  const testTexts = [
    `'Please, Ananke, I am trying not to cry here.' He answered, irritated, lifting his head to stare at his siblings. 'This is not the time for stupid questions.'\n\nThe Goddess scoffed.\n\n"Back with us, Youngest?" Lucian spoke again, still smiling freely, as if he hadn't just nearly broken both his brother's arms.`,
    `She raised her right hand overhead. A small creature made of shadow spawned — resembling a rat — then transformed into a long black scimitar.\n\nCassius cursed.`,
    `"Then begin." He ordered, turning back to the window. "Undress yourself and lie down on the bed."`
  ];

  console.log('Testing Few-Shot Translation...');

  for (let i = 0; i < testTexts.length; i++) {
    console.log(`\n--- Few-Shot Test Chunk ${i + 1} ---`);
    const prompt = `<|im_start|>system
You are a professional English to Thai webnovel translator. You translate English novels into natural, literary Thai.
NEVER use Chinese characters. Output 100% Thai script only.

Example:
English: The dragon roared and unleashed a torrent of fire. Cassius drew his blade.
Thai: มังกรคำรามกึกก้องและพ่นสายธารเพลิงออกมา คาสซิอุสชักดาบของเขาออกมา
<|im_end|>
<|im_start|>user
Translate the following English novel text into natural Thai prose:

"""
${testTexts[i]}
"""

Respond in JSON format:
{"translation": "ข้อความภาษาไทยล้วน", "newTerms": {}}
<|im_end|>
<|im_start|>assistant
{"translation": "`;

    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 500,
          stop: ['<|im_end|>', '<|endoftext|>']
        }
      })
    });
    const data = await res.json();
    console.log('Result:\n', data.response);
    const hasChinese = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(data.response);
    console.log('Contains Chinese?:', hasChinese);
  }
}

testFewShot();
