<div align="center">

```text
  ____        _     _           _____           _     
 |  _ \      | |   | |         |_   _|         | |    
 | |_) | ___ | |__ | |__  _   _  | | ___   ___ | |___ 
 |  _ < / _ \| '_ \| '_ \| | | | | |/ _ \ / _ \| / __|
 | |_) | (_) | |_) | |_) | |_| | | | (_) | (_) | \__ \
 |____/ \___/|_.__/|_.__/ \__, | \_/\___/ \___/|_|___/
                           __/ |                      
                          |___/                       
```

**Babu Terminal & Injector API Key buat kuli kode yang males ngurusin `.env`.**

[![npm version](https://img.shields.io/npm/v/bobbytools.svg)](https://www.npmjs.com/package/bobbytools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

</div>

---

> "Jujur aja, gue bikin *tools* ini gara-gara gue capek hidup ribet."

Kalo lo sering ternak akun AI gratisan (Groq, OpenRouter, dll) atau sering gonta-ganti API dari klien, lo pasti tau betapa nyebelinnya ngerubah file `.env` manual tiap kali dapet error `429 Too Many Requests`. Ganti kunci, ganti URL, *restart* CLI. *Repeat*. Buang-buang umur bro.

**BobbyTools** itu solusinya. Ini bukan *proxy* AI yang *over-engineered* dan bikin laptop lo panas. Ini murni "Babu Terminal" yang tugasnya nyuntikin kredensial secara gaib ke CLI favorit lo (`opencode`, `aider`, `claude`, `agy`, `codex`, dll). Lo setup akun sekali, sisanya Bobby yang kerja.

## ✨ Kenapa Lo Butuh Ini? (The Good Stuff)

*   **Manajemen Akun Tuyul**: Numpuk 50 akun *burner* di sini? Silakan. Kalo satu kena limit, tinggal ganti ke akun berikutnya lewat menu. Nggak perlu buka editor.
*   **Injector Universal**: Provider lo butuh `OPENAI_API_KEY` atau `ANTHROPIC_API_KEY`? Bebas. Tinggal *define* pas bikin provider, BobbyTools bakal langsung nyuntikin variabel itu ke RAM pas nge- *spawn* CLI.
*   **Sinkronisasi Model Otomatis**: Kalo lo milih model di BobbyTools, CLI lo langsung ngikut. Buat pengguna `opencode`, BobbyTools bahkan ngedit config `opencode.json` lo di *background* biar lo nggak usah nyentuh file itu seumur hidup.
*   **Default CLI per Provider**: Misal Cloudflare maunya pake `opencode`, tapi Genfity maunya pake `claude`? Bisa. Dipatenkin per provider, biar lo nggak pusing ngetik manual.

## 🚫 Apa yang BobbyTools GAK BISA (Brutal Honesty)

Biar ekspektasi lo bener:
1.  **Bukan Translator API**: Kalo CLI lo cuma ngerti bahasa Anthropic, terus lo paksa nembak API OpenAI-compatible, ya bakal *error*. BobbyTools cuma ngasih "kunci rumah", bukan nerjemahin bahasanya.
2. **Sekarang ADA Auto-Rotate di Tengah Jalan!**: Yoi, gue kemakan omongan gue sendiri. Kalau lo pake mode `bobby serve` (Local Router mode), pas kena *rate limit* (429), BobbyTools bakal ngumpetin *error*-nya, memutar ke akun tuyul lo berikutnya, dan me- *retry request* secara gaib di *background*. CLI lo (seperti `opencode` / `aider`) sama sekali nggak bakal sadar kalau *API Key*-nya baru aja ditukar!
3. **Zero Encryption**: API Key lo disimpen *plain text* di `~/.bobbytools/config.json`. Jangan tolol nge-share file ini ke publik kalo nggak mau ditagih AWS jutaan rupiah.

---

## 🚀 Tutorial Instalasi

Syarat mutlak: Laptop lo udah terinstall **Node.js (versi 18 ke atas)**. Kalo belum, instal dulu.

Buka terminal, copas *command* ini buat instalasi global:
```bash
npm install -g bobbytools
```

Beres. Sekarang dari folder *project* manapun di laptop lo, ketik aja `bobby`, dan *magic happens*.

Kalo besok-besok ada update baru dan lo pengen *upgrade*:
```bash
npm update -g bobbytools
```

### 🗑️ Cara Hapus (Kalo Lo Udah Gak Suka)
Tinggal jalanin ini buat ngebuang BobbyTools tanpa sisa dari sistem lo:
```bash
npm uninstall -g bobbytools
```
*(Catatan: config API lo tetep aman di folder `~/.bobbytools/`, hapus folder itu manual kalo pengen bener-bener bersih).*

---

## 🎮 Cara Pake (Ga Pake Mikir)

Alurnya cuma 3 tahap: **Setup Provider ➔ Masukin Akun ➔ Gas Ngoding**.

### 1. Buka Menunya
Ketik command sakti ini di terminal manapun:
```bash
bobby
```
*(UI-nya interaktif, navigasi pake panah atas-bawah sama Enter).*

### 2. Setup Provider (Bikin "Rumah" API)
- Pilih **📦 Manage Providers** ➔ **➕ Add Provider**.
- Kalo pake yang umum (OpenAI, Groq, OpenRouter), langsung gas pilih **From Template**.
- Di situ Bobby bakal nanya: *"Default CLI tool buat provider ini apa?"*. Ketik aja CLI kesayangan lo (misal: `opencode`).

### 3. Masukin Akun Tuyul Lo
- Balik ke menu awal, pilih **👤 Manage Accounts**.
- Pilih provider yang tadi, terus klik **➕ Add Account**.
- Kasih nama bebas (misal: "gratisan-1"), terus *paste* API Key lo.
- *Pro tip: Ulangin langkah ini kalo lo punya banyak API Key buat diternakin.*

### 4. Start Session (The Magic)
- Dari menu utama, pilih **🚀 Start Session**.
- Pilih Provider ➔ Pilih Akun ➔ Pilih Model (bisa milih dari *list* atau ngetik bebas).
- *BAM!* BobbyTools nge-set *Environment Variables* di RAM dan langsung ngebuka CLI lo. Tinggal fokus *prompting*.

### 5. Mode Sultan: Local AI Router (NEW! 🔥)
Males ngelewatin menu dan pengen BobbyTools jadi **Universal Gateway** (mirip OpenRouter lokal)?
- Buka terminal dan jalankan:
  ```bash
  bobby serve
  ```
- Biarkan server menyala. Di terminal lain, arahkan CLI AI-mu ke router ini:
  ```bash
  export OPENAI_BASE_URL="http://127.0.0.1:13337/v1"
  export OPENAI_API_KEY="bebas-isi-apa-aja"
  ```
- Sekarang panggil CLI dengan format `[NamaProvider]/[NamaModel]`:
  ```bash
  opencode -m groq/llama3-70b-8192
  aider --model openrouter/anthropic/claude-3-haiku
  ```
- **Otomatis Autocomplete & Auto-Rotate!** Router ini sudah menangani fitur *list models* secara global, dan kalau akunmu *Limit* (429), dia bakal muter otomatis secara gaib!

---

## 🧙‍♂️ Pro-Tips Kaum Pemalas:

*   **Jalur Cepat (`bobby go`)** : Males ngelewatin menu karena API yang dipake itu-itu aja? Ketik `bobby go`. Dia bakal langsung nge-*launch* sesi terakhir yang lo pake. Ngirit umur 5 detik.
*   **Batch Delete (Pemusnah Massal)** : Punya 50 akun dan semuanya limit? Masuk ke menu *Delete Account*, pencet tombol `A` (*select all*) atau Spasi buat nyentang, terus Enter. Langsung rata sama tanah.
*   **Ganti Engine Opencode** : Kalo lo nembak API asli Anthropic via `opencode`, masuk ke Edit Provider, terus ganti opsi **Opencode Plugin** jadi `@ai-sdk/anthropic`. Opencode bakal langsung ganti bahasa ngomongnya.

## 🤝 Kontribusi

Kalo lo nemu *bug* atau punya ide, silakan buka PR. Tapi inget *rule*-nya: **Keep it simple**. Kalo lo masukin *abstraksi* panjang buat fitur yang sebenernya bisa diselesaiin pake logika sebaris, PR lo bakal gue tolak mentah-mentah. *Write less, do more.*

---
<div align="center">
<i>Built with coffee, spite for manual configuration, and sheer laziness.</i>
</div>
