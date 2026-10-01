require('dotenv').config();

async function testEnPrompt() {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

  const testTexts = [
    `'Please, Ananke, I am trying not to cry here.' He answered, irritated, lifting his head to stare at his siblings. 'This is not the time for stupid questions.'\n\nThe Goddess scoffed.\n\n"Back with us, Youngest?" Lucian spoke again, still smiling freely, as if he hadn't just nearly broken both his brother's arms.`,
    `She raised her right hand overhead. A small creature made of shadow spawned — resembling a rat — then transformed into a long black scimitar.\n\nCassius cursed.`,
    `"Then begin." He ordered, turning back to the window. "Undress yourself and lie down on the bed."`
  ];

  for (let i = 0; i < testTexts.length; i++) {
    console.log(`\n--- Test Chunk ${i + 1} ---`);
    const prompt = `You are a professional literary translator specializing in English to Thai.
Translate the following English text into natural, fluent Thai prose suitable for a published webnovel.

CRITICAL RULES:
1. Target language: THAI ONLY (ภาษาไทย).
2. DO NOT output any Chinese characters (汉字) or Chinese words anywhere in your response. Every word must be Thai.
3. Preserve the exact paragraph breaks (\\n\\n).
4. Output must be valid JSON: {"translation": "Thai translated text", "newTerms": {}}

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
        options: { temperature: 0.2, num_predict: 600 }
      })
    });
    const data = await res.json();
    console.log('Result:', data.response);
    const hasChinese = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(data.response);
    console.log('Contains Chinese?:', hasChinese);
  }
}

testEnPrompt();
