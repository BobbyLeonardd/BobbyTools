<div align="center">

  <img src="assets/logo.jpg" alt="BobbyTools Logo" width="500" />
  <br/>
  
  **Babu Terminal & Universal AI Router buat kuli kode yang males ngurusin `.env` berulang kali.**

[![npm version](https://img.shields.io/npm/v/bobbytools.svg)](https://www.npmjs.com/package/bobbytools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

</div>

---

> "Jujur aja, gue bikin *tools* ini gara-gara gue capek hidup ribet."

Kalo lo sering ternak akun AI gratisan (Groq, OpenRouter, Gemini, dsb) atau sering gonta-ganti API dari klien, lo pasti tau betapa nyebelinnya ngerubah file `.env` manual tiap kali dapet error `429 Too Many Requests`. Ganti kunci, ganti URL, *restart* CLI. *Repeat*. Buang-buang umur bro.

**BobbyTools** itu solusinya. Ini bukan *proxy* AI yang *over-engineered* dan bikin laptop lo panas. Ini murni alat bantu yang tugasnya nyuntikin kredensial secara gaib ke CLI favorit lo (`opencode`, `aider`, `claude-code`, dll) atau jadi **Local Gateway** pintar yang nge-handle limit limitan. Lo setup akun sekali, sisanya Bobby yang kerja.

---

## 🚀 Instalasi & Uninstalasi

Syarat mutlak: Laptop lo udah terinstall **Node.js (versi 18 ke atas)**. Kalo belum, instal dulu.

**Cara Install:**
Buka terminal, copas *command* ini buat instalasi global (biar bisa dipanggil dari mana aja):
```bash
npm install -g bobbytools
```
Beres. Sekarang dari folder *project* manapun di laptop lo, ketik aja `bobby`, dan *magic happens*.

**Cara Update:**
Kalo besok-besok ada update fitur baru, tinggal hajar ini:
```bash
npm update -g bobbytools
```

**Cara Hapus (Uninstalasi):**
Kalo lo ngerasa udah gak butuh atau mau bersih-bersih, tinggal jalanin:
```bash
npm uninstall -g bobbytools
```
*(Catatan: config & API Key lo tetep aman nyelip di folder `~/.bobbytools/`. Hapus folder itu manual kalo lo pengen bener-bener bersih tanpa sisa).*

---

## 🎮 Cara Pake: Classic Launcher Mode (Buat Pemula)

Alurnya cuma 3 tahap: **Setup Provider ➔ Masukin Akun ➔ Gas Ngoding**.
Gak pake mikir panjang.

### 1. Buka Menunya
Ketik command sakti ini di terminal manapun:
```bash
bobby
```
*(UI-nya interaktif, navigasi pake panah atas-bawah sama Enter. Kalo bingung, sekarang udah ada menu **📖 Cara Pakai (Tutorial)** langsung di dalemnya!)*

### 2. Setup Provider (Bikin "Rumah" API)
- Pilih **📦 Manage Providers** ➔ **➕ Add Provider**.
- Kalo pake yang umum (OpenAI, Groq, OpenRouter), langsung gas pilih **From Template**. Kalo provider antah berantah, pilih **Custom**.
- Bobby bakal nanya: *"Default CLI tool buat provider ini apa?"*. Ketik aja CLI kesayangan lo (misal: `opencode`).

### 3. Ternak Akun Tuyul Lo
- Balik ke menu awal, pilih **📦 Manage Providers** lalu pilih provider yang tadi lo bikin.
- Pilih **Manage Accounts** ➔ **➕ Add Account**.
- Kasih nama bebas (misal: "gratisan-1"), terus *paste* API Key lo.
- *Pro tip: Ulangin langkah ini kalo lo punya banyak API Key buat diternakin biar Bobby bisa muterin ntar.*

### 4. Start Session
- Dari menu utama, pilih **🚀 Start Session**.
- Pilih Provider ➔ Pilih Akun ➔ Pilih Model (bisa milih dari *list* atau ngetik bebas).
- *BAM!* BobbyTools nge-set *Environment Variables* di RAM dan langsung ngebuka CLI lo. Tinggal fokus *prompting*.

---

## 🔥 MODE SULTAN: 9Router Mode + Web Dashboard

Ini fitur *killer*-nya. Males ngelewatin menu dan pengen BobbyTools jadi **Universal Gateway**? Lo pengen **auto-rotate API Key** secara gaib di *background* pas kena *rate limit* (429) tanpa bikin CLI lo error? Pakai mode ini.

### Langkah 1: Nyalain Servernya (Background Daemon)
Buka menu `bobby`, lalu pilih **"🌐 Start Web Dashboard (Background)"**. 
BobbyTools otomatis nge-*spawn* proses di balik layar. Lu bebas **tutup terminal lu** (gak perlu di-stay). 

Buka browser lu ke **http://127.0.0.1:13337**. 
Boom! Lu bakal dapet UI *Web Dashboard* gaya *glassmorphism* premium (animasi, *dark mode*, *auto-sync* dengan CLI). Lu bisa nge-CRUD akun, liat status API, dan mantau **Router Activity Logs** secara *real-time* langsung dari browser. Kalau mau matiin routernya, tinggal klik "Shutdown" di webnya, atau pilih menu "Stop Web Dashboard" dari CLI. Semua *state* dijamin tersinkronisasi 100%!

*(Catatan: Kalo lu tipe orang lama yang suka liatin log jalan di terminal, lu bisa pake command `bobby serve` buat jalanin di foreground).*

### Langkah 2: Setting Env Vars CLI Lo
Buka terminal lain (tempat lo mau ngoding). Lo tinggal ngarahin CLI lo biar nembak ke router Bobby, bukan nembak ke API aslinya. Sesuaikan sama CLI yang lo pake.

> ⚠️ **PENTING: Beda OS Beda Cara Nge-Set Env Vars!**
> - **Mac/Linux/GitBash:** Pakai `export VAR="nilai"`
> - **Windows PowerShell:** Pakai `$env:VAR="nilai"` (Contoh: `$env:OPENAI_BASE_URL="http://127.0.0.1:13337/v1"`)
> - **Windows CMD:** Pakai `set VAR="nilai"`
>
> *(Contoh-contoh di bawah ini pake gaya `export` ala Linux, silakan sesuain sendiri kalo lo pake Windows).*

**Untuk CLI berbasis OpenAI (kayak `opencode`, `aider`, `cursor`):**
```bash
export OPENAI_BASE_URL="http://127.0.0.1:13337/v1"
export OPENAI_API_KEY="sk-bobby" # Bebas isi apa aja, gak ngaruh
```

**Untuk CLI berbasis Anthropic (kayak `claude-code`):**
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:13337/v1"
export ANTHROPIC_API_KEY="sk-bobby" 
```

**Untuk yang lainnya (Gemini, Groq, Cohere, dll):**
```bash
export GEMINI_BASE_URL="http://127.0.0.1:13337/v1"
export GROQ_BASE_URL="http://127.0.0.1:13337/v1"
```

### Langkah 3: Panggil Model Bebas Hambatan
Sekarang lo panggil CLI favorit lo, tapi nama modelnya lo kasih awalan nama providernya (format: `provider/model`). Router BobbyTools udah ngegabungin semua model lo secara global!

Contoh nembak Groq pakai `opencode`:
```bash
opencode -m groq/llama3-70b-8192
```

Contoh nembak Gemini pakai `claude-code`:
```bash
claude -m google/gemini-1.5-pro
```

**✨ Magic Yang Terjadi di Belakang Layar:**
1. Router nerima *request*, memotong kata depan (misal `groq/`), lalu nyari data akun Groq di konfigurasi BobbyTools lo.
2. Router nembak ke API Groq asli pakai *API Key* lu.
3. Kalo ternyata akun pertama limit (error 429), router **otomatis ngegeser ke akun Groq kedua lo** dan *retry request*-nya saat itu juga. CLI lu dapet balesan sukses seolah gak pernah ada error. Lo tinggal rebahan.

---

## 🧙‍♂️ Pro-Tips Kaum Pemalas

*   **Jalur Cepat (`bobby go`)** : Kalo lo tipe setia dan pakenya API itu-itu aja, gausah buka menu interaktif. Ketik `bobby go` di terminal. Dia bakal langsung nge-*launch* sesi terakhir yang lo pake. Ngirit umur 5 detik.
*   **Pemusnah Massal (Batch Delete)** : Punya 50 akun dan semuanya limit? Masuk ke menu *Manage Accounts* -> *Delete Account*, pencet tombol `A` (*select all*) atau Spasi buat nyentang, terus Enter. Langsung bersih rata sama tanah (atau mending pake Web Dashboard aja sekarang).
*   **Jurus "Inception" (Auto-Rotate via Menu Klasik)** : Males ngetik model manual pas pake Router? Gampang! Nyalain `bobby serve`, lalu buka terminal baru dan bikin **Provider Custom** di menu `bobby` (Base URL: `http://127.0.0.1:13337/v1`, API Key: `sk-bobby`, Fetch Models: `YES`). Lo bakal dapet *dropdown* semua model PLUS fitur *Auto-Rotate*. Tenang aja, sistem udah di-*patch* anti *Infinite Loop*!

## 🚫 Apa yang BobbyTools GAK BISA (Brutal Honesty)

Biar ekspektasi lo bener:
1.  **Bukan Translator API**: Kalo CLI lo cuma murni ngerti *response* format Anthropic, tapi lo nembak model OpenAI lewat router, ya bakal *error parsing*. BobbyTools cuma bertugas sebagai "kurir dan penjaga pintu", dia gak nerjemahin isi pesannya.
2.  **Zero Encryption**: API Key lo disimpen *plain text* di `~/.bobbytools/config.json`. Jangan tolol nge-share file ini ke publik/github kalo nggak mau ditagih AWS jutaan rupiah.

---

## 🤝 Kontribusi

Kalo lo nemu *bug* atau punya ide gila lainnya, silakan buka PR. Tapi inget *rule* mutlak gue: **Keep it simple**. Kalo lo masukin *abstraksi* panjang atau nambah *library* raksasa buat fitur yang sebenernya bisa diselesaiin pake logika sebaris native Node.js, PR lo bakal gue tolak mentah-mentah. *Write less, do more.*

---

## 📦 Changelog Singkat
- **v3.0.0**: *GOD-TIER UPDATE*: BobbyTools resmi nginjek leher proxy lain! Penambahan fitur **Smart Load Balancing (Round-Robin)** buat mecah traffic otomatis ke semua API key aktif. Penambahan fitur **Universal Fallback Provider** (kalau semua akun Groq habis/limit, otomatis pindah ke OpenRouter/provider lain yang punya model yang sama tanpa ngasih error ke CLI). Fitur *auto-update* purba diganti pure NPM. Usage tracking sekarang nambah otomatis di config tiap kali request sukses.
- **v2.2.1**: *Bugfix & QoL*: Ngebenerin *bug ngeselin* di mana model yang diketik manual (buat *provider* yang gak punya `/models`) hilang dari daftar pas kita balik lagi dari CLI ke menu `Start Session`. Sekarang model manual langsung nyangkut permanen di memori & *cache*!
- **v2.2.0**: *Update Major*: Penambahan **Web Dashboard (UI Glassmorphism Premium)** buat ngatur config secara visual. Udah *support* **Daemon Mode** (*run in background*), **Real-Time Sync** dua arah antara CLI dan Web (kalo lo ngedit di CLI, webnya otomatis *update*), dan fitur **Router Activity Logs** buat mantau *traffic* API. Semua menu interaktif di CLI juga udah di-*upgrade* limit *scroll*-nya (`pageSize: 15`) jadi tombol "Back" nggak gampang ilang, dan *cursor* tetep bisa loncat (loop) dari atas ke bawah.
- **v2.1.4**: *Update Major*: Router sekarang dilengkapi dengan **Smart Auth Header Injection**. Otomatis ngenalin dan ngeganti *header* otentikasi berdasarkan tipe CLI SDK-nya. Mau lu nembak pake format OpenAI (`Authorization: Bearer`), Anthropic (`x-api-key`), Google (`x-goog-api-key`), atau Azure (`api-key`), semuanya dijamin mulus tanpa *error* karena *header mismatch*. Nggak ada lagi drama token gak kebaca.
- **v2.1.3**: *Upgrade* fitur `Toggle Status` jadi pake sistem *checkbox* biar bisa *mass-toggle* banyak akun sekaligus. *Fix bug UI* teks `(active)` yang bocor di terminal.
- **v2.1.2**: *Bugfix* brutal. Benerin isu `Z_DATA_ERROR` (crash gara-gara gzip content-encoding) dan isu `401 Unauthorized` pas *auto-rotate* (karena Node.js ngubah header `authorization` jadi huruf kecil). Fix juga *output* log `\x1b` yang bocor jadi teks literal di terminal.

---
<div align="center">
<i>Built with coffee, spite for manual configuration, and sheer laziness.</i>
</div>
