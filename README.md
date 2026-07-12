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

**Babu Terminal & Universal Local AI Gateway buat kuli kode yang males ngurusin `.env` berulang kali.**

[![npm version](https://img.shields.io/npm/v/bobbytools.svg)](https://www.npmjs.com/package/bobbytools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

</div>

---

> "Jujur aja, gue bikin *tools* ini gara-gara gue capek hidup ribet."

Lo punya puluhan akun gratisan Groq, Gemini, OpenRouter, dsb? Terus tiap kali kena *limit* (Error 429) lo harus buka file `.env`, *copy-paste* API Key baru, dan *restart* CLI? Buang-buang umur, bro.

**BobbyTools** itu solusinya. Ini bukan sekadar *CLI Launcher* biasa lagi, tapi udah berevolusi jadi **Local AI Router** (bayangin kayak punya *OpenRouter* skala lokal di laptop lo sendiri) yang bisa merotasi akun tuyul lo secara magis dan gaib tanpa lo harus nyentuh sebaris teks pun.

## ✨ Kenapa Lo Butuh Ini? (The Good Stuff)

*   **Universal Local Gateway (Mode Sultan)**: Gak peduli lo pake `opencode`, `aider`, `claude-code`, Cursor, dsb. Tembak aja *localhost* BobbyTools, dia yang bakal nentuin *provider* mana, *model* mana, dan akun mana yang masih bernapas.
*   **Auto-Rotate Gaib (Anti-Limit 429)**: Kalau lagi asik nunggu respons AI terus akun lo kena blokir karena limit, BobbyTools bakal ngumpetin error-nya, muter diem-diem ke akun berikutnya di *background*, dan ngelanjutin proses. CLI lo dijamin nggak bakal sadar atau error.
*   **Manajemen Akun Tuyul**: Numpuk 100 akun *burner* dari 20 provider? Silakan. Daftarin ke menunya sekali seumur hidup, sisanya biar Bobby yang kerja.
*   **Zero Config & Anti-Bloat**: Benci *dependency* bengkak? Sama. Script ini dibikin pake logika sebaris yang males mikir tapi efisien. *Native* Node.js, nggak ada *library* bloatware. Simple, kenceng, dan *to the point*.

## 🚫 Apa yang BobbyTools GAK BISA (Brutal Honesty)

1.  **Bukan Translator API**: Kalo CLI lo cuma paham format Anthropic, tapi lo tembak ke provider yang formatnya OpenAI, ya bakal ancur. BobbyTools ini cuma jembatan pengantar pesan (pipa *blind proxy*), bukan mesin penerjemah silang format.
2.  **Zero Encryption**: API Key lo disimpen *plain text* di `~/.bobbytools/config.json`. Jangan tolol nge-share file ini ke publik kalo lo gak mau tiba-tiba dapet tagihan miliaran dari AWS.

---

## 🚀 Tutorial Instalasi (Buat Anak Bayi Juga Bisa)

Syarat mutlak: Laptop lo udah terpasang **Node.js (versi 18 ke atas)**.

Buka terminal, *copas command* ini buat instalasi secara global:
```bash
npm install -g bobbytools
```
Beres. Tinggal ketik `bobby` di terminal mana aja. 

*Pengen nge-update karena gue habis ngerilis fitur baru?*
```bash
npm update -g bobbytools
```

### 🗑️ Cara Uninstall (Kalo Lo Nyerah & Pengen Ribet Lagi)
Tinggal jalanin *command* ini buat nendang BobbyTools dari sistem lo:
```bash
npm uninstall -g bobbytools
```
*(Catatan: Konfigurasi API rahasia lo tetep aman nyempil di `~/.bobbytools/`. Kalo mau musnahin total, hapus folder itu pake tangan lo sendiri).*

---

## 🎮 Cara Pake (Gak Pake Mikir)

### 1. Masukin Daftar Akun Lo (Sekali Seumur Hidup)
Ketik command sakti ini di terminal manapun buat manggil sang Babu:
```bash
bobby
```
1. Di menu, pilih **📦 Manage Providers** ➔ **➕ Add Provider**. (Bisa dari *template* yang udah gue siapin atau bikin *custom* terserah lo).
2. Balik ke menu awal, pilih **👤 Manage Accounts** ➔ Pilih Provider-nya ➔ **➕ Add Account**.
3. *Paste* API Key lo. Ulangin langkah ini kalo lo punya selusin tuyul. 

Kelar. Mulai dari titik ini lo nggak perlu lagi ngurusin urusan kredensial *dummy* lo.

### 2. Mode Sultan: Local AI Router (The Magic 🔥)
Males milih menu tiap mau *coding*? Pengen bebas pake CLI apa aja dan biarin Bobby yang ngatur pergantian kuncinya di *background*?
1. Di terminal pertama, jalankan perintah ini dan biarin menyala:
   ```bash
   bobby serve
   ```
2. Di terminal kedua (tempat lo *coding*), arahkan CLI kesayangan lo buat "nembak" si Bobby. Lo cuma butuh ngubah 2 *Environment Variables* ini:
   ```bash
   # Kalo CLI lo (kayak opencode / aider) butuh standar OpenAI:
   export OPENAI_BASE_URL="http://127.0.0.1:13337/v1"
   export OPENAI_API_KEY="sk-bobby" # Bebas isi teks bodong apa aja
   
   # Kalo CLI lo (kayak claude-code) butuh standar Anthropic:
   export ANTHROPIC_BASE_URL="http://127.0.0.1:13337/v1"
   export ANTHROPIC_API_KEY="sk-bobby"
   ```
3. Langsung jalankan *command* CLI-nya, tapi ingat: **Format nama modelnya wajib digabungin sama nama provider** (`provider/model`). Contohnya:
   ```bash
   opencode -m groq/llama3-70b-8192
   aider --model openrouter/anthropic/claude-3-5-sonnet
   ```
**BAM!** BobbyTools bakal ngirim request lo langsung ke target aslinya, dan kalo si Groq/OpenRouter ngasih error *limit*, BobbyTools bakal ngelakuin rotasi magis tanpa nyuruh lo pencet apa-apa.

*(Pst... kalo lo bosen sama mode router, balik ke terminal pertama, ketik huruf `b` atau `q` trus tekan Enter buat mematikan router dan balik ke menu utama)*

### 3. Mode Klasik: Launcher Bawaan (Buat yang Males Ngetik Env)
Kalo lo gak suka gaya router dan maunya dibukain semuanya di satu pintu:
- Dari menu utama `bobby`, pilih **🚀 Start Session**.
- Pilih Provider ➔ Pilih Akun ➔ Pilih Model.
- BobbyTools bakal otomatis nyuntikin variabel ke memori dan langsung ngebuka CLI lo (gak perlu `export` manual).

---

## 🧙‍♂️ Pro-Tips Kaum Pemalas:

*   **Jalur Cepat (`bobby go`)** : Males masuk menu karena kerjaan lo cuma nerusin *project* yang kemaren? Ketik `bobby go` di terminal. Dia bakal otomatis ngegas *session* terakhir lo. Ngirit umur 5 detik.
*   **Pemusnah Massal (Batch Delete)** : Puluhan akun tuyul lo udah hangus *limit*-nya semua? Masuk ke menu *Delete Account*, pencet tombol `A` buat nyentang semuanya sekaligus, lalu Enter. Rata sama tanah.
*   **Autocomplete Model Global** : BobbyTools Router udah mendukung fitur `GET /v1/models` secara global. Jadi CLI kekinian lo bakal tetep bisa nge- *list* dan *autocomplete* nama-nama modelnya seakan-akan dia lagi ngomong sama OpenAI asli.

---

## 🤝 Kontribusi (Baca Dulu Kalo Mau Komen)

Kalo lo nemu *bug* atau punya ide ajaib, silakan buka *Pull Request*. 
Tapi denger baik-baik *rule* gue: **Keep it simple**. Kalo lo nyoba masukin *abstraksi* panjang, atau nulis *design pattern* raksasa buat nyelesaiin masalah yang harusnya bisa pake logika sebaris, PR lo bakal gue tolak mentah-mentah. 

*Write less, do more. The best code is the code never written.*

<div align="center">
<br><br>
<i>Built with coffee, spite for manual configuration, and sheer laziness.</i>
</div>
