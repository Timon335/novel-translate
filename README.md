# 📖 NovelTranslator — เว็บแปลนิยายอังกฤษเป็นไทย & อ่านออกเสียง

เว็บแอปพลิเคชันสำหรับดึงเนื้อหานิยายภาษาอังกฤษจาก URL แปลเป็นภาษาไทยด้วย AI แบบ Local (Ollama) จัดเก็บข้อมูลลงฐานข้อมูล PostgreSQL และอ่านออกเสียงภาษาไทยคุณภาพสูงด้วย Microsoft Edge TTS

---

## 🏗 โครงสร้างและเทคโนโลยี

โค้ดที่ใช้งานจริงอยู่ที่โฟลเดอร์รากของโปรเจกต์ (`server.js`, `public/`, และ `db-postgres.js`) ส่วนโฟลเดอร์ `novel-translator/` เป็นรุ่นเก่าที่ใช้ Gemini และไม่มี Bookshelf/PostgreSQL ไม่ควรใช้เป็น entrypoint หลัก

- **Backend**: Node.js + Express
- **Database**: PostgreSQL (จัดการผ่าน `pg` Pool พร้อม Migration script)
- **AI Translation**: Ollama (`qwen2.5:14b` หรือโมเดลที่กำหนด)
- **Web Scraping**: Cheerio (คัดกรองเนื้อหาหลัก ตัดปุ่มนำทาง เมนู และคอมเมนต์ออก)
- **TTS**: `msedge-tts` (เสียงพากย์ Neural ภาษาไทย ฟรี ไม่ต้องใช้ API Key)
- **Frontend**: Single Page Application (HTML5 / Vanilla JS / CSS Variables รองรับ Dark Mode)

---

## ⚙️ ข้อกำหนดเบื้องต้น

1. **Node.js**: เวอร์ชัน 20 หรือสูงกว่า
2. **PostgreSQL**: มีฐานข้อมูลพร้อมใช้งาน
3. **Ollama**: ติดตั้งและดาวน์โหลดโมเดลแปลภาษา เช่น:
   ```bash
   ollama pull qwen2.5:14b
   ```

---

## 🚀 ขั้นตอนการติดตั้งและเริ่มต้นใช้งาน

### 1. ติดตั้ง Dependencies
```bash
npm install
```

### 2. ตั้งค่าไฟล์ Environment (.env)
คัดลอกไฟล์ `.env.example` เป็น `.env`:
```bash
cp .env.example .env
```
กำหนดค่าใน `.env`:
```env
# URL สำหรับเชื่อมต่อฐานข้อมูล PostgreSQL
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/novel_translator

# Ollama สำหรับแปลภาษา
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:14b

# พอร์ตสำหรับเซิร์ฟเวอร์
PORT=3000
```

### 3. รัน Migration เพื่อสร้างตารางใน PostgreSQL
```bash
npm run migrate
```
*(กรณีต้องการย้ายข้อมูลเดิมจาก SQLite ให้ใช้ `npm run migrate:sqlite`)*

### 4. ทดสอบความพร้อมของระบบ (Smoke Test)
```bash
npm run test:smoke
```
คำสั่งนี้จะตรวจการเชื่อมต่อ PostgreSQL, สถานะโมเดล Ollama, สตรีมเสียง Edge TTS และ Data Layer

### 5. รันเซิร์ฟเวอร์
```bash
npm start
```
เปิดเบราว์เซอร์ไปที่: [http://localhost:3000](http://localhost:3000)

### 6. ตรวจสอบโค้ดและ workflow
```bash
npm run test:syntax
npm run test:e2e
```

`test:e2e` ต้องมี PostgreSQL, Ollama และโมเดลตามค่าใน `.env` พร้อมใช้งาน โดยจะสร้างข้อมูลทดสอบแล้วลบออกเมื่อจบการทดสอบ

---

## 💡 ฟีเจอร์หลัก

1. **📚 คลังนิยาย (Bookshelf)**:
   - เพิ่ม ลบ และจัดการนิยายหลายเรื่อง
   - บันทึกตอนแยกเป็นบทๆ เหมือนเว็บนิยายชั้นนำ
2. **⚡ แปลตอนใหม่ (Single & Batch Mode)**:
   - **ตอนเดียว**: ใส่ URL ของบทที่ต้องการเพื่อเริ่มแปล
   - **หลายตอน (Batch)**: ใส่ URL ตอนแรกและตอนสุดท้าย ระบบจะสร้างลำดับ URL ทีละ +1 และแปลต่อเนื่องอัตโนมัติ
3. **📖 คลังคำศัพท์เฉพาะ (Glossary)**:
   - ระบบสกัดชื่อตัวละคร สถานที่ และคำเฉพาะระหว่างแปล
   - จดจำคำศัพท์ข้ามตอน และนำไปใช้แปลตอนถัดๆ ไปเพื่อความสอดคล้อง
4. **👓 โหมดการอ่าน (Reader)**:
   - สลับระหว่าง **อ่านคู่กัน (EN/TH)** หรือ **อ่านไทยอย่างเดียว**
   - ปรับขนาดตัวอักษร (A- / A+)
   - เปลี่ยนโหมดสี สว่าง/มืด (Theme Dark/Light)
5. **🔊 ระบบอ่านออกเสียง (TTS)**:
   - เสียงผู้หญิง (เปรมวดี) และเสียงผู้ชาย (นิวัฒน์)
   - ปรับความเร็วเสียงพูดได้ตามต้องการ
   - เลื่อนหน้าจอตามย่อหน้าที่กำลังอ่านโดยอัตโนมัติ

## ⚠️ ข้อจำกัดที่ควรรู้

- งานแปลเก็บสถานะไว้ใน memory ของเซิร์ฟเวอร์ งานที่กำลังทำจะหายเมื่อรีสตาร์ตเซิร์ฟเวอร์
- Batch สร้าง URL จากตัวเลขท้าย path และจำกัดไม่เกิน 100 ตอนต่อครั้ง
- การ scrape จำกัดเวลาและขนาดหน้าเว็บตามค่าใน `.env.example`
- ระบบนี้เหมาะกับการใช้งานในเครื่องหรือเครือข่ายส่วนตัว ยังไม่มีระบบผู้ใช้และ authentication สำหรับเปิดสาธารณะ

---

## 🛠 คำสั่ง npm scripts

| คำสั่ง | คำอธิบาย |
|---|---|
| `npm start` | รันเซิร์ฟเวอร์หลัก |
| `npm run migrate` | สร้างโครงสร้างตารางใน PostgreSQL |
| `npm run migrate:sqlite` | ย้ายข้อมูลจาก SQLite เดิมเข้าสู่ PostgreSQL |
| `npm run test:smoke` | ตรวจสอบสุขภาพของระบบ (PostgreSQL, Ollama, TTS, Data Layer) |
| `npm run test:syntax` | ตรวจ syntax ของ backend และ test scripts |
| `npm run test:e2e` | ทดสอบแปล บันทึก PostgreSQL อ่านข้อมูล และสร้างเสียงครบ workflow |
