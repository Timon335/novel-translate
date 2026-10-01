const cheerio = require('cheerio');

async function check() {
  const url = 'https://www.pyg-kit.com/en/books/last-born-of-the-desdemona/chapters/344232';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    console.log('Status:', res.status);
    const html = await res.text();
    const $ = cheerio.load(html);
    console.log('Title:', $('title').text());
    
    // Check paragraphs
    const ps = $('p').map((i, el) => $(el).text().trim()).get().filter(Boolean);
    console.log('Total paragraphs found:', ps.length);
    console.log('First 5 paragraphs:');
    ps.slice(0, 5).forEach((p, i) => console.log(`[${i}] ${p.substring(0, 100)}`));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

check();
