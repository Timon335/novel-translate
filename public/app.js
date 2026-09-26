// ==================== STATE MANAGEMENT ====================
let currentScreen = 'bookshelf'; // 'bookshelf' | 'novel' | 'reader'
let currentNovelId = null;
let currentChapterId = null;
let currentNovelData = null;
let currentChapterData = null;
let chunks = []; // { en, th }
let currentGlossary = {}; // { [en]: th }
let viewMode = 'side'; // 'side' | 'th-only'
let fontSize = 18;

// TTS State
let isReading = false;
let currentChunkIndex = 0;
const audioPlayer = new Audio();
let audioCache = new Map();

// ==================== DOM ELEMENTS ====================
// Screens
const bookshelfScreen = document.getElementById('bookshelfScreen');
const novelDetailScreen = document.getElementById('novelDetailScreen');
const readerScreen = document.getElementById('readerScreen');

// Bookshelf elements
const novelsGrid = document.getElementById('novelsGrid');
const emptyNovelsState = document.getElementById('emptyNovelsState');
const openNewNovelModalBtn = document.getElementById('openNewNovelModalBtn');
const emptyAddNovelBtn = document.getElementById('emptyAddNovelBtn');

// Novel Detail elements
const backToBookshelfBtn = document.getElementById('backToBookshelfBtn');
const novelHeroTitle = document.getElementById('novelHeroTitle');
const novelHeroAuthor = document.getElementById('novelHeroAuthor');
const novelHeroDesc = document.getElementById('novelHeroDesc');
const novelHeroCount = document.getElementById('novelHeroCount');
const novelHeroUpdated = document.getElementById('novelHeroUpdated');
const openNewChapterModalBtn = document.getElementById('openNewChapterModalBtn');
const openGlossaryModalBtn = document.getElementById('openGlossaryModalBtn');
const deleteNovelBtn = document.getElementById('deleteNovelBtn');
const chaptersList = document.getElementById('chaptersList');
const emptyChaptersState = document.getElementById('emptyChaptersState');
const emptyAddChapterBtn = document.getElementById('emptyAddChapterBtn');

// Reader elements
const backToNovelBtn = document.getElementById('backToNovelBtn');
const bottomTocBtn = document.getElementById('bottomTocBtn');
const readerNovelTitle = document.getElementById('readerNovelTitle');
const readerChapterTitle = document.getElementById('readerChapterTitle');
const readerContent = document.getElementById('readerContent');
const prevChapterBtn = document.getElementById('prevChapterBtn');
const nextChapterBtn = document.getElementById('nextChapterBtn');
const viewSideBtn = document.getElementById('viewSideBtn');
const viewThOnlyBtn = document.getElementById('viewThOnlyBtn');
const fontPlus = document.getElementById('fontPlus');
const fontMinus = document.getElementById('fontMinus');

// Global Nav elements
const brandHomeBtn = document.getElementById('brandHomeBtn');
const quickTranslateNavBtn = document.getElementById('quickTranslateNavBtn');
const globalThemeToggle = document.getElementById('globalThemeToggle');

// Modals
const newNovelModal = document.getElementById('newNovelModal');
const newChapterModal = document.getElementById('newChapterModal');
const quickTranslateModal = document.getElementById('quickTranslateModal');
const glossaryModal = document.getElementById('glossaryModal');

// TTS elements
const ttsPlayPause = document.getElementById('ttsPlayPause');
const ttsPrev = document.getElementById('ttsPrev');
const ttsNext = document.getElementById('ttsNext');
const ttsSpeed = document.getElementById('ttsSpeed');
const voiceSelect = document.getElementById('voiceSelect');

// ==================== SCREEN NAVIGATION ====================
function switchScreen(screenName) {
  currentScreen = screenName;
  bookshelfScreen.classList.toggle('hidden', screenName !== 'bookshelf');
  novelDetailScreen.classList.toggle('hidden', screenName !== 'novel');
  readerScreen.classList.toggle('hidden', screenName !== 'reader');

  if (screenName !== 'reader') {
    stopReading();
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// Global Brand click -> return to bookshelf
brandHomeBtn.addEventListener('click', () => {
  switchScreen('bookshelf');
  loadNovels();
});

// Back from Novel to Bookshelf
backToBookshelfBtn.addEventListener('click', () => {
  switchScreen('bookshelf');
  loadNovels();
});

// Back from Reader to Novel (or Bookshelf)
function returnFromReader() {
  stopReading();
  if (currentNovelId) {
    openNovel(currentNovelId);
  } else {
    switchScreen('bookshelf');
    loadNovels();
  }
}
backToNovelBtn.addEventListener('click', returnFromReader);
bottomTocBtn.addEventListener('click', returnFromReader);

// ==================== BOOKSHELF (NOVELS LIST) ====================
async function loadNovels() {
  try {
    const res = await fetch('/api/novels');
    const novels = await res.json();
    renderNovelsGrid(novels);
  } catch (err) {
    console.error('Failed to load novels:', err);
  }
}

function renderNovelsGrid(novels) {
  novelsGrid.innerHTML = '';
  if (!novels || novels.length === 0) {
    novelsGrid.classList.add('hidden');
    emptyNovelsState.classList.remove('hidden');
    return;
  }

  novelsGrid.classList.remove('hidden');
  emptyNovelsState.classList.add('hidden');

  novels.forEach(novel => {
    const card = document.createElement('div');
    card.className = 'novel-card';
    card.addEventListener('click', () => openNovel(novel.id));

    const dateStr = novel.last_chapter_date
      ? new Date(novel.last_chapter_date).toLocaleDateString('th-TH', { month: 'short', day: 'numeric' })
      : new Date(novel.created_at).toLocaleDateString('th-TH', { month: 'short', day: 'numeric' });

    card.innerHTML = `
      <div>
        <div class="novel-card-header">
          <h3 class="novel-card-title">${escapeHtml(novel.title)}</h3>
          <span class="badge">${novel.chapter_count || 0} ตอน</span>
        </div>
        <p class="novel-card-author">${novel.author ? 'ผู้แต่ง: ' + escapeHtml(novel.author) : 'ไม่ระบุผู้แต่ง'}</p>
        <p class="novel-card-desc">${novel.description ? escapeHtml(novel.description) : 'ไม่มีคำอธิบายเรื่องย่อ'}</p>
      </div>
      <div class="novel-card-footer">
        <span>อัปเดต: ${dateStr}</span>
        <span style="color: var(--accent); font-weight: 600;">เปิดอ่าน →</span>
      </div>
    `;
    novelsGrid.appendChild(card);
  });
}

// ==================== NOVEL DETAIL & CHAPTERS ====================
async function openNovel(novelId) {
  currentNovelId = novelId;
  try {
    const res = await fetch(`/api/novels/${novelId}`);
    if (!res.ok) throw new Error('ไม่พบนิยาย');
    const novel = await res.json();
    currentNovelData = novel;

    novelHeroTitle.textContent = novel.title;
    novelHeroAuthor.textContent = novel.author ? `ผู้แต่ง: ${novel.author}` : 'ไม่ระบุผู้แต่ง';
    novelHeroDesc.textContent = novel.description || 'ไม่มีคำอธิบายเรื่องย่อ';
    novelHeroCount.textContent = `${novel.chapters ? novel.chapters.length : 0} ตอน`;
    novelHeroUpdated.textContent = `อัปเดต: ${new Date(novel.updated_at).toLocaleDateString('th-TH')}`;

    renderChaptersList(novel.chapters || []);
    switchScreen('novel');
  } catch (err) {
    alert(err.message);
  }
}

function renderChaptersList(chapters) {
  chaptersList.innerHTML = '';
  if (!chapters || chapters.length === 0) {
    chaptersList.classList.add('hidden');
    emptyChaptersState.classList.remove('hidden');
    return;
  }

  chaptersList.classList.remove('hidden');
  emptyChaptersState.classList.add('hidden');

  chapters.forEach(ch => {
    const item = document.createElement('div');
    item.className = 'chapter-item';

    const numText = ch.chapter_number !== null ? `ตอนที่ ${ch.chapter_number}` : '-';
    const dateStr = new Date(ch.created_at).toLocaleDateString('th-TH', { month: 'short', day: 'numeric', year: 'numeric' });

    item.innerHTML = `
      <div class="chapter-info">
        <span class="chapter-num">${numText}</span>
        <span class="chapter-title-text">${escapeHtml(ch.title)}</span>
        <span class="chapter-date">${dateStr}</span>
      </div>
      <div class="chapter-actions">
        <button class="btn btn-secondary read-chapter-btn">อ่าน</button>
        <button class="btn btn-icon delete-chapter-btn" title="ลบตอนนี้" style="color: var(--danger);">🗑️</button>
      </div>
    `;

    item.querySelector('.chapter-title-text').addEventListener('click', () => loadChapter(ch.id));
    item.querySelector('.read-chapter-btn').addEventListener('click', () => loadChapter(ch.id));
    item.querySelector('.delete-chapter-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`คุณต้องการลบ "${ch.title}" หรือไม่?`)) {
        await deleteChapter(ch.id);
      }
    });

    chaptersList.appendChild(item);
  });
}

async function deleteChapter(chapterId) {
  try {
    const res = await fetch(`/api/chapters/${chapterId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('ลบไม่สำเร็จ');
    openNovel(currentNovelId);
  } catch (err) {
    alert(err.message);
  }
}

deleteNovelBtn.addEventListener('click', async () => {
  if (!currentNovelId || !currentNovelData) return;
  if (confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบเรื่อง "${currentNovelData.title}" พร้อมตอนทั้งหมด?`)) {
    try {
      const res = await fetch(`/api/novels/${currentNovelId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('ลบไม่สำเร็จ');
      switchScreen('bookshelf');
      loadNovels();
    } catch (err) {
      alert(err.message);
    }
  }
});

// ==================== READER SCREEN ====================
async function loadChapter(chapterId) {
  currentChapterId = chapterId;
  stopReading();

  try {
    const res = await fetch(`/api/chapters/${chapterId}`);
    if (!res.ok) throw new Error('ไม่พบตอนนี้');
    const ch = await res.json();
    currentChapterData = ch;
    currentNovelId = ch.novel_id;

    readerNovelTitle.textContent = ch.novel_title || 'นิยาย';
    readerChapterTitle.textContent = ch.title;

    chunks = ch.chunks || [];
    renderChunks();

    // Previous & Next navigation buttons
    if (ch.prev_chapter_id) {
      prevChapterBtn.disabled = false;
      prevChapterBtn.onclick = () => loadChapter(ch.prev_chapter_id);
    } else {
      prevChapterBtn.disabled = true;
      prevChapterBtn.onclick = null;
    }

    if (ch.next_chapter_id) {
      nextChapterBtn.disabled = false;
      nextChapterBtn.onclick = () => loadChapter(ch.next_chapter_id);
    } else {
      nextChapterBtn.disabled = true;
      nextChapterBtn.onclick = null;
    }

    switchScreen('reader');
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการโหลดตอน: ' + err.message);
  }
}

function renderChunks() {
  readerContent.innerHTML = '';
  chunks.forEach((chunk, i) => {
    const row = document.createElement('div');
    row.className = 'chunk-row' + (viewMode === 'th-only' ? ' th-only' : '');
    row.dataset.index = i;

    if (viewMode === 'side') {
      const enDiv = document.createElement('div');
      enDiv.className = 'chunk-en';
      enDiv.textContent = chunk.en;
      row.appendChild(enDiv);
    }

    const thDiv = document.createElement('div');
    thDiv.className = 'chunk-th';
    thDiv.textContent = chunk.th;
    row.appendChild(thDiv);

    readerContent.appendChild(row);
  });
}

// View toggle (Side-by-side / TH only)
viewSideBtn.addEventListener('click', () => setViewMode('side'));
viewThOnlyBtn.addEventListener('click', () => setViewMode('th-only'));

function setViewMode(mode) {
  viewMode = mode;
  viewSideBtn.classList.toggle('active', mode === 'side');
  viewThOnlyBtn.classList.toggle('active', mode === 'th-only');
  renderChunks();
}

// Font size
fontPlus.addEventListener('click', () => {
  fontSize = Math.min(32, fontSize + 2);
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');
});
fontMinus.addEventListener('click', () => {
  fontSize = Math.max(14, fontSize - 2);
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');
});

// Theme toggle
globalThemeToggle.addEventListener('click', toggleTheme);
function toggleTheme() {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  globalThemeToggle.textContent = isDark ? '☀️' : '🌙';
}

// ==================== MODALS MANAGEMENT ====================
function openModal(modal) {
  modal.classList.remove('hidden');
}
function closeModal(modal) {
  modal.classList.add('hidden');
}

// Handle all data-close buttons
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => {
    const modalId = btn.getAttribute('data-close');
    const m = document.getElementById(modalId);
    if (m) closeModal(m);
  });
});

// Modal 1: เพิ่มนิยายใหม่
openNewNovelModalBtn.addEventListener('click', () => {
  document.getElementById('newNovelTitle').value = '';
  document.getElementById('newNovelAuthor').value = '';
  document.getElementById('newNovelDesc').value = '';
  document.getElementById('newNovelError').textContent = '';
  openModal(newNovelModal);
});
emptyAddNovelBtn.addEventListener('click', () => openNewNovelModalBtn.click());

document.getElementById('saveNovelBtn').addEventListener('click', async () => {
  const title = document.getElementById('newNovelTitle').value.trim();
  const author = document.getElementById('newNovelAuthor').value.trim();
  const description = document.getElementById('newNovelDesc').value.trim();
  const errEl = document.getElementById('newNovelError');
  errEl.textContent = '';

  if (!title) {
    errEl.textContent = 'กรุณาระบุชื่อเรื่องนิยาย';
    return;
  }

  try {
    const res = await fetch('/api/novels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author, description })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');

    closeModal(newNovelModal);
    loadNovels();
    openNovel(data.id);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// ========== MODE TABS (Single / Batch) ==========
let chapterMode = 'single'; // 'single' | 'batch'

document.getElementById('modeSingleBtn').addEventListener('click', () => {
  chapterMode = 'single';
  document.getElementById('modeSingleBtn').classList.add('active');
  document.getElementById('modeBatchBtn').classList.remove('active');
  document.getElementById('singleModeForm').classList.remove('hidden');
  document.getElementById('batchModeForm').classList.add('hidden');
  document.getElementById('startTranslateChapterBtn').textContent = 'เริ่มแปลและบันทึก';
});
document.getElementById('modeBatchBtn').addEventListener('click', () => {
  chapterMode = 'batch';
  document.getElementById('modeBatchBtn').classList.add('active');
  document.getElementById('modeSingleBtn').classList.remove('active');
  document.getElementById('batchModeForm').classList.remove('hidden');
  document.getElementById('singleModeForm').classList.add('hidden');
  document.getElementById('startTranslateChapterBtn').textContent = '🚀 เริ่มแปล Batch';
});

// Preview URL count when batch fields change
function updateBatchPreview() {
  const startUrl = document.getElementById('batchStartUrl').value.trim();
  const endUrl = document.getElementById('batchEndUrl').value.trim();
  const preview = document.getElementById('batchPreview');
  if (!startUrl || !endUrl) { preview.classList.add('hidden'); return; }
  const getNum = (url) => { const m = url.replace(/\/$/, '').match(/\/(\d+)(?:\?.*)?$/); return m ? parseInt(m[1]) : null; };
  const s = getNum(startUrl), e = getNum(endUrl);
  if (s === null || e === null || e < s) { preview.classList.add('hidden'); return; }
  preview.classList.remove('hidden');
  preview.textContent = `📊 จะแปลทั้งหมด ${e - s + 1} ตอน (ID ${s} → ${e})`;
}
document.getElementById('batchStartUrl').addEventListener('input', updateBatchPreview);
document.getElementById('batchEndUrl').addEventListener('input', updateBatchPreview);

// Modal 2: เพิ่มตอนใหม่
openNewChapterModalBtn.addEventListener('click', () => {

  // reset ทั้ง single และ batch
  document.getElementById('newChapterUrl').value = '';
  document.getElementById('newChapterTitle').value = '';
  document.getElementById('newChapterError').textContent = '';
  document.getElementById('chapterProgressBox').classList.add('hidden');
  document.getElementById('startTranslateChapterBtn').disabled = false;
  document.getElementById('batchStartUrl').value = '';
  document.getElementById('batchEndUrl').value = '';
  document.getElementById('batchStartChapterNum').value = '';
  document.getElementById('batchPreview').classList.add('hidden');

  // รีเซ็ตกลับ single mode เสมอ
  chapterMode = 'single';
  document.getElementById('modeSingleBtn').classList.add('active');
  document.getElementById('modeBatchBtn').classList.remove('active');
  document.getElementById('singleModeForm').classList.remove('hidden');
  document.getElementById('batchModeForm').classList.add('hidden');
  document.getElementById('startTranslateChapterBtn').textContent = 'เริ่มแปลและบันทึก';

  // Auto-suggest next chapter number
  let nextNum = 1;
  if (currentNovelData && currentNovelData.chapters && currentNovelData.chapters.length > 0) {
    const nums = currentNovelData.chapters
      .map(c => c.chapter_number)
      .filter(n => n !== null && !isNaN(n));
    if (nums.length > 0) {
      nextNum = Math.floor(Math.max(...nums)) + 1;
    }
  }
  document.getElementById('newChapterNumber').value = nextNum;

  openModal(newChapterModal);
});

emptyAddChapterBtn.addEventListener('click', () => openNewChapterModalBtn.click());

document.getElementById('startTranslateChapterBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('newChapterError');
  const btn = document.getElementById('startTranslateChapterBtn');
  const progressBox = document.getElementById('chapterProgressBox');
  const progressLabel = document.getElementById('chapterProgressLabel');
  const progressBarFill = document.getElementById('chapterProgressBarFill');

  errEl.textContent = '';

  // ==================== SINGLE MODE ====================
  if (chapterMode === 'single') {
    const url = document.getElementById('newChapterUrl').value.trim();
    const chapterNumber = document.getElementById('newChapterNumber').value;
    const chapterTitle = document.getElementById('newChapterTitle').value.trim();

    if (!url) { errEl.textContent = 'กรุณาวางลิงก์เว็บตอนนิยาย'; return; }

    btn.disabled = true;
    progressBox.classList.remove('hidden');
    progressLabel.textContent = 'กำลังดึงเนื้อหาจากลิงก์...';
    progressBarFill.style.width = '6%';

    try {
      const res = await fetch(`/api/novels/${currentNovelId}/chapters/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, chapter_number: chapterNumber ? parseFloat(chapterNumber) : null, title: chapterTitle })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');

      const jobId = data.jobId;
      const pollInterval = setInterval(async () => {
        try {
          const sRes = await fetch(`/api/job/${jobId}`);
          const job = await sRes.json();
          if (!sRes.ok) throw new Error(job.error || 'ไม่พบงาน');

          if (job.status === 'scraping') {
            progressLabel.textContent = 'กำลังดึงเนื้อหาจากลิงก์...';
            progressBarFill.style.width = '8%';
          } else if (job.status === 'translating') {
            const total = job.total || 1;
            const done = job.chunks.length;
            const pct = Math.max(10, Math.round((done / total) * 80)); // max 80% สำหรับแปล
            progressLabel.textContent = `🔄 กำลังแปล... (${done}/${total} ส่วน)`;
            progressBarFill.style.width = pct + '%';
          } else if (job.status === 'proofreading') {
            const done = job.proofreadDone || 0;
            const total = job.proofreadTotal || 1;
            const pct = 80 + Math.round((done / total) * 18); // 80-98%
            progressLabel.textContent = `✏️ ตรวจคำภาษาไทย... (${done}/${total} ส่วน)`;
            progressBarFill.style.width = pct + '%';
          } else if (job.status === 'done') {
            clearInterval(pollInterval);
            progressBarFill.style.width = '100%';
            progressLabel.textContent = '✅ แปล ตรวจคำ และบันทึกเรียบร้อย!';
            setTimeout(() => {
              closeModal(newChapterModal);
              if (job.savedChapterId) loadChapter(job.savedChapterId);
              else openNovel(currentNovelId);
            }, 600);
          } else if (job.status === 'error') {
            clearInterval(pollInterval);
            throw new Error(job.error || 'การแปลล้มเหลว');
          }
        } catch (pollErr) {
          clearInterval(pollInterval);
          errEl.textContent = pollErr.message;
          btn.disabled = false;
          progressBox.classList.add('hidden');
        }
      }, 1200);
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
      progressBox.classList.add('hidden');
    }

  // ==================== BATCH MODE ====================
  } else {
    const startUrl = document.getElementById('batchStartUrl').value.trim();
    const endUrl = document.getElementById('batchEndUrl').value.trim();
    const startChapterNumber = document.getElementById('batchStartChapterNum').value;

    if (!startUrl || !endUrl) { errEl.textContent = 'กรุณาวางลิงก์ตอนแรกและตอนสุดท้าย'; return; }

    btn.disabled = true;
    progressBox.classList.remove('hidden');
    progressLabel.textContent = 'กำลังเตรียมรายการ URL...';
    progressBarFill.style.width = '2%';

    try {
      const res = await fetch(`/api/novels/${currentNovelId}/chapters/batch-translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrl,
          endUrl,
          startChapterNumber: startChapterNumber ? parseInt(startChapterNumber) : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');

      const { batchJobId, total } = data;
      progressLabel.textContent = `🚀 เริ่ม Batch ${total} ตอน...`;
      progressBarFill.style.width = '5%';

      const pollInterval = setInterval(async () => {
        try {
          const sRes = await fetch(`/api/job/${batchJobId}`);
          const bJob = await sRes.json();
          if (!sRes.ok) throw new Error('ไม่พบงาน');

          const done = bJob.done || 0;
          const failed = bJob.failed || 0;
          const totalJ = bJob.total || 1;
          const pct = Math.max(5, Math.round((done / totalJ) * 100));
          progressBarFill.style.width = pct + '%';

          const statusMap = {
            scraping: '🔍 ดึงเนื้อหา',
            translating: '🔄 กำลังแปล',
            proofreading: '✏️ ตรวจคำ',
            done: '✅ เสร็จแล้ว'
          };
          const curStatus = statusMap[bJob.currentStatus] || bJob.currentStatus;
          progressLabel.textContent = `${curStatus} ตอน ${(bJob.currentIndex || 0) + 1}/${totalJ} — สำเร็จ ${done}${failed > 0 ? ` | ล้มเหลว ${failed}` : ''}`;

          if (bJob.status === 'done' || bJob.status === 'error') {
            clearInterval(pollInterval);
            progressBarFill.style.width = '100%';
            if (failed > 0) {
              progressLabel.textContent = `⚠️ เสร็จ ${done}/${totalJ} ตอน (ล้มเหลว ${failed} ตอน)`;
            } else {
              progressLabel.textContent = `✅ แปล Batch เสร็จสมบูรณ์ ${done} ตอน!`;
            }
            setTimeout(() => {
              closeModal(newChapterModal);
              openNovel(currentNovelId);
            }, 1200);
          }
        } catch (pollErr) {
          clearInterval(pollInterval);
          errEl.textContent = pollErr.message;
          btn.disabled = false;
          progressBox.classList.add('hidden');
        }
      }, 2000); // poll ทุก 2 วิสำหรับ batch (นานกว่า single)
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
      progressBox.classList.add('hidden');
    }
  }
});


// Modal 3: แปลด่วน (Quick Translate)
quickTranslateNavBtn.addEventListener('click', () => {
  document.getElementById('quickUrlInput').value = '';
  document.getElementById('quickError').textContent = '';
  document.getElementById('quickProgressBox').classList.add('hidden');
  document.getElementById('startQuickTranslateBtn').disabled = false;
  openModal(quickTranslateModal);
});

document.getElementById('startQuickTranslateBtn').addEventListener('click', async () => {
  const url = document.getElementById('quickUrlInput').value.trim();
  const errEl = document.getElementById('quickError');
  const btn = document.getElementById('startQuickTranslateBtn');
  const progressBox = document.getElementById('quickProgressBox');
  const progressLabel = document.getElementById('quickProgressLabel');
  const progressBarFill = document.getElementById('quickProgressBarFill');

  errEl.textContent = '';
  if (!url) {
    errEl.textContent = 'กรุณาวางลิงก์ก่อนครับ';
    return;
  }

  btn.disabled = true;
  progressBox.classList.remove('hidden');
  progressLabel.textContent = 'กำลังดึงเนื้อหาจากลิงก์...';
  progressBarFill.style.width = '5%';

  try {
    const res = await fetch('/api/translate-book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');

    const jobId = data.jobId;
    const pollInterval = setInterval(async () => {
      try {
        const sRes = await fetch(`/api/job/${jobId}`);
        const job = await sRes.json();
        if (!sRes.ok) throw new Error(job.error || 'ไม่พบงาน');

        if (job.status === 'scraping') {
          progressLabel.textContent = 'กำลังดึงเนื้อหา...';
          progressBarFill.style.width = '10%';
        } else if (job.status === 'translating') {
          const total = job.total || 1;
          const done = job.chunks.length;
          const pct = Math.max(10, Math.round((done / total) * 100));
          progressLabel.textContent = `กำลังแปล... (${done}/${total} ส่วน)`;
          progressBarFill.style.width = pct + '%';
        } else if (job.status === 'done') {
          clearInterval(pollInterval);
          progressBarFill.style.width = '100%';
          progressLabel.textContent = 'แปลเสร็จแล้ว!';

          setTimeout(() => {
            closeModal(quickTranslateModal);
            currentNovelId = null;
            currentChapterId = null;
            readerNovelTitle.textContent = 'แปลด่วน (ชั่วคราว)';
            readerChapterTitle.textContent = url;
            chunks = job.chunks;
            prevChapterBtn.disabled = true;
            nextChapterBtn.disabled = true;
            renderChunks();
            switchScreen('reader');
          }, 400);
        } else if (job.status === 'error') {
          clearInterval(pollInterval);
          throw new Error(job.error || 'เกิดข้อผิดพลาด');
        }
      } catch (pollErr) {
        clearInterval(pollInterval);
        errEl.textContent = pollErr.message;
        btn.disabled = false;
        progressBox.classList.add('hidden');
      }
    }, 1200);

  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    progressBox.classList.add('hidden');
  }
});

// Modal 4: จัดการคำศัพท์เฉพาะ (Glossary)
openGlossaryModalBtn.addEventListener('click', async () => {
  if (!currentNovelId) return;
  document.getElementById('glossaryNewEn').value = '';
  document.getElementById('glossaryNewTh').value = '';
  document.getElementById('glossaryStatusMsg').textContent = '';

  try {
    const res = await fetch(`/api/novels/${currentNovelId}/glossary`);
    currentGlossary = await res.json();
    renderGlossaryList();
    openModal(glossaryModal);
  } catch (err) {
    alert('โหลดคำศัพท์ไม่สำเร็จ: ' + err.message);
  }
});

function renderGlossaryList() {
  const container = document.getElementById('glossaryListContainer');
  container.innerHTML = '';
  const entries = Object.entries(currentGlossary);

  if (entries.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 20px;">ยังไม่มีคำศัพท์เฉพาะที่บันทึกไว้</p>';
    return;
  }

  entries.forEach(([en, th]) => {
    const row = document.createElement('div');
    row.className = 'glossary-item';
    row.innerHTML = `
      <span class="glossary-en">${escapeHtml(en)}</span>
      <input type="text" class="glossary-th-input" value="${escapeHtml(th)}" data-en="${escapeHtml(en)}" />
      <button class="btn btn-icon glossary-del-btn" style="color: var(--danger); padding: 4px 8px;" title="ลบ">✕</button>
    `;

    row.querySelector('.glossary-th-input').addEventListener('input', (e) => {
      currentGlossary[en] = e.target.value.trim();
    });

    row.querySelector('.glossary-del-btn').addEventListener('click', () => {
      delete currentGlossary[en];
      renderGlossaryList();
    });

    container.appendChild(row);
  });
}

document.getElementById('addGlossaryItemBtn').addEventListener('click', () => {
  const enInput = document.getElementById('glossaryNewEn');
  const thInput = document.getElementById('glossaryNewTh');
  const en = enInput.value.trim();
  const th = thInput.value.trim();

  if (!en || !th) {
    alert('กรุณากรอกทั้งคำอังกฤษและคำแปลไทย');
    return;
  }

  currentGlossary[en] = th;
  enInput.value = '';
  thInput.value = '';
  renderGlossaryList();
});

document.getElementById('saveGlossaryBtn').addEventListener('click', async () => {
  if (!currentNovelId) return;
  const statusMsg = document.getElementById('glossaryStatusMsg');
  statusMsg.textContent = 'กำลังบันทึก...';

  try {
    const res = await fetch(`/api/novels/${currentNovelId}/glossary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms: currentGlossary })
    });
    if (!res.ok) throw new Error('บันทึกไม่สำเร็จ');
    statusMsg.textContent = '✓ บันทึกคำศัพท์เรียบร้อยแล้ว';
    setTimeout(() => {
      closeModal(glossaryModal);
    }, 600);
  } catch (err) {
    alert(err.message);
  }
});

// ==================== TEXT-TO-SPEECH (TTS) ====================
function speedToRatePercent(speed) {
  const diff = Math.round((speed - 1) * 100);
  return (diff >= 0 ? '+' : '') + diff + '%';
}

async function fetchChunkAudio(index) {
  const cacheKey = `${index}_${voiceSelect.value}_${ttsSpeed.value}`;
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);

  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: chunks[index].th,
      voice: voiceSelect.value,
      rate: speedToRatePercent(parseFloat(ttsSpeed.value))
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'สร้างเสียงไม่สำเร็จ');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  audioCache.set(cacheKey, url);
  return url;
}

ttsPlayPause.addEventListener('click', () => {
  if (!chunks.length) return;
  if (isReading) {
    audioPlayer.pause();
    isReading = false;
    ttsPlayPause.textContent = '▶ อ่านต่อ';
  } else {
    isReading = true;
    ttsPlayPause.textContent = '⏸ กำลังโหลดเสียง...';
    if (audioPlayer.src && !audioPlayer.ended) {
      audioPlayer.play();
      ttsPlayPause.textContent = '⏸ หยุดชั่วคราว';
    } else {
      speakFrom(currentChunkIndex);
    }
  }
});

ttsPrev.addEventListener('click', () => {
  currentChunkIndex = Math.max(0, currentChunkIndex - 1);
  if (isReading) speakFrom(currentChunkIndex);
  else highlightChunk(currentChunkIndex);
});
ttsNext.addEventListener('click', () => {
  currentChunkIndex = Math.min(chunks.length - 1, currentChunkIndex + 1);
  if (isReading) speakFrom(currentChunkIndex);
  else highlightChunk(currentChunkIndex);
});

async function speakFrom(index) {
  currentChunkIndex = index;
  if (index >= chunks.length) {
    stopReading();
    return;
  }
  highlightChunk(index);
  isReading = true;
  ttsPlayPause.textContent = '⏸ กำลังโหลดเสียง...';

  try {
    const url = await fetchChunkAudio(index);
    if (!isReading || currentChunkIndex !== index) return;
    audioPlayer.src = url;
    await audioPlayer.play();
    ttsPlayPause.textContent = '⏸ หยุดชั่วคราว';
  } catch (err) {
    alert('อ่านออกเสียงไม่สำเร็จ: ' + err.message);
    stopReading();
  }
}

audioPlayer.addEventListener('ended', () => {
  if (isReading) speakFrom(currentChunkIndex + 1);
});

function highlightChunk(index) {
  document.querySelectorAll('.reading').forEach(el => el.classList.remove('reading'));
  const row = readerContent.querySelector(`.chunk-row[data-index="${index}"]`);
  if (row) {
    row.querySelectorAll('.chunk-th, .chunk-en').forEach(el => el.classList.add('reading'));
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function stopReading() {
  audioPlayer.pause();
  isReading = false;
  currentChunkIndex = 0;
  ttsPlayPause.textContent = '▶ อ่านออกเสียง';
  document.querySelectorAll('.reading').forEach(el => el.classList.remove('reading'));
}

// ==================== UTILS ====================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== INITIAL LOAD ====================
loadNovels();
