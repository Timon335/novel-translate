require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not configured');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000
});

async function getNovels() {
  const result = await pool.query(`
    SELECT n.*, COUNT(c.id)::int AS chapter_count, MAX(c.created_at) AS last_chapter_date
    FROM novels n
    LEFT JOIN chapters c ON n.id = c.novel_id
    GROUP BY n.id
    ORDER BY n.updated_at DESC, n.id DESC
  `);
  return result.rows;
}

async function createNovel({ title, author = '', description = '' }) {
  const result = await pool.query(`
    INSERT INTO novels (title, author, description)
    VALUES ($1, $2, $3)
    RETURNING id
  `, [title.trim(), author.trim(), description.trim()]);
  return result.rows[0].id;
}

async function getNovelById(id) {
  const novelResult = await pool.query('SELECT * FROM novels WHERE id = $1', [id]);
  const novel = novelResult.rows[0];
  if (!novel) return null;

  const chaptersResult = await pool.query(`
    SELECT id, novel_id, chapter_number, title, source_url, created_at
    FROM chapters
    WHERE novel_id = $1
    ORDER BY chapter_number ASC NULLS LAST, id ASC
  `, [id]);

  return { ...novel, chapters: chaptersResult.rows };
}

async function deleteNovel(id) {
  return pool.query('DELETE FROM novels WHERE id = $1', [id]);
}

async function createChapter({ novel_id, chapter_number, title, source_url = '', chunks = [], glossary = {} }) {
  const num = chapter_number !== undefined && chapter_number !== null && !isNaN(Number(chapter_number))
    ? Number(chapter_number)
    : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      INSERT INTO chapters (novel_id, chapter_number, title, source_url, chunks_json)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [novel_id, num, title.trim(), source_url.trim(), JSON.stringify(chunks)]);
    await client.query('UPDATE novels SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [novel_id]);
    for (const [en, th] of Object.entries(glossary)) {
      if (en && th && en.trim() && th.trim()) {
        await client.query(`
          INSERT INTO novel_glossary (novel_id, term_en, term_th)
          VALUES ($1, $2, $3)
          ON CONFLICT (novel_id, term_en) DO UPDATE SET term_th = EXCLUDED.term_th
        `, [novel_id, en.trim(), th.trim()]);
      }
    }
    await client.query('COMMIT');
    return result.rows[0].id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getChapterById(id) {
  const chapterResult = await pool.query('SELECT * FROM chapters WHERE id = $1', [id]);
  const chapter = chapterResult.rows[0];
  if (!chapter) return null;

  const chunks = JSON.parse(chapter.chunks_json || '[]');
  const novelResult = await pool.query('SELECT id, title FROM novels WHERE id = $1', [chapter.novel_id]);
  const novel = novelResult.rows[0];
  const allChaptersResult = await pool.query(`
    SELECT id
    FROM chapters
    WHERE novel_id = $1
    ORDER BY chapter_number ASC NULLS LAST, id ASC
  `, [chapter.novel_id]);
  const allChapters = allChaptersResult.rows;
  const currentIndex = allChapters.findIndex(item => item.id === chapter.id);

  return {
    ...chapter,
    chunks,
    novel_title: novel ? novel.title : '',
    prev_chapter_id: currentIndex > 0 ? allChapters[currentIndex - 1].id : null,
    next_chapter_id: currentIndex < allChapters.length - 1 ? allChapters[currentIndex + 1].id : null
  };
}

async function deleteChapter(id) {
  const chapterResult = await pool.query('SELECT novel_id FROM chapters WHERE id = $1', [id]);
  const chapter = chapterResult.rows[0];
  const result = await pool.query('DELETE FROM chapters WHERE id = $1', [id]);
  if (chapter) {
    await pool.query('UPDATE novels SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [chapter.novel_id]);
  }
  return result;
}

async function getNovelGlossary(novel_id) {
  const result = await pool.query(
    'SELECT term_en, term_th FROM novel_glossary WHERE novel_id = $1',
    [novel_id]
  );
  return Object.fromEntries(result.rows.map(row => [row.term_en, row.term_th]));
}

async function saveNovelGlossary(novel_id, terms = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [en, th] of Object.entries(terms)) {
      if (en && th && en.trim() && th.trim()) {
        await client.query(`
          INSERT INTO novel_glossary (novel_id, term_en, term_th)
          VALUES ($1, $2, $3)
          ON CONFLICT (novel_id, term_en) DO UPDATE SET term_th = EXCLUDED.term_th
        `, [novel_id, en.trim(), th.trim()]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  getNovels,
  createNovel,
  getNovelById,
  deleteNovel,
  createChapter,
  getChapterById,
  deleteChapter,
  getNovelGlossary,
  saveNovelGlossary,
  close
};
