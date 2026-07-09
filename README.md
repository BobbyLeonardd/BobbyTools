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

## 🚀 Instalasi

Syarat mutlak: Node.js >= 18.0.0.

```bash
# Clone reponya
git clone https://github.com/BobbyLeonardd/BobbyTools.git
cd BobbyTools

# Install dependency & link ke global
npm install
npm link
```
Udah. Ketik `bobby` di terminal mana aja buat ngebuka.

## 🎮 Cara Pake (Gak Pake Mikir)

1. Ketik `bobby` di terminal.
2. Buka **Manage Providers** -> Tambahin provider. Pilih *template* atau bikin *custom*. Di sini lo juga milih mau dipatenkin pake CLI apa (Default CLI).
3. Buka **Manage Accounts** -> Masukin nama akun dan API Key lo.
4. Balik ke depan, pilih **Start Session**. Pilih provider, akun, sama model. Bobby bakal nge-inject semuanya dan nge-launch CLI lo.

---

## 🧙‍♂️ Pro-Tips buat Kaum Pemalas:

*   `bobby go` : Males ngelewatin menu? Command ini langsung ngebuka sesi terakhir yang lo pake.
*   `bobby update` : Otomatis nge-pull dari GitHub dan nge-install dependency baru kalo ada *update*. Gak usah buka browser.
*   **Batch Delete** : Kalo akun tuyul lo mati massal, masuk ke menu Delete Account, pencet `a` (Select All), terus Enter. Langsung bersih.
*   **Ganti Engine Opencode** : Mau nembak Anthropic asli pake `opencode`? Edit provider lo, ganti **Opencode Plugin** dari `@ai-sdk/openai-compatible` jadi `@ai-sdk/anthropic`.

## 🤝 Kontribusi

Kalo lo nemu bug atau punya ide fitur, silakan buka PR. Tapi inget rule-nya: **Keep it simple**. Kalo lo masukin *abstraksi* 500 baris buat fitur yang sebenernya bisa diselesaiin pake logika sebaris, PR lo bakal gue *reject*. *Write less, do more.*

---
<div align="center">
<i>Built with coffee, spite for manual configuration, and sheer laziness.</i>
</div>
