# แผน: Multi-collection + Admin UI (config ใน D1 + Cloudflare Access)

สถานะ: **ร่างแผน — ยังไม่เริ่มลงมือ**
อัปเดตล่าสุด: 2026-09-04

---

## 1. เป้าหมาย

| # | สิ่งที่ต้องการ | ผลลัพธ์ |
|---|---|---|
| 1 | **Multi-collection** | หนึ่ง deployment ตามได้หลายหัวข้อพร้อมกัน แต่ละหัวข้อมี keywords / sources / รายงานรายสัปดาห์ ของตัวเอง แยกกันเด็ดขาด |
| 2 | **Config ย้ายไป D1** | เพิ่ม/แก้ collection และ source ผ่านเว็บ มีผลทันที **ไม่ต้อง `npm run deploy`** |
| 3 | **Admin UI หลัง Cloudflare Access** | หลายคนเข้ามาจัดการได้ ผ่าน SSO ไม่ต้องเขียน auth เอง |
| 4 | **Dashboard สาธารณะเดิม** | ยังเปิด public อ่านอย่างเดียว เพิ่มแค่ตัวสลับ collection |

> **หมายเหตุเรื่อง deploy:** เมื่อ config อยู่ใน D1 แล้ว การแก้ collection/source **ไม่ต้อง deploy** เลย — cron รอบถัดไปหรือปุ่ม "Run now" หยิบไปใช้ทันที
> `wrangler deploy` เหลือไว้สำหรับ **แก้โค้ด** เท่านั้น ถ้าอยากให้ deploy อัตโนมัติตอน push (เช่น GitHub Actions ทุก 18:00) เป็นงาน DevOps แยก ไม่ผูกกับฟีเจอร์นี้ — ใส่ไว้ท้ายแผนเป็น optional

---

## 2. สถาปัตยกรรมปัจจุบัน (ก่อนแก้)

- `config/sources.json` ถูก `import` เข้า Worker ตอน build → static ต้อง redeploy ทุกครั้งที่แก้
- D1 `river_watch_db`: ตาราง `articles`, `weekly_summaries` — **ไม่มีมิติ "หัวข้อ"**
- `runDailyCollection(env)` วน `config.sources` + ใช้ `config.keywords` ชุดเดียว
- `runWeeklySummary(env)` สรุปข่าวทั้งหมดในสัปดาห์รวมกัน
- `ConfigStore` (Durable Object) เก็บแค่ค่า SearXNG (language/engines/safesearch) ไม่เกี่ยวกับ sources
- Auth: `ADMIN_TOKEN` แบบ bearer static ใช้กับ `/api/config` `/api/chat` `/api/collect` `/api/summarize` `/api/search` — **ไม่มีหน้า login**, dashboard เปิด public

---

## 3. Data model ใหม่ (D1)

### migration `0002_collections.sql`

```sql
CREATE TABLE collections (
  id            TEXT PRIMARY KEY,          -- slug เช่น "rivers"
  name          TEXT NOT NULL,
  keywords      TEXT NOT NULL DEFAULT '[]',-- JSON array
  max_age_days  INTEGER,                   -- NULL = ไม่จำกัด
  summary_prompt TEXT,                     -- override system prompt ตอนสรุป (NULL = ใช้ default)
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE sources (
  id             TEXT PRIMARY KEY,         -- slug/uuid
  collection_id  TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,            -- 'rss' | 'site' | 'page'
  trust          TEXT NOT NULL,            -- 'official' | 'news' | 'social'
  enabled        INTEGER NOT NULL DEFAULT 1,
  url            TEXT,                     -- rss/page
  domain         TEXT,                     -- site
  include        TEXT,                     -- page: substring ที่ URL ต้องมี
  url_allow      TEXT,                     -- regex ที่ URL ข่าวต้อง match
  url_deny       TEXT,                     -- regex ที่ URL ต้องไม่ match
  query_extra    TEXT,                     -- ต่อท้ายทุก query ของ source นี้ (เช่น "-inurl:page_id")
  require_date   INTEGER NOT NULL DEFAULT 0,-- 1 = ทิ้งข่าวที่ enrich แล้วยังไม่มีวันที่
  cross_host     INTEGER NOT NULL DEFAULT 0,-- page
  match_keywords INTEGER NOT NULL DEFAULT 0,-- page
  max_age_days   INTEGER,                  -- override ระดับ collection
  note           TEXT,
  last_run_at    TEXT,
  last_run_count INTEGER,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_sources_collection ON sources(collection_id);

ALTER TABLE articles ADD COLUMN collection_id TEXT;
CREATE INDEX idx_articles_collection ON articles(collection_id, collected_at);
-- ยกเลิก UNIQUE(url) เดิม เปลี่ยนเป็น unique ต่อ collection:
CREATE UNIQUE INDEX idx_articles_collection_url ON articles(collection_id, url);

ALTER TABLE weekly_summaries ADD COLUMN collection_id TEXT;
CREATE INDEX idx_summaries_collection ON weekly_summaries(collection_id, created_at);
```

> **หมายเหตุ:** SQLite เปลี่ยน UNIQUE constraint เดิมบนคอลัมน์ `url` ไม่ได้ตรง ๆ — ต้อง migrate แบบ create-new-table + copy หรือยอมมี unique index เพิ่มแล้วเลิกใช้ของเดิมในโค้ด รายละเอียดตอนลงมือ

### field ของ source รวมงานที่ค้างจากบทสนทนาก่อน

`url_allow` / `url_deny` (regex), `query_extra`, `require_date` — คือคำตอบของ 2 คำถามก่อนหน้า (กรอง URL เป็น regex + ทำให้ได้ข่าวจริงไม่ใช่หน้า landing) ย้ายมาเป็น field ใน DB เลย

ตัวอย่าง onwr: `type=site`, `url_allow="\\?p=\\d+"` (เอาเฉพาะ press release) หรือเปลี่ยนเป็น `type=page`, `url="https://www.onwr.go.th/?page_id=1070"`, `include="?p="`

### keywords

เก็บเป็น JSON array ใน `collections.keywords` (v1) — ถ้าต่อไปอยากได้ analytics รายคำค้นค่อยแยกเป็นตาราง `keywords`

---

## 4. Config source of truth

- **D1 คือตัวจริง**
- `config/sources.json` เหลือบทบาทเดียว: **seed ตอน bootstrap** — migration/สคริปต์อ่านไฟล์นี้ insert เป็น collection `"rivers"` ครั้งเดียวถ้าตาราง `collections` ว่าง
- ตัด `import sourcesFile` ออกจาก hot path ของ collector (Phase 4)

---

## 5. API

### สาธารณะ (เดิม + เพิ่ม `?collection=`)

| Method | Path | หมายเหตุ |
|---|---|---|
| `GET` | `/api/collections` | list `{id, name}` สำหรับตัวสลับใน dashboard |
| `GET` | `/api/news?collection=<id>&page=&limit=` | ค่า default: collection แรกที่ enabled |
| `GET` | `/api/stats?collection=<id>` | |
| `GET` | `/api/summaries?collection=<id>` | |
| `GET` | `/api/summary/latest?collection=<id>` | |

### Admin (หลัง Cloudflare Access — path `/api/admin/*`)

| Method | Path | ทำอะไร |
|---|---|---|
| `GET` `POST` | `/api/admin/collections` | list / สร้าง |
| `GET` `PATCH` `DELETE` | `/api/admin/collections/:id` | |
| `GET` `POST` | `/api/admin/collections/:id/sources` | list / เพิ่ม source |
| `PATCH` `DELETE` | `/api/admin/sources/:id` | |
| `POST` | `/api/admin/sources/:id/test` | **dry-run** — คืนรายการข่าวที่จะเก็บ (title, url, date, จะเก็บ/ตัด + เหตุผล) โดยไม่ INSERT |
| `POST` | `/api/admin/collections/:id/collect` | สั่งเก็บทันที |
| `POST` | `/api/admin/collections/:id/summarize` | สั่งสรุปทันที |

> `/api/admin/*` รับ `ADMIN_TOKEN` bearer เป็นทางเลือกด้วย (สำหรับ script/CI) นอกเหนือจาก Access

---

## 6. Auth — Cloudflare Access (Zero Trust)

- เปิด Zero Trust บน account → สร้าง **Access Application** ครอบ `/admin*` และ `/api/admin/*`
- Policy: allow เฉพาะอีเมลที่กำหนด หรือ Google Workspace SSO
- Worker ตรวจ header `Cf-Access-Jwt-Assertion` เป็น defense-in-depth:
  - ดึง public keys จาก `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
  - verify JWT (`aud` = Application Audience tag, `iss` = team domain, exp)
  - เก็บ `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` เป็น vars ใน `wrangler.jsonc`
- Dashboard สาธารณะ + read API เดิม **ไม่แตะ** ยังเปิด public

ทางเลือกรอง (ถ้ายังไม่อยากตั้ง Zero Trust): หน้า `/admin/login` รับ `ADMIN_TOKEN` เก็บใน `localStorage` แนบเป็น bearer — หยาบกว่า เหมาะ single-admin

---

## 7. การเปลี่ยนโค้ด (ไฟล์ต่อไฟล์)

| ไฟล์ | เปลี่ยนอะไร |
|---|---|
| `migrations/0002_collections.sql` | **ใหม่** — schema ข้อ 3 |
| `src/news/sources.ts` | **ใหม่** — D1 accessor: `listCollections()`, `getSourcesFor(collectionId)`, CRUD |
| `src/news/collector.ts` | โหลด keywords/sources จาก D1, `runDailyCollection(env, collectionId?)` วนทุก collection, tag `collection_id`, ใช้ `url_allow`/`url_deny`/`query_extra`/`require_date`, dedup เป็น `(collection_id, url)` |
| `src/news/summarizer.ts` | `runWeeklySummary(env, collectionId)` ต่อ collection, ใช้ `summary_prompt` override, เขียน `collection_id` |
| `src/admin.ts` | **ใหม่** — handler ของ `/api/admin/*` |
| `src/auth.ts` | **ใหม่** — verify Cloudflare Access JWT |
| `src/index.ts` | route `/api/admin/*`, `/api/collections`, ใส่ `?collection=` ให้ API เดิม, เสิร์ฟ `/admin` |
| `public/index.html` | ตัวสลับ collection (dropdown) + จำค่าใน `localStorage` + hash `#<collection>/<tab>` |
| `public/admin.html` | **ใหม่** — UI จัดการ (ข้อ 8) |
| `config/sources.json` | เหลือเป็น seed อย่างเดียว + คอมเมนต์บอก |
| `wrangler.jsonc` | vars `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` |
| `README.md` | อัปเดต |

---

## 8. Admin UI (`/admin` — vanilla JS ให้เข้ากับ dashboard เดิม)

- **หน้า Collections**: ตาราง — ชื่อ, จำนวน source, จำนวนข่าว, เก็บล่าสุดเมื่อไหร่, toggle enabled, ปุ่ม "Run now" / "Summarize now"
- **หน้าแก้ Collection**: ชื่อ, keywords (tag input), `max_age_days`, `summary_prompt`
- **หน้า Sources ของ collection**: ตาราง — type, trust, เป้าหมาย (url/domain), enabled, ผลรอบล่าสุด (`last_run_count` / `last_error`), ปุ่ม edit/delete
- **ฟอร์มแก้ Source**: type (rss/site/page) → แสดง field ตามชนิด, trust, url/domain, include, url_allow, url_deny, query_extra, require_date, cross_host, match_keywords, max_age_days
- **ปุ่ม "Test"**: เรียก `/api/admin/sources/:id/test` โชว์ผลลัพธ์ dry-run เป็นตาราง (จะเก็บ/ตัด + เหตุผล เช่น "เก่ากว่า 60 วัน", "url ไม่ match url_allow", "ไม่มีวันที่ + require_date")

> UI เริ่มซับซ้อนขึ้น ถ้าถึงจุดที่ vanilla เริ่มลำบากค่อยพิจารณา build step + framework — v1 เอา vanilla ไปก่อน

---

## 9. Cron / scheduling

- Cron เดิมไม่เปลี่ยน: `0 20 * * *` เก็บข่าว (วนทุก collection), `0 20 * * 1` สรุป (วนทุก collection)
- **ไม่ต้องมี deploy-cron** สำหรับ config เพราะ config เป็นข้อมูลแล้ว
- อนาคต: schedule override ต่อ collection (บาง topic เก็บถี่กว่า) — นอก scope v1

---

## 10. แผนเป็น Phase (ชิปทีละอัน)

### Phase 1 — schema + อ่านจาก D1 (ไม่มี UI)
- [ ] migration `0002_collections.sql`
- [ ] seed: `config/sources.json` → collection `"rivers"` (รันครั้งเดียวถ้า `collections` ว่าง)
- [ ] `src/news/sources.ts` — D1 accessor
- [ ] collector/summarizer อ่าน D1, วน collection, รับ `collection` param (default = ทุกอัน / อันแรก)
- [ ] public API รับ `?collection=`, เพิ่ม `GET /api/collections`
- [ ] dashboard เพิ่ม dropdown (แม้จะมี collection เดียว)
- [ ] backfill `articles.collection_id = 'rivers'` ให้ข้อมูลเดิม
- **ชิปได้โดยผู้ใช้ไม่รู้สึกต่าง**

### Phase 2 — Access + admin API
- [ ] ตั้ง Cloudflare Access ครอบ `/admin*`, `/api/admin/*`
- [ ] `src/auth.ts` verify Access JWT
- [ ] `src/admin.ts` CRUD endpoints + `/test` + `/collect` + `/summarize`

### Phase 3 — Admin UI
- [ ] `public/admin.html` — หน้า collections / sources / ฟอร์ม / ปุ่ม test
- [ ] ขัดเกลา, จัดการ error, loading states

### Phase 4 — cleanup
- [ ] ตัด `import sourcesFile` ออกจาก hot path (เหลือเป็น seed)
- [ ] อัปเดต README + docs
- [ ] (optional) GitHub Actions `wrangler deploy` on push to main

---

## 11. เรื่องที่ต้องตัดสินใจตอนลงมือ

| ประเด็น | ตัวเลือก | เอนไปทาง |
|---|---|---|
| Dedup ข่าว | ต่อ collection / global | **ต่อ collection** — ข่าวเดียวอาจ relevant กับ 2 หัวข้อ |
| เก็บ keywords | JSON column / ตารางแยก | **JSON column** v1 |
| ล้างข่าวเก่า | ปล่อยสะสม / cron purge | เพิ่ม cron `DELETE WHERE collected_at < now-Nด` (N ตั้งได้) |
| Admin UI | vanilla / React | **vanilla** v1 |
| `/api/admin/*` รับ token ด้วยไหม | yes / no | **yes** — เผื่อ CI/script |
| Test endpoint กันสแปม | rate limit ไหม | ใส่ throttle เบา ๆ ต่อ user |
| Migration UNIQUE(url) | recreate table / index ใหม่ | ตัดสินตอนเขียน migration |

---

## 12. ประเมินงานคร่าว ๆ

| Phase | ขนาด |
|---|---|
| 1 — schema thread-through | กลาง |
| 2 — Access + admin API | เล็ก (Access เป็น config, JWT check สั้น) |
| 3 — Admin UI | กลาง–ใหญ่ |
| 4 — cleanup | เล็ก |

---

## 13. งานค้างจากบทสนทนาก่อนหน้า (fold เข้า Phase 1)

- `url_allow` / `url_deny` regex ต่อ source ✔ อยู่ใน schema แล้ว
- `query_extra` ต่อ source ✔
- `require_date` ✔
- เปลี่ยน `onwr` เป็น `type: page` ชี้ `?page_id=1070` + `include=?p=` — ทำตอน seed หรือแก้ผ่าน UI หลัง Phase 3
- `type: page` (โหลด URL ตรง ๆ เก็บลิงก์) — **ชิปไปแล้ว** commit `59c3a02`
- `maxAgeDays` + `time_range` → **ชิปไปแล้ว** commit `88aa80b` (ตอนนั้นยังพึ่ง SearXNG)
- **`type: site` เปลี่ยนไปใช้ Tavily แทน SearXNG** (ยิง 1 query/keyword ครอบทุกโดเมน แทนที่จะยิงแยกทีละ source — Tavily คิดเครดิต flat ต่อ request) — ต้องพกแนวคิดนี้ไปตอนย้าย source model เข้า D1 ใน Phase 1: field `include_domains` ของ query รวมยังต้อง derive จาก domain ของทุก source ในกลุ่มเดียวกันที่ query ครั้งเดียวกัน ไม่ใช่ query ต่อ source เหมือน schema ฉบับร่างใน §3 (แก้ implementation ตอนลงมือ ไม่ต้องแก้ schema) — SearxngContainer/ConfigStore ยังอยู่ ใช้กับ `/api/search`/`/api/chat` (manual search proxy) เท่านั้น ไม่เกี่ยวกับ news pipeline อีกต่อไป
