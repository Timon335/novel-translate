require('dotenv').config();
const sqlite = require('./db.js');
const postgres = require('./db-postgres.js');

async function migrate() {
  const novels = sqlite.db.prepare('SELECT * FROM novels ORDER BY id').all();
  const chapters = sqlite.db.prepare('SELECT * FROM chapters ORDER BY id').all();
  const glossary = sqlite.db.prepare('SELECT * FROM novel_glossary ORDER BY id').all();
  const client = await postgres.pool.connect();

  try {
    const targetCounts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM novels) AS novels,
        (SELECT COUNT(*)::int FROM chapters) AS chapters,
        (SELECT COUNT(*)::int FROM novel_glossary) AS glossary
    `);
    const counts = targetCounts.rows[0];
    if (counts.novels > 0 || counts.chapters > 0 || counts.glossary > 0) {
      throw new Error('PostgreSQL already contains data; migration stopped to prevent duplicates');
    }

    await client.query('BEGIN');
    for (const novel of novels) {
      await client.query(`
        INSERT INTO novels (id, title, author, description, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [novel.id, novel.title, novel.author || '', novel.description || '', novel.created_at, novel.updated_at]);
    }

    for (const chapter of chapters) {
      await client.query(`
        INSERT INTO chapters (id, novel_id, chapter_number, title, source_url, chunks_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [chapter.id, chapter.novel_id, chapter.chapter_number, chapter.title, chapter.source_url || '', chapter.chunks_json || '[]', chapter.created_at]);
    }

    for (const term of glossary) {
      await client.query(`
        INSERT INTO novel_glossary (id, novel_id, term_en, term_th)
        VALUES ($1, $2, $3, $4)
      `, [term.id, term.novel_id, term.term_en, term.term_th]);
    }

    await client.query(`
      SELECT setval(pg_get_serial_sequence('novels', 'id'), COALESCE((SELECT MAX(id) FROM novels), 1));
      SELECT setval(pg_get_serial_sequence('chapters', 'id'), COALESCE((SELECT MAX(id) FROM chapters), 1));
      SELECT setval(pg_get_serial_sequence('novel_glossary', 'id'), COALESCE((SELECT MAX(id) FROM novel_glossary), 1));
    `);
    await client.query('COMMIT');
    console.log(JSON.stringify({ migrated: { novels: novels.length, chapters: chapters.length, glossary: glossary.length } }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await postgres.pool.end();
  }
}

migrate().catch(error => {
  console.error('SQLite to PostgreSQL migration failed:', error.message);
  process.exitCode = 1;
});
