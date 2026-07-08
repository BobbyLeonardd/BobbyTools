<div align="center">
  
# 🤖 BobbyTools

**The Ultimate AI Provider & CLI Launcher for Lazy Developers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

</div>

---

Jujur aja, gue bikin *tools* ini gara-gara gue males banget. 

Nge-manage puluhan akun AI gratisan (OpenAI, Anthropic, Groq, local LLM, dll) itu beneran *pain in the ass*. Tiap kali mau ganti akun, harus ngedit `.env` manual. Tiap provider punya *requirement* credential yang aneh-aneh (ada yang butuh Account ID, Org ID, apalah). Terus pas mau jalanin CLI AI kayak `opencode` atau `aider`, harus nge-set *environment variables* (ENV) manual satu-satu. Capek, boros waktu, dan rentan salah copas.

Berawal dari kemalasan yang hakiki itu, **BobbyTools** lahir. 

Lo cukup setup provider dan masukin akun lo **sekali aja**. Sisanya? BobbyTools yang bakal ngurusin *injection* ENV-nya ke terminal secara otomatis. Ngasih lo menu interaktif buat gonta-ganti akun dengan gampang, terus langsung ngebuka CLI favorit lo dari satu tempat. Selesai.

## 🔥 Fitur Utama (Kenapa Lo Butuh Ini)

- 🏭 **Multi-Provider & Multi-Account Ready**: Setup sekali, pake berkali-kali. Cocok buat ternak akun atau manage *billing* klien.
- 🪛 **Dynamic Credentials**: Nggak cuma nangkep API Key standar. Provider lo aneh minta `Account ID` atau param lain? Lo bisa tambahin *field custom* sendiri pas setup.
- 💉 **Smart CLI Injector**: Nyimpen kredensial dan langsung nge-*inject* semua *env vars* (misal `OPENAI_BASE_URL` dan `OPENAI_API_KEY`) ke dalem *child process* CLI pilihan lo.
- 🧠 **Native SDK Support**: Mau nembak API standar OpenAI? Bisa. Mau nembak API asli Anthropic/Gemini lewat Opencode? Tinggal ganti *plugin* SDK-nya di menu edit.
- 🎯 **UX Dibuat Pake Logika Manusia**: Menu kepanjangan otomatis ada kolom search-nya. Mau hapus banyak akun yang kena limit? Tinggal *batch delete* pake spasi kayak milih file.

---

## 🛠️ Instalasi (The Quick Way)

Syarat wajib: Laptop lo udah harus ke-install **Node.js** (versi 18 ke atas biar aman). Kalo belom punya, install dulu gih.

Buka terminal, trus ketik ginian (jangan di-skip):

```bash
# 1. Clone repo ini ke lokal lo
git clone https://github.com/BobbyLeonardd/BobbyTools.git

# 2. Masuk ke foldernya
cd BobbyTools

# 3. Install semua dependencies-nya
npm install

# 4. Jadiin command "bobby" jalan secara global di laptop lo
npm link
```

Beres! Lo bisa nutup terminalnya. Sekarang lo buka terminal baru di folder *project* kodingan manapun, ketik `bobby`. Kalo muncul menunya, berarti instalasi lo sukses.

---

## 🎮 Cara Pake (Gak Pake Mikir)

Alurnya cuma tiga tahap: **Setup Provider ➔ Masukin Akun ➔ Start Session**.

### 1. Buka Menu Utama
Ketik *command* sakti ini:
```bash
bobby
```

### 2. Setup Provider
- Pilih **📦 Manage Providers** ➔ **➕ Add Provider**.
- Kalo mau gampang, pilih **From Template**. Udah ada puluhan template bawaan (OpenAI, Groq, OpenRouter, DeepSeek, dll).
- Kalo provider lo aneh atau baru rilis, lo bisa bikin sendiri lewat **Custom Provider**. Lo bisa *define* *Base URL* sama *env var*-nya di situ.

### 3. Masukin Akun (Tuyul Lo)
- Pilih **👤 Manage Accounts**.
- Pilih provider yang barusan lo bikin, terus klik **➕ Add Account**. 
- Kasih nama akunnya (misal: "gratisan-1"), terus *paste* API Key-nya. 

### 4. Gas Ngoding! (Start Session)
Balik ke Menu Utama.
- Pilih **🚀 Start Session**.
- Pilih Provider ➔ Pilih Akun ➔ Pilih Model.
- Pilih CLI yang mau di-*launch* (bisa `opencode`, `aider`, atau `agy`).
- *BAM!* BobbyTools bakal otomatis nge-set ENV di *background* dan langsung ngebuka CLI lo. Tinggal koding aja bro.

---

## 💡 Tips Buat Orang Males (Pro Tips)

### 🚀 Quick Launch (`bobby go`)
Kalo lo ngerasa capek ngelewatin menu buat milih provider/akun yang sama terus, *bypass* aja semuanya:
```bash
bobby go
```
Ini bakal ngebaca history terakhir dan langsung nge-*launch* sesi lo yang kemaren. Menghemat umur lo 5 detik per hari.

### 🔄 Auto Update (`bobby update`)
Gue kadang iseng nge-push update fitur baru atau nge-fix bug ke GitHub. Lo ga usah repot-repot buka browser atau nge-*clone* ulang. Cukup ketik:
```bash
bobby update
```
Dia bakal nyamperin folder instalasinya, jalanin `git pull`, nge-install *dependencies* baru kalo ada, dan langsung *ready* dipake. 

### 🔌 Opencode & Native CLIs
Standarnya, BobbyTools ngebaca API pakai standar OpenAI (`@ai-sdk/openai-compatible`). Kalo lo pake `opencode` dan mau nembak API asli Anthropic atau Gemini (tanpa openrouter dkk):
- Masuk ke **Manage Providers** ➔ **Edit Provider**.
- Edit bagian **Opencode Plugin**.
- Ganti isinya jadi *plugin* Vercel AI SDK bawaan (contoh: `@ai-sdk/anthropic` atau `@ai-sdk/google`).

*(Fun Fact: Ada template sakti namanya **Native Antigravity CLI (agy)**. Ini khusus buat lo yang udah langganan Google AI Pro dan pengen nge-launch `agy` secara utuh (bypass akun & model) dari dalem BobbyTools. Bikin akun kosongan aja, langsung gas!)*

### 🧹 Batch Delete (Pemusnah Akun Limit)
Punya 50 akun dan kena limit semua? Jangan apus manual atu-atu, kriting jari lo ntar. 
Masuk ke menu **Delete Account**, pencet **Spasi** buat nyentang akun mana aja yang mau dieksekusi, pencet tombol `a` buat *select all*, terus **Enter**. Kelar urusan.

---

## 🔒 Privasi & Keamanan

Data API Key lo **100% aman** dan kaga pernah dikirim ke server *third-party* (kecuali langsung ke API AI-nya). BobbyTools nyimpen config lo murni di lokal laptop, tempatnya di:
`~/.bobbytools/config.json` 

*(Warning: Kalo lo lagi iseng nge-backup dotfiles ke github publik, pastiin folder ini di-ignore ya, jangan sampe ke-push!)*

## 🤝 Kontribusi

Kalo lo nemu bug, punya ide sinting, atau gatel pengen refactor kodenya, sikat aja! Lempar issue atau buka *Pull Request*. Santai aja bro, ini proyek dari kuli kode buat kuli kode.

---
<div align="center">
Dibuat dengan 💧 keringat, ☕ kopi, dan males ngetik <code>.env</code> oleh <b>Bobby Leonardo</b> & Contributors.
</div>
