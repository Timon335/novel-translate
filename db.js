const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'novels.db');
const db = new DatabaseSync(dbPath);

// Enable foreign keys
db.exec('PRAGMA foreign_keys = ON;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS novels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT DEFAULT '',
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
    chapter_number REAL,
    title TEXT NOT NULL,
    source_url TEXT DEFAULT '',
    chunks_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS novel_glossary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
    term_en TEXT NOT NULL,
    term_th TEXT NOT NULL,
    UNIQUE(novel_id, term_en)
  );
`);

function getNovels() {
  const stmt = db.prepare(`
    SELECT n.*, COUNT(c.id) AS chapter_count, MAX(c.created_at) AS last_chapter_date
    FROM novels n
    LEFT JOIN chapters c ON n.id = c.novel_id
    GROUP BY n.id
    ORDER BY n.updated_at DESC, n.id DESC
  `);
  return stmt.all();
}

function createNovel({ title, author = '', description = '' }) {
  const stmt = db.prepare(`
    INSERT INTO novels (title, author, description)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(title.trim(), author.trim(), description.trim());
  return result.lastInsertRowid;
}

function getNovelById(id) {
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(id);
  if (!novel) return null;

  const chapters = db.prepare(`
    SELECT id, novel_id, chapter_number, title, source_url, created_at
    FROM chapters
    WHERE novel_id = ?
    ORDER BY chapter_number ASC, id ASC
  `).all(id);

  return { ...novel, chapters };
}

function deleteNovel(id) {
  const stmt = db.prepare('DELETE FROM novels WHERE id = ?');
  return stmt.run(id);
}

function createChapter({ novel_id, chapter_number, title, source_url = '', chunks = [] }) {
  const stmt = db.prepare(`
    INSERT INTO chapters (novel_id, chapter_number, title, source_url, chunks_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const num = chapter_number !== undefined && chapter_number !== null && !isNaN(Number(chapter_number))
    ? Number(chapter_number)
    : null;

  const result = stmt.run(novel_id, num, title.trim(), source_url.trim(), JSON.stringify(chunks));
  
  db.prepare(`UPDATE novels SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(novel_id);

  return result.lastInsertRowid;
}

function getChapterById(id) {
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(id);
  if (!chapter) return null;

  const chunks = JSON.parse(chapter.chunks_json || '[]');

  const novel = db.prepare('SELECT id, title FROM novels WHERE id = ?').get(chapter.novel_id);
  
  const allChapters = db.prepare(`
    SELECT id FROM chapters
    WHERE novel_id = ?
    ORDER BY chapter_number ASC, id ASC
  `).all(chapter.novel_id);

  const currentIndex = allChapters.findIndex(c => c.id === chapter.id);
  const prevChapter = currentIndex > 0 ? allChapters[currentIndex - 1] : null;
  const nextChapter = currentIndex < allChapters.length - 1 ? allChapters[currentIndex + 1] : null;

  return {
    ...chapter,
    chunks,
    novel_title: novel ? novel.title : '',
    prev_chapter_id: prevChapter ? prevChapter.id : null,
    next_chapter_id: nextChapter ? nextChapter.id : null
  };
}

function deleteChapter(id) {
  const chapter = db.prepare('SELECT novel_id FROM chapters WHERE id = ?').get(id);
  const stmt = db.prepare('DELETE FROM chapters WHERE id = ?');
  const res = stmt.run(id);
  if (chapter) {
    db.prepare(`UPDATE novels SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(chapter.novel_id);
  }
  return res;
}

function getNovelGlossary(novel_id) {
  const rows = db.prepare('SELECT term_en, term_th FROM novel_glossary WHERE novel_id = ?').all(novel_id);
  const glossary = {};
  for (const r of rows) {
    glossary[r.term_en] = r.term_th;
  }
  return glossary;
}

function saveNovelGlossary(novel_id, terms = {}) {
  const insertStmt = db.prepare(`
    INSERT INTO novel_glossary (novel_id, term_en, term_th)
    VALUES (?, ?, ?)
    ON CONFLICT(novel_id, term_en) DO UPDATE SET term_th = excluded.term_th
  `);

  for (const [en, th] of Object.entries(terms)) {
    if (en && th && en.trim() && th.trim()) {
      try {
        insertStmt.run(novel_id, en.trim(), th.trim());
      } catch (err) {
        // ignore single conflict error
      }
    }
  }
}

module.exports = {
  db,
  getNovels,
  createNovel,
  getNovelById,
  deleteNovel,
  createChapter,
  getChapterById,
  deleteChapter,
  getNovelGlossary,
  saveNovelGlossary
};
