<div align="center">
  
# 🤖 BobbyTools

**The Ultimate AI Provider & CLI Launcher for Lazy Developers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

</div>

---

**Jujur aja,** nge-manage banyak akun AI (OpenAI, Anthropic, Groq, local LLM, dll) itu *pain in the ass*. 

Apalagi kalo lo punya banyak "tuyul" (akun) dan tiap provider punya *requirement* credential yang beda-beda (ada yang butuh Account ID, Org ID, dll). Terus pas mau jalanin tools CLI AI kayak `opencode` atau `aider`, lo harus nge-set *environment variables* (ENV) manual satu-satu setiap kali ganti akun. Capek, boros waktu, dan rentan salah copas.

Berawal dari rasa males itu, **BobbyTools** lahir. 

Lo tinggal setup provider dan akun lo *sekali* aja di sini. Selanjutnya, BobbyTools bakal ngurusin *injection* ENV-nya ke terminal secara otomatis, ngasih lo menu interaktif buat gonta-ganti akun dengan gampang, dan langsung nge-*launch* CLI favorit lo dari satu pintu.

## 🔥 Kenapa Lo Butuh Ini?

- 🏭 **Multi-Provider & Multi-Account Ready**: Setup sekali, pake berkali-kali. Cocok banget buat lo yang hobi ternak akun atau manage *billing* klien yang beda-beda.
- 🪛 **Dynamic Credentials**: Nggak cuma nangkep API Key standar. Kalo provider lo butuh `Account ID`, `Org ID`, atau parameter aneh lainnya, lo bisa nambahin *field custom* sendiri pas setup awal.
- 💉 **Smart CLI Injector**: Nggak cuma nyimpen kredensial, BobbyTools langsung nge-*inject* semua *env vars* yang dibutuhin (misal `OPENAI_BASE_URL` dan `OPENAI_API_KEY`) ke dalam *child process* CLI lo.
- 🧠 **Native SDK Support**: Mau pakai standar OpenAI? Bisa. Mau nembak API asli kayak Anthropic atau Gemini lewat Opencode? Bisa banget, tinggal ganti *plugin* SDK-nya di menu edit.
- 🎯 **UX Dibuat Pake Logika Manusia**: Menu list panjang otomatis bisa di-*search*, menu pendek gampang di-klik pakai panah. Mau hapus banyak akun limit? Tinggal *batch delete* pake spasi.

---

## 🛠️ Instalasi (The Quick Way)

Pastikan di laptop lo udah ke-install **Node.js** (wajib versi 18 ke atas biar aman).

```bash
# 1. Clone repo ini ke lokal lo
git clone https://github.com/BobbyLeonardd/BobbyTools.git

# 2. Masuk ke foldernya
cd BobbyTools

# 3. Install semua dependencies
npm install

# 4. Jadiin command "bobby" global di laptop lo
npm link
```

Beres! Lo bisa nutup terminalnya, buka terminal baru di folder *project* manapun yang lagi lo kerjain, dan ketik `bobby`. Kalo muncul menunya, instalasi lo sukses.

---

## 🎮 Cara Penggunaan (The Workflow)

Alurnya cuma tiga tahap: **Setup Provider ➔ Masukin Akun ➔ Start Session**.

### 1. Buka BobbyTools
Ketik *command* sakti ini di terminal manapun:
```bash
bobby
```

### 2. Setup Provider
- Pilih **📦 Manage Providers** ➔ **➕ Add Provider**.
- **From Template:** Paling gampang. Udah ada puluhan template bawaan (OpenAI, Groq, OpenRouter, DeepSeek, dll).
- **Custom Provider:** Kalo provider lo aneh atau baru rilis, lo bisa *define* sendiri *Base URL* sama *env var*-nya di sini.

### 3. Masukin Akun (Tuyul Lo)
- Pilih **👤 Manage Accounts**.
- Pilih provider yang barusan lo bikin, terus klik **➕ Add Account**. 
- Kasih nama (misal: "akun-gratisan-1"), terus *paste* API Key-nya. 

### 4. Gas Launching! (Start Session)
Balik ke Menu Utama.
- Pilih **🚀 Start Session**.
- Pilih Provider ➔ Pilih Akun ➔ Pilih Model.
- Pilih CLI yang mau di-*launch* (bisa `opencode`, `aider`, atau lo ketik *custom command* sendiri).

*BAM!* BobbyTools bakal nge-set ENV di *background* dan langsung ngejalanin CLI lo. Tinggal ngoding aja bro.

---

## 💡 Pro Tips (Biar Makin Cepet)

### 🚀 Quick Launch
Kalo lo ngerasa capek milih provider dan akun yang sama terus-terusan, lo bisa *bypass* semua menu itu pakai perintah:
```bash
bobby go
```
Ini bakal ngebaca *history* dan langsung *auto-launch* sesi terakhir lo. Menghemat umur lo 5 detik tiap hari.

### 🔌 Opencode Native Plugin (Selain OpenAI)
Standarnya, BobbyTools ngebaca API pakai standar OpenAI (`@ai-sdk/openai-compatible`). Kalo lo pengen `opencode` lo nembak langsung ke API asli Anthropic atau Gemini (tanpa proxy OpenRouter):
- Masuk ke **Manage Providers** ➔ **Edit Provider**.
- Edit bagian **Opencode Plugin**.
- Ganti isinya jadi *plugin* Vercel AI SDK bawaan (contoh: `@ai-sdk/anthropic` atau `@ai-sdk/google`).

### 🧹 Batch Delete (Hapus Akun Kena Limit)
Punya 50 akun dan kena limit semua? Jangan dihapus satu-satu pake jari, kriting ntar. 
Masuk ke menu **Delete Account**, pencet **Spasi** buat nyentang akun mana aja, pencet tombol `a` buat *select all*, terus **Enter**. Musnah seketika.

---

## 🔒 Privasi & Konfigurasi Lokal

Kredensial dan API Key lo **100% aman** dan nggak dikirim ke server pihak ketiga mana pun (kecuali langsung ke API AI-nya). BobbyTools cuma nyimpen data akun lo murni di lokal laptop lo, letaknya di:
`~/.bobbytools/config.json` 

*(Warning: Kalo lo lagi iseng nge-backup dotfiles, pastiin config ini masuk ke `.gitignore` ya!)*

## 🤝 Berkontribusi

Nemu *bug*? Punya ide fitur sinting? Atau ngerasa kodenya masih bisa di-refactor? 
*Feel free* buat buka Issue atau lempar *Pull Request*. Proyek ini *open-source* dari *developer* buat *developer*. Santai aja bro!

---
<div align="center">
Dibuat dengan 💧 keringat, ☕ kopi, dan banyak 🐛 bug fixing oleh <b>Bobby Leonardo</b> & Contributors.
</div>
