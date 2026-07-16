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

## ⚡ Pasang

Butuh Node.js v18 ke atas. Cek dulu: `node -v`. Kalo di bawah 18, update dulu, jangan ngeyel.

```bash
npm install -g bobbytools
```

Udah. Ketik `bobby`, kalo banner-nya muncul berarti beres.

---

## 🌐 Cara 1: Mode Router (yang bikin alat ini worth it)

BobbyTools jalan sebagai server lokal. CLI ngoding lo (aider, opencode, cursor, dsb) nembak ke server ini, bukan langsung ke provider. Di sinilah semua sihir anti-limit terjadi.

**Nyalain:**

```bash
bobby serve-bg
```

Ini jalanin router di background (daemon) dan langsung bukain browser ke `http://127.0.0.1:13337`. Terminalnya boleh lo tutup, dia tetep idup. Kalo lo mau liat lognya jalan real-time di depan mata, pake `bobby serve` (foreground, tutup terminal = mati).

**Di web dashboard:**

1. Klik **Add Provider**. Pilih dari template (Groq, OpenAI, Gemini, dll udah ada) atau bikin custom.
2. Masuk ke provider itu, tambahin **Akun** sebanyak API key yang lo punya. Punya 5 key Groq gratisan? Masukin semua lima.

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
| `bobby update` | Instruksi cara update dari NPM. |
| `bobby -v` | Cek versi. |
| `bobby -h` | Contekan bantuan. |

---

## 🚫 Yang Perlu Lo Tau (Disclaimer)

1. **Bukan penerjemah format.** BobbyTools gak nerjemahin format Anthropic ke OpenAI. Kalo CLI lo cuma ngerti Anthropic, nembaknya ke model Anthropic. Router cuma nerusin request, bukan ngubah bentuknya.
2. **Config disimpen polos.** Semua ada di `~/.bobbytools/config.json`, gak dienkripsi. Jangan sekali-kali commit file ini ke repo publik. API key bocor gara-gara lo sendiri ceroboh, ya salahin cermin.
3. **Router cuma dengerin localhost.** Server bind ke `127.0.0.1`, jadi gak keekspos ke jaringan. Aman buat mesin sendiri.

---
*Dibuat karena males. Dirawat karena kepalang.*
