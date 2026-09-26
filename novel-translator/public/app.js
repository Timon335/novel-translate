// ---------- state ----------
let chunks = []; // { en, th }
let currentJobId = null;
let pollTimer = null;
let viewMode = 'side'; // 'side' | 'th-only'
let fontSize = 18;

// TTS state
let isReading = false;
let currentChunkIndex = 0;
let currentUtterance = null;

// ---------- elements ----------
const homeScreen = document.getElementById('homeScreen');
const readerScreen = document.getElementById('readerScreen');
const urlInput = document.getElementById('urlInput');
const translateBtn = document.getElementById('translateBtn');
const homeError = document.getElementById('homeError');
const progressBox = document.getElementById('progressBox');
const progressLabel = document.getElementById('progressLabel');
const progressBarFill = document.getElementById('progressBarFill');
const readerContent = document.getElementById('readerContent');

// ---------- หน้าแรก: เริ่มแปล ----------
translateBtn.addEventListener('click', startTranslate);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') startTranslate(); });

async function startTranslate() {
  const url = urlInput.value.trim();
  homeError.textContent = '';
  if (!url) { homeError.textContent = 'กรุณาวางลิงก์ก่อนครับ'; return; }

  translateBtn.disabled = true;
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
    currentJobId = data.jobId;
    pollJob();
  } catch (err) {
    homeError.textContent = err.message;
    translateBtn.disabled = false;
    progressBox.classList.add('hidden');
  }
}

function pollJob() {
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/job/${currentJobId}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || 'ไม่พบงานแปล');

      if (job.status === 'scraping') {
        progressLabel.textContent = 'กำลังดึงเนื้อหาจากลิงก์...';
        progressBarFill.style.width = '8%';
      } else if (job.status === 'translating') {
        const total = job.total || 1;
        const done = job.chunks.length;
        const pct = Math.max(10, Math.round((done / total) * 100));
        progressLabel.textContent = `กำลังแปล... (${done}/${total} ส่วน)`;
        progressBarFill.style.width = pct + '%';
      } else if (job.status === 'done') {
        clearInterval(pollTimer);
        chunks = job.chunks;
        progressBarFill.style.width = '100%';
        progressLabel.textContent = 'แปลเสร็จแล้ว!';
        setTimeout(() => openReader(), 400);
      } else if (job.status === 'error') {
        clearInterval(pollTimer);
        throw new Error(job.error || 'เกิดข้อผิดพลาดระหว่างแปล');
      }
    } catch (err) {
      clearInterval(pollTimer);
      homeError.textContent = err.message;
      translateBtn.disabled = false;
      progressBox.classList.add('hidden');
    }
  }, 1200);
}

// ---------- หน้าอ่าน ----------
function openReader() {
  homeScreen.classList.add('hidden');
  readerScreen.classList.remove('hidden');
  translateBtn.disabled = false;
  renderChunks();
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

document.getElementById('backBtn').addEventListener('click', () => {
  stopReading();
  readerScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
  homeError.textContent = '';
  progressBox.classList.add('hidden');
});

// toggle side-by-side / th only
const viewSideBtn = document.getElementById('viewSideBtn');
const viewThOnlyBtn = document.getElementById('viewThOnlyBtn');
viewSideBtn.addEventListener('click', () => setViewMode('side'));
viewThOnlyBtn.addEventListener('click', () => setViewMode('th-only'));

function setViewMode(mode) {
  viewMode = mode;
  viewSideBtn.classList.toggle('active', mode === 'side');
  viewThOnlyBtn.classList.toggle('active', mode === 'th-only');
  renderChunks();
}

// font size
document.getElementById('fontPlus').addEventListener('click', () => {
  fontSize = Math.min(30, fontSize + 2);
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');
});
document.getElementById('fontMinus').addEventListener('click', () => {
  fontSize = Math.max(14, fontSize - 2);
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');
});

// theme
const themeToggle = document.getElementById('themeToggle');
themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  themeToggle.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
});

// ---------- Text-to-Speech (เสียงพากย์คุณภาพสูง ผ่าน backend) ----------
const ttsPlayPause = document.getElementById('ttsPlayPause');
const ttsPrev = document.getElementById('ttsPrev');
const ttsNext = document.getElementById('ttsNext');
const ttsSpeed = document.getElementById('ttsSpeed');
const voiceSelect = document.getElementById('voiceSelect');

const audioPlayer = new Audio();
let audioCache = new Map(); // index -> object URL, กันโหลดซ้ำถ้ากดย้อนกลับมาฟังซ้ำ

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
    if (!isReading || currentChunkIndex !== index) return; // ผู้ใช้กดหยุด/เปลี่ยนระหว่างโหลด
    audioPlayer.src = url;
    await audioPlayer.play();
    ttsPlayPause.textContent = '⏸ หยุดชั่วคราว';
  } catch (err) {
    homeError.textContent = '';
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
