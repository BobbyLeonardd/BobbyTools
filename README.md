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

Intinya gini. Kalo lo pake banyak akun AI gratisan (Groq, Anthropic, Gemini) atau gonta-ganti API key klien, lo pasti ngerasain betapa muaknya harus *stop* terminal, ganti `.env`, dan nge-run ulang aplikasi tiap kali API limit.

Gue bikin **BobbyTools** buat nyelesain masalah itu sekali seumur hidup. Setup sekali, biarin dia jalan di background jadi router. Dia yang bakal mikir akun mana yang lagi limit, dia yang bakal ngerotasi API key otomatis, dan dia yang bakal nyari provider cadangan kalo semuanya mati. Lo tinggal ngoding.

---

## ⚡ Instalasi

Minimal Node.js v18. Kalo belum ada, update dulu.

```bash
npm install -g bobbytools
```

Beres. 

---

## 🚀 Cara Pake (Mode Dewa / Web Router)

Ini mode yang bikin alat ini *worth it*. BobbyTools jalan sebagai server lokal di background.

1. Buka terminal, ketik:
```bash
bobby serve
```
2. Buka **http://127.0.0.1:13337** di browser lu.
3. Di situ ada UI *glassmorphism* kece. Tambahin provider (misal: Groq). Tambahin akun sebanyak yang lu punya. Masukin API Key-nya. Kalo provider lu aneh dan butuh `accountId`, tenang, bisa di-set dinamis.
4. **Penting:** Buka terminal tempat lu biasa ngoding (pake `aider`, `opencode`, `cursor`, dsb), arahin URL-nya ke server lokal kita:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:13337/v1"
export OPENAI_API_KEY="bebas-isi-apa-aja"
```
*(User Windows pake PowerShell? Ketik `$env:OPENAI_BASE_URL="..."`)*

5. Panggil model lu dengan awalan nama provider:
```bash
opencode -m groq/llama3-70b-8192
```

**Kenapa ini jenius?** 
CLI lu ngirim API key bodong. BobbyTools nangkep request lu, nyari akun Groq yang lagi aktif di memori, nyuntikin API Key asli lu, dan nerusin ke server Groq. Kalo akun pertama kena limit (429), Bobby otomatis nge-retry pake akun kedua tanpa ngasih tau CLI lu. CLI lu taunya request sukses mulus. *Black magic*.

---

## 💻 Cara Pake (Mode Klasik / Terminal)

Kalo lu males buka browser dan cuma mau jalanin satu tool dengan gampang tanpa pusing mikirin `export` env var.

1. Ketik `bobby` di terminal.
2. Ke menu **Manage Providers & Accounts**, tambahin akun lu. Di sini lu juga bisa ngisi *Target CLI Command* (misal lu biasa pake `opencode`).
3. Pilih **Start Session**.
4. Pilih Provider -> Pilih Akun -> Pilih Model.
5. BobbyTools bakal langsung jalanin `opencode` (atau apapun target lu) dengan API Key yang disuntikin otomatis ke memori prosesnya. Lu tinggal pake.

---

## 📚 Daftar Perintah (Commands)

- **`bobby`**
  Ngebuka menu utama interaktif (buat nambah akun, pilih model, dll).
- **`bobby go`**
  Jalan pintas orang malas. Langsung ngebuka sesi terakhir lu tanpa lewat menu klik-klik lagi.
- **`bobby serve`**
  Nyalain Web Dashboard di depan layar (foreground). Kalo terminalnya lu tutup, servernya ikut mati.
- **`bobby serve-bg`**
  Nyalain Web Dashboard di belakang layar (background/daemon). Terminal bebas lu tutup, server tetep idup dan otomatis ngebukain browser.
- **`bobby list`**
  Nampilin daftar lengkap semua Provider dan API Key (Akun) yang udah lu simpen, tanpa masuk ke menu.
- **`bobby update`**
  Ngasih tau instruksi cara update BobbyTools ke versi paling baru dari NPM.
- **`bobby -v`** (atau `--version`)
  Ngecek versi BobbyTools yang lagi lu pake sekarang.
- **`bobby -h`** (atau `--help`)
  Nampilin contekan/bantuan.

---

## 🚫 Disclaimer

1. **Bukan Translator:** BobbyTools gak nerjemahin format JSON Anthropic jadi format OpenAI. Kalo CLI lu cuma support Anthropic, pastiin lu nembak model Anthropic (kecuali CLI lu emang pinter).
2. **Kagak Ada Enkripsi:** Konfig lu disimpen polos di `~/.bobbytools/config.json`. Jangan pernah commit file ini ke Git publik. Kalo API AWS lu bocor, salahin diri lo sendiri.

---
*Dibuat karena males.*
