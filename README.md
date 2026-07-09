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

**CLI Launcher & API Key Manager buat kuli kode yang males ngedit `.env`.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)
[![Maintained with Sarcasm](https://img.shields.io/badge/Maintained%20with-Sarcasm-ff69b4.svg)](#)

</div>

---

> "Jujur aja, gue bikin *tools* ini gara-gara gue males ribet."

Kalo lo sering ternak akun AI gratisan (Groq, Genfity, dll) atau gonta-ganti API dari klien, lo pasti tau betapa nyebelinnya ngerubah file `.env` manual tiap kali dapet error `429 Too Many Requests`. Belum lagi tiap *provider* punya format *env var* yang beda-beda. Ganti kunci, ganti URL, restart CLI. Buang-buang umur.

**BobbyTools** itu solusinya. Ini bukan *proxy* AI yang *over-engineered*. Ini murni "Babu Terminal" yang tugasnya nyuntikin kredensial ke CLI favorit lo (`opencode`, `aider`, `claude`, dll). Lo setup akun sekali, sisanya Bobby yang ngurusin.

## 🛠 Apa yang BobbyTools lakuin (The Good Stuff)

*   **Manajemen Akun Fleksibel**: Numpuk 50 akun *burner* di sini? Silakan. Kalo satu kena limit, tinggal ganti ke akun berikutnya lewat menu.
*   **Injector Universal**: Provider lo butuh `OPENAI_API_KEY` atau `ANTHROPIC_API_KEY`? Bebas. Lo tinggal *define* nama env var-nya pas bikin provider, Bobby yang bakal nge-inject ke RAM pas nge-spawn CLI.
*   **Sinkronisasi Model Otomatis**: Lo milih model di BobbyTools, CLI lo langsung ngikut. Kalo pake `opencode`, BobbyTools bahkan ngedit file config `opencode.json` di *background* biar lo ga usah nyentuh file itu lagi.
*   **Default CLI per Provider**: Beda provider beda CLI? (misal Cloudflare maunya pake `opencode`, Genfity maunya pake `claude`). Bisa. Udah dipatenkin di settingan tiap provider.

## 🚫 Apa yang BobbyTools GAK BISA lakuin (Brutal Honesty)

Biar ekspektasi lo bener, ini fakta teknisnya:

1.  **Bukan Translator API**: Kalo CLI lo cuma ngerti bahasa Anthropic, terus lo paksa nembak API OpenAI-compatible, bakal *error*. BobbyTools cuma ngasih kunci rumah, bukan nerjemahin bahasanya.
2.  **Gak Ada Auto-Rotate di Tengah Jalan**: Kalo lo lagi asik *generate* kode terus kena *rate limit*, BobbyTools nggak bakal otomatis nge-swap API key saat itu juga. Kenapa? Karena bikin *Local Proxy Server* buat nangani *streaming response* (SSE) itu ribet banget dan ngelanggar prinsip "simpel & males" gue. Solusinya? Pencet `Ctrl+C`, bilang ke Bobby akunnya limit, terus ketik `bobby go`. Kelar dalam 3 detik tanpa kode yang bengkak.
3.  **Zero Encryption**: API Key lo disimpen *plain text* di `~/.bobbytools/config.json`. Jangan tolol nge-push folder ini ke GitHub publik kalo ga mau ditagih AWS jutaan rupiah.

---

## 🚀 Tutorial Instalasi (The Quick Way)

Syarat mutlak: Laptop lo udah harus ada **Node.js (versi 18 ke atas)**. Kalo belum, urus dulu gih.

Buka terminal, copas *command* ini:

```bash
npm install -g bobbytools
```

Udah. Silakan tutup terminalnya. Sekarang lo buka *project* apapun, ketik `bobby`, dan keajaiban akan terjadi.

---

## 🎮 Cara Pake (Step-by-Step, Ga Pake Mikir)

Buat lo yang anti baca doku panjang-panjang, alurnya cuma 3 tahap: **Setup Provider ➔ Masukin Akun Tuyul ➔ Gas Ngoding**.

### Langkah 1: Buka Menunya
Ketik command sakti ini di terminal manapun:
```bash
bobby
```
*(UI-nya interaktif, lo tinggal navigasi pake panah atas-bawah sama Enter).*

### Langkah 2: Setup Provider (Bikin "Rumah" buat API Lo)
- Pilih menu **📦 Manage Providers**.
- Pilih **➕ Add Provider**.
- Kalo lo pake yang umum kayak OpenAI, Groq, atau OpenRouter, langsung pilih **From Template**. 
- Di dalem sini, BobbyTools bakal nanya: *"Default CLI tool buat provider ini apa?"*. Nah, pilih CLI kesayangan lo (misal: milih `opencode` buat Cloudflare). Biar besok-besok kaga usah ribet ngetik nama CLI manual lagi.

### Langkah 3: Masukin Akun
- Balik ke depan, pilih menu **👤 Manage Accounts**.
- Cari provider yang barusan lo tambahin, terus klik **➕ Add Account**.
- Kasih nama bebas (misal: "gratisan-tuyul-1"), terus *paste* API Key lo. 
- *Pro tip: Ulangin langkah ini kalo lo punya banyak API Key buat diternakin.*

### Langkah 4: Start Session (Magic Happens Here)
- Balik ke menu utama, pilih **🚀 Start Session**.
- Pilih Provider ➔ Pilih Akun ➔ Pilih Model (bisa milih dari *list* atau ngetik bebas).
- *BAM!* BobbyTools bakal otomatis nge-set Environment Variables, nulis config di *background*, dan langsung nge-launch CLI lo. Lo tinggal fokus nulis (*atau nge-prompt*) kode.

---

## 🧙‍♂️ Pro-Tips buat Kaum Pemalas:

*   `bobby go` : Lo males ngelewatin menu karena pake akun yang itu-itu aja? Command ini langsung ngebuka sesi terakhir (history) yang lo pake. Ngirit umur 5 detik per hari.
*   `bobby update` : Kalo gue iseng nge-push update fitur baru ke GitHub, lo kaga usah buka browser. Ketik ini aja, dia otomatis nge-pull dan install versi terbaru.
*   **Batch Delete (Pemusnah Akun Limit)** : Punya 50 akun dan mati massal? Masuk ke menu *Delete Account*, pencet spasi buat nyentang (atau pencet tombol `a` buat *select all*), terus Enter. Langsung rata sama tanah.
*   **Ganti Engine Opencode** : Kalo lo nembak API asli Anthropic (bukan OpenAI-compatible) via `opencode`, masuk ke Edit Provider, terus ganti opsi **Opencode Plugin** jadi `@ai-sdk/anthropic`. Opencode bakal langsung ganti bahasa.

## 🤝 Kontribusi

Kalo lo nemu bug atau punya ide fitur, silakan buka PR. Tapi inget rule-nya: **Keep it simple**. Kalo lo masukin *abstraksi* 500 baris buat fitur yang sebenernya bisa diselesaiin pake logika sebaris, PR lo bakal gue *reject*. *Write less, do more.*

---
<div align="center">
<i>Built with coffee, spite for manual configuration, and sheer laziness.</i>
</div>
