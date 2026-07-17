<div align="center">

  <img src="assets/logo.jpg" alt="BobbyTools Logo" width="500" />
  <br/>

  **Babu Terminal & Universal AI Router.** <br>
  *Karena ngedit `.env` berulang kali itu kerjaan orang kurang kerjaan.*

[![npm version](https://img.shields.io/npm/v/bobbytools.svg)](https://www.npmjs.com/package/bobbytools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

> "Gue nulis kode ini karena capek ngurusin rate limit 429."

Ceritanya gini. Kalo lo pake banyak akun AI gratisan (Groq, Gemini, OpenRouter) atau gonta-ganti API key klien, lo pasti tau rasanya: lagi asik ngoding, kena limit, `stop` terminal, buka `.env`, ganti key, run ulang. Tiap. Lima. Menit. Bikin pengen banting laptop.

Gue bikin **BobbyTools** biar itu gak kejadian lagi. Setup sekali, biarin jalan di background jadi router. Dia yang mikir akun mana yang lagi limit, dia yang muter API key otomatis, dia yang nyari provider cadangan kalo semua mati. Lo tinggal ngoding kayak gak ada yang salah.

Dua cara pake, tinggal pilih sesuai tingkat kemalasan lo hari ini.

---

## 🧩 Bobby bisa apa aja

Singkatnya, satu tempat buat semua urusan API key AI lo:

- **Kumpulin banyak akun jadi satu.** Punya 5 key Groq gratisan + 2 OpenRouter + 1 Gemini? Masukin semua. Bobby yang muter giliran (round-robin), lo cukup panggil `groq/llama3-70b-8192`.
- **Anti-limit 429 otomatis.** Satu key kena limit, Bobby diem-diem pindah ke key berikutnya dan retry. Yang kena limit dikasih cooldown, balik aktif sendiri. CLI lo gak pernah tau ada drama.
- **Fallback lintas provider.** Semua key satu provider abis? Bobby nyari provider lain yang punya model sama, pindah mid-request.
- **Penerjemah format.** claude-code (Anthropic) nembak provider OpenAI-style (Groq/OpenRouter), atau ke Gemini, atau ke Responses — Bobby nerjemahin di tengah jalan. Teks, streaming, tool calls, gambar. Semua arah.
- **Combos.** Bikin rantai model cadangan bernama (`ngebut`, `murah-dulu`, dst). Bobby turun ke model berikut cuma kalo yang sekarang bener-bener abis.
- **Dua mode.** Router (server lokal, anti-limit, translator) **atau** launcher klasik (inject key ke env, spawn CLI langsung, tanpa proxy).
- **Dashboard live.** Pantau key mana yang idup/kebakar, countdown cooldown, request per menit, log aktivitas — auto-refresh, gak usah pencet-pencet.
- **Zero-trust, zero-cloud.** Gak masang cert, gak ada MITM, gak ada telemetry. Key lo cuma nyampe ke provider yang lo daftarin. Router cuma dengerin `127.0.0.1`.

---

## ⚡ Pasang

Butuh Node.js v18 ke atas. Cek dulu: `node -v`. Kalo di bawah 18, update dulu, jangan ngeyel.

```bash
npm install -g bobbytools
```

Udah. Ketik `bobby`, kalo banner-nya muncul berarti beres. Mau mastiin? `bobby -v` buat liat versinya.

**Update.** Gampang, tinggal ketik `bobby update` — dia ngecek versi terbaru di npm, kalo ada yang baru langsung ditawarin update (tinggal Enter). Males masuk menu? `npm install -g bobbytools@latest` juga sama aja.

---

## 🌐 Cara 1: Mode Router (yang bikin alat ini worth it)

BobbyTools jalan sebagai server lokal. CLI ngoding lo (aider, opencode, cursor, claude-code, dsb) nembak ke server ini, bukan langsung ke provider. Di sinilah semua sihir terjadi: anti-limit (muter key otomatis), fallback lintas provider, dan **penerjemah format** biar claude-code bisa nembak provider OpenAI-style (Groq, OpenRouter, dll) — detailnya di bagian [Penerjemah Format](#-penerjemah-format-claude-code-ke-provider-apa-pun) di bawah.

**Nyalain:**

```bash
bobby serve-bg
```

Ini jalanin router di background (daemon) dan langsung bukain browser ke `http://127.0.0.1:13337`. Terminalnya boleh lo tutup, dia tetep idup. Kalo lo mau liat lognya jalan real-time di depan mata, pake `bobby serve` (foreground, tutup terminal = mati).

**Di web dashboard:**

1. Klik **Add Provider**. Pilih dari template (Groq, OpenAI, Gemini, dll udah ada) atau bikin custom.
2. Masuk ke provider itu, tambahin **Akun** sebanyak API key yang lo punya. Punya 5 key Groq gratisan? Masukin semua lima.

**Pantau dari tab Overview.** Begitu router nyala, buka tab **Overview** (langsung kebuka pas masuk dashboard). Di situ keliatan sekilas: berapa key yang masih idup, berapa yang lagi kebakar kena 429, dan — ini yang penting — key yang limit itu **balik dalam berapa detik** (ada hitung mundurnya). Ada juga request per menit biar lo yakin router-nya beneran kerja. Auto-refresh tiap 3 detik, gak usah pencet-pencet.

**Sambungin CLI ngoding lo.** Buka terminal tempat lo biasa kerja, kibulin CLI-nya biar ngira router kita ini server aslinya:

```bash
# Mac/Linux/GitBash
export OPENAI_BASE_URL="http://127.0.0.1:13337/v1"
export OPENAI_API_KEY="sk-bobby"

# Windows PowerShell
$env:OPENAI_BASE_URL="http://127.0.0.1:13337/v1"
$env:OPENAI_API_KEY="sk-bobby"
```

`OPENAI_API_KEY` diisi apa aja bebas — `sk-bobby`, `asdf`, terserah. Yang nyuntikin key asli itu si router, bukan lo.

**Jalanin**, panggil model pake format `provider/model` biar router tau mau nembak ke mana:

```bash
opencode -m groq/llama3-70b-8192
```

**Yang kejadian di belakang layar:** CLI lo ngirim request bawa key bodong. Router nangkep, nyari akun Groq lo yang lagi aktif, nyuntikin key asli, nerusin ke Groq. Kena 429? Router diem-diem pindah ke key kedua, retry, CLI lo gak tau apa-apa — taunya sukses. Kalo semua key Groq abis, dia nyari provider lain yang punya model sama. Lo cuma liat jawaban keluar mulus.

Key yang kena limit gak dicap mati selamanya, ngomong-ngomong. Ada cooldown — abis beberapa saat dia dicoba lagi otomatis, soalnya limit 429 itu biasanya cuma numpang lewat.

Dua hal kecil biar lo gak kebakar kuota sia-sia: kalo provider-nya ngadat gak nyambung-nyambung, router gak bakal gantung selamanya — ada batas waktu nyambung, lewat itu dilepas. Dan kalo lo pencet Ctrl+C di tengah jawaban, router ikut mutus request ke provider-nya — token yang lagi jalan gak diterusin percuma. Stream yang lagi ngalir normal? Aman, gak diganggu, mau semenit dua menit juga bebas.

---

## 💻 Cara 2: Mode Klasik (buat yang lagi males mikir)

Gak mau ribet `export` env var, cuma mau jalanin satu tool cepet? Ketik `bobby`, pake menunya.

1. **Manage Providers** → tambah provider, isi juga *target CLI* lo (misal `opencode`).
2. **Manage Accounts** → masukin API key.
3. Balik ke menu, pilih **Start Session**.
4. Klik-klik: Provider → Akun → Model. Udah.

BobbyTools nutup dirinya sendiri, ngebuka `opencode` (atau apa pun target lo) dengan key udah kesuntik di memori proses. Gak ada acara ngapalin sintaks `export`.

Besok-besok tinggal `bobby go` — langsung lanjut sesi terakhir lo, tanpa klik-klik lagi.

---

## 🔀 Combos (rantai model cadangan)

Kadang lo pengen "pake yang murah/cepet dulu, kalo semua tewas baru naik ke yang mahal". Itu gunanya combo.

Combo = daftar `provider/model` berurutan yang lo kasih **satu nama**. Bobby coba dari paling atas; begitu satu model **bener-bener abis** (semua akunnya kena limit *plus* fallback lintas-provider udah mentok), baru dia turun ke model berikutnya.

- **Bikin:** menu `bobby` → **Manage Combos** → Add Combo → kasih nama (jangan pake `/`) → susun langkahnya (urutan bisa digeser). Dari web dashboard juga bisa, tab **Combos**.
- **Pake:** panggil nama combo-nya di posisi model. Combo bernama `ngebut`? Tinggal:

```bash
opencode -m ngebut
```

Combo itu **satu-satunya** tempat Bobby ganti model di tengah request — dan cuma buat nama yang emang lo daftarin sebagai combo. Request `provider/model` biasa tetep **dikunci** ke model itu: kena 429 ya dikasih tau 429, gak diem-diem loncat ke model lain yang beda harga/kualitas tanpa lo minta.

---

## 🧠 Ngatur Model per Provider

Masuk **Manage Providers → Edit Provider → (pilih) → Edit Models**. Di sini lo bisa CRUD daftar model:

- **Add** — ketik nama model manual.
- **List / Rename / Delete** — rapiin daftarnya.
- **Fetch/Refresh** — tarik otomatis dari endpoint provider (buat yang support `/models`), hasilnya di-merge, bukan nimpa.

Kalo provider lo gak punya endpoint model, ya gampang, tinggal Add manual.

**Soal provider lokal:** kalo lo bikin provider yang base URL-nya nunjuk ke `localhost` / `127.0.0.1` (termasuk router BobbyTools lo sendiri), endpoint model-nya **sengaja gak bisa di-fetch** — isi manual aja. Ini biar router gak muter nyerep daftar model dari dirinya sendiri dan bikin nama model numpuk aneh. Sengaja gitu, bukan bug.

---

## 📚 Daftar Perintah

| Perintah | Fungsi |
|---|---|
| `bobby` | Buka menu utama interaktif. |
| `bobby go` | Langsung buka sesi terakhir. Jalan pintas orang malas. |
| `bobby serve` | Router di foreground. Tutup terminal = mati. Enak buat ngintip log. |
| `bobby serve-bg` | Router di background (daemon) + auto buka browser. Terminal bebas ditutup. |
| `bobby list` | Liat semua provider & akun tanpa masuk menu. |
| `bobby serve --port <n>` | Router di port lain (default `13337`). Bisa `-p` juga. |
| `bobby update` | Cek versi terbaru di npm, langsung tawarin update otomatis kalo ada yang baru. |
| `bobby -v` | Cek versi. |
| `bobby -h` | Contekan bantuan. |

---

## 🗑️ Copot (Uninstall)

Bosen, atau mau install ulang bersih? Dua langkah:

```bash
# 1. Cabut paketnya
npm uninstall -g bobbytools
```

Itu udah ngilangin command `bobby`. Tapi config lo (provider, semua API key) masih nyangkut di `~/.bobbytools/`. Kalo mau bener-bener bersih sampe ke akar:

```bash
# 2. Hapus config + semua key yang tersimpan
#    Mac/Linux/GitBash
rm -rf ~/.bobbytools

#    Windows PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.bobbytools"
```

Langkah 2 itu **permanen** — semua key yang lo simpen ilang. Kalo cuma mau install ulang tapi tetep pengen data lama, skip langkah 2 aja, folder itu kepake lagi otomatis pas lo install balik.

---

## 🔀 Penerjemah Format (claude-code ke provider apa pun)

Ini yang bikin BobbyTools beda dari sekadar proxy: **router nerjemahin format API otomatis.**

Masalahnya gini. Tiap CLI ngomong bahasa API-nya sendiri: claude-code pake **Anthropic Messages** (`/v1/messages`), mayoritas provider murah/gratis — Groq, OpenRouter, DeepSeek, dll — cuma ngerti **OpenAI Chat Completions** (`/v1/chat/completions`), Google pake **Gemini** (`generateContent`), dan OpenAI sekarang punya **Responses API** (`/v1/responses`) juga. Bahasa beda-beda. Tanpa penerjemah, claude-code nembak Groq ya langsung error.

BobbyTools nutup jurang itu. Router deteksi format dari path yang ditembak CLI-mu, bandingin sama format provider tujuan, dan nerjemahin kalo beda. Arsitekturnya **hub-and-spoke**: OpenAI Chat Completions jadi hub (bahasa tengah), tiap format lain cuma perlu tau cara nerjemah ke/dari hub. Jadi semua kombinasi jalan lewat hub tanpa kode pasangan langsung:

- **Anthropic ↔ OpenAI** (claude-code ke Groq/OpenRouter/dll, atau sebaliknya)
- **Gemini ↔ apa pun** (claude-code ke provider Gemini, CLI OpenAI ke Gemini, dst)
- **Responses ↔ apa pun** (CLI Responses ke provider mana pun, atau sebaliknya)

Nambah format ke-N cuma butuh 6 fungsi (satu per arah × 3 tahap), bukan N penerjemah pasangan — linear, bukan kuadratik.

Yang diterjemahin: teks, **streaming** (SSE di-reframe on the fly, jawaban ngalir normal), **tool/function calling** penuh (`tool_use`/`tool_result` ↔ `tool_calls` ↔ `functionCall`/`functionResponse` ↔ `function_call`, skema tool, tool_choice — semua arah), dan **gambar/vision** (blok `image` base64/URL ↔ `image_url` ↔ `inlineData` ↔ `input_image`). Ini yang bikin claude-code beneran kepake, bukan cuma "nyambung tapi tumpul".

**Kapan aktif?** Cuma pas format beda. Kalo CLI dan provider udah sama format (kasus paling umum sekarang), router lewat jalur cepat — diterusin apa adanya, nol overhead, nol risiko. Penerjemah nyala cuma pas dibutuhin.

**Setelannya di mana?** Provider default dianggap format OpenAI (jadi semua provider lama jalan tanpa diubah). Kalo provider-mu ngomong format lain, set lewat **Edit Provider → API Format → openai / anthropic / gemini / responses**. Buat kasus utama (claude-code → provider OpenAI), lo gak usah setel apa-apa — jalan langsung.

*Catatan jujur:* teks, streaming, tool calls, dan gambar semua udah diterjemahin lintas keempat format lewat hub — dan udah diuji langsung ke provider asli (termasuk kirim gambar ke model vision lewat jalur terjemahan). Yang belum ketutup: format-format langka di luar text/tool/image (misal audio input), dan tool ter-hosting khusus Gemini/Responses (web_search dll) yang gak punya padanan di hub.

---

## 🎯 Kenapa BobbyTools (dan bukan yang lain)

Ada router AI lain yang lebih gede, lebih banyak fitur. BobbyTools sengaja jalan arah beda, dan buat pemakaian pribadi itu justru kelebihan:

- **Zero-trust ke mesin lo.** Gak masang root certificate (gak ada MITM), gak ada cloud sync, gak ada telemetry. API key lo gak ke mana-mana selain ke provider yang lo daftarin. Router cuma dengerin `127.0.0.1`.
- **Zero build, zero berat.** Cuma butuh Node 18+ dan `npm install -g`. Gak ada langkah build, gak ada framework raksasa. Dua dependency doang (`@inquirer/prompts` + `chalk`).
- **Bisa lo baca sendiri.** Seluruh proyek muat dibaca dalam sejam. Lo naruh API key di sesuatu yang lo ngerti sepenuhnya, bukan puluhan ribu baris yang gak ada satu orang pun paham.
- **Dua mode dalam satu.** Router (anti-limit, penerjemah) **dan** launcher klasik (inject env, spawn CLI, tanpa proxy). Pilih sesuai kemalasan hari ini.

Bukan berarti alat lain jelek — buat kebutuhan enterprise/tim, mereka mungkin lebih pas. Tapi kalo lo cuma pengen kelola beberapa key, anti kena limit, dan colok claude-code ke provider murah **tanpa masang cert atau naruh data di cloud** — di situ BobbyTools menang.

---

## 🚫 Yang Perlu Lo Tau (Disclaimer)

1. **Config disimpen polos.** Semua ada di `~/.bobbytools/config.json`, gak dienkripsi. Jangan sekali-kali commit file ini ke repo publik. API key bocor gara-gara lo sendiri ceroboh, ya salahin cermin.
2. **Router cuma dengerin localhost — dan beneran dikunci.** Server bind ke `127.0.0.1`, jadi gak keekspos ke jaringan. Tapi bind doang gak cukup: browser lo juga proses lokal, jadi situs jahat yang lo buka bisa nembak `127.0.0.1:13337`. Makanya panel kontrol (dashboard + `/api/*`, yang bisa baca/nimpa config berisi API key) cuma nerima request dari loopback — Origin lintas-situs ditolak (anti-CSRF, gak bisa ngehapus provider lo), Host asing ditolak (anti DNS-rebinding, gak bisa nyuri key lo). Semua ini **tanpa perlu login/password**. Jalur proxy `/v1/*` dikecualiin — itu ditembak CLI lokal yang bawa key sendiri, bukan browser.
3. **Terjemahan format nutup teks, streaming, tool calls, dan gambar** — lintas empat format (OpenAI, Anthropic, Gemini, Responses) lewat hub, udah diuji ke provider asli. Format di luar itu (misal audio input) belum ditangani; kalo CLI-mu ngirimnya, bagian itu di-drop, bukan bikin error.

---
*Dibuat karena males. Dirawat karena kepalang.*
