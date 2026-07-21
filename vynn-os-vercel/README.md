# VYNN·OS — Deploy บน Vercel + Neon Postgres

แอป VYNN·OS เวอร์ชันขึ้นคลาวด์: หน้าเว็บเดิมทั้งหมด + ฐานข้อมูล **Neon (Postgres)**
โฮสต์ฟรีบน **Vercel** — ได้ลิงก์ `https://<ชื่อ>.vercel.app` เปิดใช้จากที่ไหน/เครื่องไหนก็ได้

```
เบราว์เซอร์ (public/index.html)
   │  GET/PUT /api/state
   ▼
Vercel serverless functions (api/state.js, api/health.js)
   │  SQL (ผ่าน @neondatabase/serverless)
   ▼
Neon serverless Postgres  ← ตารางถูกสร้างอัตโนมัติครั้งแรก
```

> ไม่ต้องลง Docker / Node ในเครื่อง — ทุกอย่าง build บนคลาวด์

---

## ขั้นตอน (ทำครั้งเดียว ~10–15 นาที)

### 1) สร้างฐานข้อมูล Neon (ฟรี)
1. สมัคร/เข้า https://neon.tech (ล็อกอินด้วย Google/GitHub ได้)
2. **Create Project** → ตั้งชื่อ เช่น `vynn-os` → เลือก region ใกล้ไทย เช่น **Singapore** → Create
3. หน้า **Connection Details** → เลือกแบบ **Pooled connection** → กด **Copy** สาย connection string
   หน้าตาประมาณ: `postgresql://user:PASS@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
   → **เก็บสายนี้ไว้** (ใช้ในขั้นตอนที่ 3)

### 2) เอาโค้ดขึ้น GitHub
เปิด **Git Bash** ที่โฟลเดอร์นี้ แล้วรัน (แก้ URL เป็น repo ของคุณ):
```bash
cd "/c/Users/NICKT/OneDrive/Desktop/vynn-os-vercel"
git init
git add .
git commit -m "VYNN-OS vercel"
# สร้าง repo เปล่าใน github.com ก่อน (New repository) แล้วเอา URL มาใส่:
git remote add origin https://github.com/<ชื่อคุณ>/vynn-os.git
git branch -M main
git push -u origin main
```
> ถ้าไม่อยากใช้ command line: ที่ github.com กด **New repository** → **uploading an existing file** → ลากไฟล์ทั้งโฟลเดอร์นี้ขึ้นไป (ยกเว้นโฟลเดอร์ `node_modules` ถ้ามี)

### 3) Deploy บน Vercel
1. สมัคร/เข้า https://vercel.com → **Continue with GitHub**
2. **Add New… → Project** → เลือก repo `vynn-os` ที่เพิ่ง push → **Import**
3. หน้า Configure — **ไม่ต้องตั้ง Build/Output อะไร** (Framework = Other, Vercel ตรวจ `api/` + `public/` ให้เอง)
4. เปิดหัวข้อ **Environment Variables** ใส่:
   - **Name:** `DATABASE_URL`
   - **Value:** วางสาย connection string จาก Neon (ข้อ 1)
5. กด **Deploy** → รอ ~1–2 นาที
6. เปิดลิงก์ `https://<ชื่อ>.vercel.app` → ใช้งานได้เลย ✅
   (ครั้งแรกแอปจะสร้างตาราง + ใส่ข้อมูลตัวอย่างให้อัตโนมัติ)

มุมขวาล่างจะมีป้าย **"● บันทึกแล้ว (ฐานข้อมูล)"** ทุกครั้งที่บันทึกจริงลง Neon

---

## ตรวจ / ดูข้อมูล
- เช็คว่าเชื่อม DB ได้: เปิด `https://<ชื่อ>.vercel.app/api/health` → ควรได้ `{"ok":true}`
- ดู/แก้ข้อมูลในตาราง: Neon dashboard → **SQL Editor** เช่น
  `SELECT id, name, stage FROM leads;` หรือ `SELECT * FROM travel_claims;`
- ตารางที่มี: `leads, surveys, quotes, installs, tickets, payments, employees, payroll,
  travel_claims, china_lots, fabric_orders, sewing, accounts, attendance, advances, monthly, app_meta`
  (แต่ละแถวมีคอลัมน์ query ได้ + คอลัมน์ `data` JSONB เก็บ object เต็ม)

## อัปเดตแอปภายหลัง
แก้โค้ดแล้ว `git push` — Vercel deploy ใหม่ให้อัตโนมัติทุกครั้ง
(ถ้าแก้หน้าเว็บ prototype ที่ `_source-body.html` ให้รัน `bash build.sh` เพื่อสร้าง `public/index.html` ใหม่ก่อน push)

---

## ข้อควรรู้ / ข้อจำกัด
- **Last-write-wins:** แก้พร้อมกัน 2 คน คนบันทึกทีหลังทับ (เหมาะทีมเล็ก/นำร่อง ยังไม่มี realtime)
- **ยังไม่มีระบบล็อกอิน** — ใครมีลิงก์ก็เข้าได้ (role switcher เป็นของสาธิต)
  ถ้าต้องการกันคนนอก: Vercel → Project → Settings → **Deployment Protection** (ตั้ง password ได้)
- **ขนาด payload:** Vercel serverless จำกัด request ~4.5MB ต่อครั้ง ถ้าอัปโหลด **รูป/สลิปจำนวนมาก**
  (เก็บเป็น base64) รวมกันเกินอาจบันทึกไม่ผ่าน → ป้ายจะขึ้น "ออฟไลน์" ให้ลดรูปลง
  (สเต็ปถัดไปถ้าต้องใช้รูปเยอะ: ย้ายไปเก็บที่ Vercel Blob / S3 แล้วเก็บแค่ URL)
- **Neon free tier** พอสำหรับนำร่อง; ฐานข้อมูลอาจ "sleep" ตอนไม่มีคนใช้ แล้วตื่นเองตอนเข้าใหม่ (ครั้งแรกช้าเล็กน้อย)

## สำรองข้อมูล
- ในแอป: ปุ่ม "สำรองข้อมูล" (โหลด JSON) / "กู้คืน" ใช้ได้ปกติ
- ทั้งฐานข้อมูล: Neon dashboard มีฟีเจอร์ backup/branching ในตัว
