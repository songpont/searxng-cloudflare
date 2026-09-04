# 🌊 River Watch — SearXNG on Cloudflare

> SearXNG แบบ self-hosted ที่รันเป็น **Cloudflare Container** พร้อมท่อเก็บข่าว (news pipeline)
> ที่ตามติดสถานการณ์ **สารพิษปนเปื้อนแม่น้ำกก · สาย · โขง · สาละวิน** โดยอัตโนมัติ
> แล้วให้ AI สรุปเป็นรายงานรายสัปดาห์ภาษาไทย

<p align="center">
  <a href="https://cloudflare-searxng.songpont.workers.dev">🔗 cloudflare-searxng.songpont.workers.dev</a>
</p>

---

## สารบัญ

- [ภาพรวม](#ภาพรวม)
- [สถาปัตยกรรม](#สถาปัตยกรรม)
- [ท่อเก็บข่าว (News Pipeline)](#ท่อเก็บข่าว-news-pipeline)
- [โครงสร้างโปรเจกต์](#โครงสร้างโปรเจกต์)
- [ติดตั้งและ deploy](#ติดตั้งและ-deploy)
- [การตั้งค่าแหล่งข่าว](#การตั้งค่าแหล่งข่าว)
- [API](#api)
- [ตารางเวลา (Cron)](#ตารางเวลา-cron)
- [พัฒนาและทดสอบในเครื่อง](#พัฒนาและทดสอบในเครื่อง)
- [บันทึกทางเทคนิค](#บันทึกทางเทคนิค)

---

## ภาพรวม

โปรเจกต์นี้มี 2 ส่วนที่ทำงานร่วมกันบน Worker ตัวเดียว:

| ส่วน | ทำอะไร |
|------|--------|
| **Search proxy** | รัน SearXNG 2 อินสแตนซ์เป็น Cloudflare Container มี failover ระหว่างกัน และปรับ config (ภาษา / engine / หมวด) ผ่าน REST หรือแชตกับ LLM ได้ |
| **News pipeline** | ทุกวันดึงข่าวจากแหล่งที่กำหนดใน [`config/sources.json`](config/sources.json) → เสริมเนื้อหาเต็มของบทความ → ให้ AI ขุดคำค้นต่อยอด → เก็บลง D1 → ทุกสัปดาห์สรุปเป็นรายงานภาษาไทยพร้อมอ้างอิงลิงก์ |

หน้าเว็บ ([`public/index.html`](public/index.html)) แสดงรายงานรายสัปดาห์ + ฟีดข่าวที่เก็บได้ พร้อมป้ายระดับความน่าเชื่อถือของแต่ละแหล่ง

---

## สถาปัตยกรรม

```mermaid
flowchart TD
    subgraph CF["Cloudflare Worker"]
        W["Worker (src/index.ts)<br/>REST API + static assets"]
        CS["ConfigStore<br/>(Durable Object)"]
        subgraph C["SearxngContainer × 2"]
            P["primary"]
            S["secondary"]
        end
        DB[("D1<br/>river-watch-db")]
    end

    U["ผู้ใช้ / เบราว์เซอร์"] -->|"GET /"| W
    A["ผู้ดูแล"] -->|"Bearer ADMIN_TOKEN"| W
    W <-->|"อ่าน/แก้ config"| CS
    W -->|"/search?format=json"| C
    W -->|"อ่านข่าว + รายงาน"| DB

    CRON["Cron Triggers"] -->|"รายวัน 03:00 ICT"| W
    CRON -->|"รายสัปดาห์ อังคาร 03:00 ICT"| W

    W -->|"ดึง RSS / ค้น site:"| EXT["แหล่งข่าวภายนอก<br/>(Bangkok Post, MRC, ...)"]
    W -->|"สกัดคำค้น + สรุปข่าว"| LLM["DeepSeek API"]
```

**องค์ประกอบหลัก**

- **Worker** — เราเตอร์ REST เดียว จัดการทั้ง API สาธารณะ, API ผู้ดูแล (ต้องมี `Authorization: Bearer <ADMIN_TOKEN>`) และเสิร์ฟไฟล์ static
- **SearxngContainer** — คลาส [`Container`](https://developers.cloudflare.com/containers/) รัน image `searxng/searxng` สอง instance (`primary`, `secondary`) นอน (`sleepAfter`) หลังไม่มีทราฟฟิก 5 นาที การมีสองตัวช่วยได้จริงเพราะแต่ละ process จำสถานะ engine-suspension แยกกัน — ถ้า Google ถูกแบนใน primary ก็ fail over ไป secondary ได้
- **ConfigStore** — Durable Object เก็บ config การค้นหาที่ผู้ดูแลปรับไว้ (แยกจาก config ของ automation ที่ล็อกค่าไว้ตายตัว)
- **D1 `river-watch-db`** — ตาราง `articles` และ `weekly_summaries` (สคีมาใน [`migrations/0001_init.sql`](migrations/0001_init.sql))

---

## ท่อเก็บข่าว (News Pipeline)

```mermaid
flowchart LR
    K["keywords + sources<br/>(config/sources.json)"] --> R1

    subgraph R1["รอบ 1 — กวาดตามแหล่งที่กำหนด"]
        RSS["type: rss<br/>ดึงฟีด → กรองด้วย keyword"]
        SITE["type: site<br/>ค้น SearXNG ด้วย 'keyword site:domain'"]
        PAGE["type: page<br/>โหลด URL ตรงๆ → เก็บลิงก์บนหน้า"]
    end

    R1 --> ENRICH["เสริมเนื้อหาเต็ม<br/>fetchArticleText()<br/>ดึงหน้าบทความ → สกัดย่อหน้านำ"]
    ENRICH --> INS[("บันทึกลง D1<br/>(INSERT OR IGNORE ตาม url)")]

    INS --> R2

    subgraph R2["รอบ 2 — ขุดต่อโดย AI (trust = web)"]
        Q["DeepSeek สกัดคำค้นเจาะจง 3–5 คำ<br/>(ชื่อบริษัท/หน่วยงาน/สถานที่)"]
        WEB["ค้นเว็บเปิดด้วยคำค้นนั้น"]
    end

    R2 --> INS

    INS --> SUM["รายสัปดาห์:<br/>runWeeklySummary()<br/>รวมข่าว 7 วัน → DeepSeek → รายงานไทย + อ้างอิงลิงก์"]
    SUM --> SDB[("weekly_summaries")]
```

**ระดับความน่าเชื่อถือ (`trust`)** ใช้จัดลำดับการอ้างอิงตอนสรุป:

| `trust` | ความหมาย | ปฏิบัติต่อ |
|---------|----------|-----------|
| `official` | หน่วยงานราชการ / องค์กรระหว่างประเทศ | อ้างอิงก่อน |
| `news` | สื่อมวลชน | ใช้เสริมบริบท |
| `social` | โซเชียลมีเดีย | ใช้เสริม |
| `web` | ผลจากการค้นเว็บเปิดโดย AI (รอบ 2) | **ยังไม่ยืนยัน** — ต้องกำกับทุกครั้งที่อ้างถึง |

---

## โครงสร้างโปรเจกต์

```
├── src/
│   ├── index.ts              เราเตอร์ Worker + handler ของ cron
│   ├── search.ts             SearxngContainer, ConfigStore, failover, buildSearchUrl
│   ├── env.ts                interface ของ bindings/secrets
│   └── news/
│       ├── collector.ts      รอบ 1 + รอบ 2, เขียนลง D1
│       ├── rss.ts            พาร์เซอร์ RSS/Atom (regex ไม่มี DOM)
│       ├── article-content.ts ดึงหน้าบทความ + สกัดข้อความ + คลาย gzip เอง
│       └── summarizer.ts     รายงานรายสัปดาห์
├── config/
│   └── sources.json          ⭐ แก้ที่นี่เพื่อเพิ่ม/ลบแหล่งข่าว แล้ว deploy
├── migrations/
│   └── 0001_init.sql         สคีมา D1
├── searxng/
│   └── settings.yml          ค่า SearXNG (ใส่ secret_key ของตัวเองก่อนใช้จริง)
├── public/
│   └── index.html            แดชบอร์ด (Thai, vanilla JS)
├── Dockerfile                image ของ container
├── docker-compose.test.yml   รัน SearXNG 2 ตัวในเครื่องเพื่อทดสอบ
└── wrangler.jsonc            bindings, cron, container, D1
```

---

## ติดตั้งและ deploy

**สิ่งที่ต้องมี:** Node.js 18+, บัญชี Cloudflare (แผนที่รองรับ Containers), Docker (สำหรับ build image ตอน deploy), API key ของ DeepSeek

```bash
# 1. ติดตั้ง dependencies
npm install

# 2. สร้าง D1 database แล้วเอา database_id ไปใส่ใน wrangler.jsonc
npx wrangler d1 create river-watch-db
npx wrangler d1 execute river-watch-db --remote --file migrations/0001_init.sql

# 3. ตั้ง secrets (ทำครั้งเดียว)
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put ADMIN_TOKEN     # openssl rand -hex 32

# 4. ใส่ secret_key ของตัวเองใน searxng/settings.yml
#    openssl rand -hex 32

# 5. deploy (จะ build Docker image ของ container ให้ด้วย)
npm run deploy
```

> `DEEPSEEK_MODEL` ตั้งไว้ใน `wrangler.jsonc` (`vars`) ค่าเริ่มต้น `deepseek-chat`
> ถ้าไม่ตั้ง `DEEPSEEK_API_KEY` ระบบยังเก็บข่าวรอบ 1 ได้ แต่รอบ 2 (AI) และการสรุปจะถูกข้าม

---

## การตั้งค่าแหล่งข่าว

แก้ [`config/sources.json`](config/sources.json) แล้วรัน `npm run deploy` — **ไม่ต้องแตะโค้ด**

```jsonc
{
  "keywords": [
    "แม่น้ำกก สารพิษ",
    "Mekong river pollution"
    // ...ใช้กรอง item ของ source แบบ rss และเป็นคำค้นของ source แบบ site
  ],
  "sources": [
    {
      "id": "bangkokpost-rss",
      "name": "Bangkok Post — Thailand",
      "type": "rss",              // ดึงทั้งฟีดแล้วกรองด้วย keywords
      "trust": "news",
      "enabled": true,
      "url": "https://www.bangkokpost.com/rss/data/thailand.xml"
    },
    {
      "id": "onwr",
      "name": "สำนักงานทรัพยากรน้ำแห่งชาติ",
      "type": "site",             // ค้นผ่าน SearXNG ด้วย 'keyword site:domain'
      "trust": "official",
      "enabled": true,
      "domain": "onwr.go.th"
    },
    {
      "id": "some-listing",
      "name": "หน้ารวมข่าวสิ่งแวดล้อม",
      "type": "page",             // โหลดหน้านี้ตรงๆ เก็บลิงก์บนหน้าเป็นรายการข่าว
      "trust": "news",
      "enabled": true,
      "url": "https://example.gov.th/news/environment",
      "include": "/news/",        // (ออปชัน) เอาเฉพาะลิงก์ที่ URL มีข้อความนี้
      "matchKeywords": true       // (ออปชัน) กรองด้วย keywords อีกชั้นหลังดึงเนื้อหา
    }
  ]
}
```

| ฟิลด์ | จำเป็นเมื่อ | หมายเหตุ |
|-------|-----------|----------|
| `type` | เสมอ | `"rss"` \| `"site"` \| `"page"` |
| `url` | `type: rss` / `page` | RSS feed จริง / URL ของหน้ารายการข่าว |
| `domain` | `type: site` | เช่น `bangkokpost.com` หรือ `bangkokpost.com/thailand` หรือ `facebook.com/ชื่อเพจ` |
| `include` | — (`type: page`) | เก็บเฉพาะลิงก์ที่ URL มี substring นี้ เช่น `"/news/"` |
| `crossHost` | — (`type: page`) | `true` = ตามลิงก์ไปโดเมนอื่นด้วย (ค่าเริ่มต้น: host เดียวกับหน้าเท่านั้น) |
| `matchKeywords` | — (`type: page`) | `true` = ต้องตรง keywords (เช็คทั้งข้อความลิงก์และเนื้อข่าวที่ดึงมา) |
| `trust` | เสมอ | `official` \| `news` \| `social` |
| `enabled` | — | ตั้ง `false` เพื่อปิดชั่วคราวโดยไม่ต้องลบ |

> **`type: page` เหมาะกับหน้าที่ server render มา** (เว็บหน่วยงานส่วนใหญ่) — ถ้าหน้าเป็น JS render อย่างหน้าแท็กของ Bangkok Post ตัว HTML จะมีแต่ลิงก์ nav ทั่วไป ให้ใช้ `type: site` แทน หรือเปิด `matchKeywords: true` ให้กรองด้วยเนื้อข่าวจริงอีกชั้น

---

## API

ทุก endpoint ที่ทำเครื่องหมาย 🔒 ต้องมี header `Authorization: Bearer <ADMIN_TOKEN>`

| Method | Path | คำอธิบาย |
|--------|------|----------|
| `GET` | `/` | แดชบอร์ด (static) — 3 แท็บ: สรุปรายสัปดาห์ / ข่าวทั้งหมด / สถิติ |
| `GET` | `/api/news?limit=50&page=1` | ข่าวที่เก็บได้ ล่าสุดก่อน · `limit` = ต่อหน้า (1–100), คืน `total` มาด้วย |
| `GET` | `/api/stats` | สถิติรวม: `perDay` (ต่อวัน แยกตาม trust), `byTrust`, `bySource` |
| `GET` | `/api/summary/latest` | รายงานรายสัปดาห์ล่าสุด |
| `GET` | `/api/summaries?limit=26` | รายการรายงานย้อนหลัง |
| `GET` | 🔒 `/api/search?q=...` | ค้นผ่าน SearXNG (ใช้ config ของผู้ดูแล) |
| `GET` | 🔒 `/api/config` | อ่าน config การค้นหา |
| `POST` | 🔒 `/api/config` | แก้ config (`{ "language": "th", "engines": ["google"] }`) |
| `POST` | 🔒 `/api/chat` | สั่งปรับ config เป็นภาษาคน ผ่าน LLM (`{ "message": "..." }`) |
| `POST` | 🔒 `/api/collect` | รันรอบเก็บข่าวทันที (ไม่ต้องรอ cron) |
| `POST` | 🔒 `/api/summarize` | สร้างรายงานรายสัปดาห์ทันที |

```bash
# ตัวอย่าง: เก็บข่าวเดี๋ยวนี้
curl -X POST https://<your-worker>/api/collect \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

---

## ตารางเวลา (Cron)

กำหนดใน `wrangler.jsonc` (เวลาเป็น UTC — ICT = UTC+7)

| Cron | เวลาไทย | งาน |
|------|---------|-----|
| `0 20 * * *` | ทุกวัน 03:00 | `runDailyCollection` — เก็บข่าวรอบ 1 + รอบ 2 |
| `0 20 * * 1` | อังคาร 03:00 | `runWeeklySummary` — สรุปข่าว 7 วันก่อนหน้า |

---

## พัฒนาและทดสอบในเครื่อง

```bash
# Worker + container ในเครื่อง
npm run dev

# หรือรัน SearXNG 2 ตัวแยก (พอร์ต 8081 / 8082) เพื่อลองพฤติกรรม failover
docker compose -f docker-compose.test.yml up
```

สร้าง `.dev.vars` จากตัวอย่าง:

```bash
cp .dev.vars.example .dev.vars   # แล้วเติมค่าจริง
```

D1 ในเครื่องรันไฟล์ migration แบบเดียวกัน แต่ใส่ `--local` แทน `--remote`

---

## บันทึกทางเทคนิค

- **ไม่มี DOM ใน Workers** — ทั้ง `rss.ts` และ `article-content.ts` ใช้ regex ล้วน สกัดพอได้ย่อหน้านำของหน้าข่าวทั่วไป ไม่ได้ครอบคลุมทุก layout
- **การคลาย gzip เอง** — บาง origin (เช่น Bangkok Post หลัง CDN ByteArk) ส่ง `Content-Encoding: gzip` กลับมาเสมอแม้ runtime ไม่ได้ร้องขอ ทำให้ `res.text()` ได้ไบต์ขยะ `article-content.ts` จึงตรวจ gzip magic number (`0x1f 0x8b`) เองแล้วคลายด้วย `DecompressionStream` — ถ้า runtime คลายให้แล้วก็ปล่อยผ่าน
- **แก้ข้อความกลับหัว (reversed-text)** — Bangkok Post เขียนเนื้อบทความแบบ**สลับตัวอักษรจากหลังมาหน้า**ใน HTML แล้วพลิกกลับด้วย CSS (`unicode-bidi: bidi-override`) เพื่อกัน scraper `extractArticleText` จึงตรวจทีละบรรทัดว่ากลับหัวไหม (นับคำเชื่อมภาษาอังกฤษแบบปกติเทียบกับแบบกลับหัว) แล้ว reverse บรรทัดนั้นคืน ถ้ายังอ่านไม่ออกก็คืน `null` เพื่อ fallback ไปใช้ snippet จาก RSS แทน
- **automation ใช้ config ล็อกไว้** — collector ค้นด้วย `AUTOMATION_DEFAULTS` เสมอ ไม่รับค่าที่ผู้ดูแลปรับไว้เอง (เช่น บังคับ `language: th` จะทำให้คำค้นภาษาอังกฤษได้ผลลัพธ์ศูนย์)
- **กันข่าวซ้ำ** — `INSERT OR IGNORE` ตามคอลัมน์ `url` (UNIQUE) การค้นซ้ำจะไม่เขียนทับของเดิม
- **ช่วงเวลาของรายงาน** — ยึด `published_at` ของข่าวเป็นหลัก ข่าวที่ไม่รู้วันที่ถึง fallback ไปใช้ `collected_at` เพื่อไม่ให้ตกหล่น
