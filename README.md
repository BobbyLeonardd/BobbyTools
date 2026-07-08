# 🚀 BobbyTools 

> AI Provider Manager & CLI Launcher. Satu pintu buat manage puluhan akun AI lo tanpa harus ribet gonta-ganti API Key manual.

Jujur aja, nge-manage banyak akun AI (OpenAI, Anthropic, Groq, local LLM, dll) itu ribet banget. Apalagi kalo lo punya banyak "tuyul" (akun) dan tiap provider punya *requirement* credential yang beda-beda (ada yang butuh Account ID, Org ID, dll). Terus pas mau jalanin tools AI CLI kayak `opencode` atau `aider`, lo harus nge-set *environment variables* (ENV) manual satu-satu setiap kali ganti akun. Capek kan?

Nah, **BobbyTools** dibikin khusus buat ngeberesin masalah *workflow* itu.

Lo tinggal setup provider dan akun lo sekali di sini, selanjutnya BobbyTools bakal ngurusin *injection* ENV-nya secara otomatis, manajemen akun biar gampang gonta-ganti, dan langsung nge-*launch* CLI favorit lo (kayak opencode, aider, atau *custom command* lo sendiri) langsung dari satu tempat.

## 🔥 Kenapa Lo Butuh Ini?

- **Multi-Provider & Multi-Account Ready**: Setup sekali, pake berkali-kali. Cocok banget buat lo yang hobi ternak akun atau manage banyak *billing* beda.
- **Dynamic Credentials**: Nggak cuma nangkep API Key. Kalo provider lo butuh `Account ID`, `Org ID`, atau parameter aneh lainnya, lo bisa nambahin *field custom* sendiri pas setup.
- **Smart CLI Launcher**: Nggak cuma nyimpen API Key doang, tapi langsung nge-*inject* semua *env vars* yang dibutuhin (kayak `OPENAI_BASE_URL` dan `OPENAI_API_KEY`) ke dalam *child process* pas lo ngejalanin CLI.
- **Native Support Buat Semua AI**: Mau pakai standar OpenAI? Bisa. Mau nembak API asli kayak Anthropic atau Gemini lewat Opencode? Bisa banget, tinggal ganti nama *plugin* SDK-nya di menu edit.
- **UX Dibuat Pake Logika Manusia**: Menu panjang otomatis bisa di-*search*, menu pendek gampang di-klik. Mau hapus banyak akun? Nggak perlu satu-satu, tinggal *batch delete* pake spasi.

---

## 🛠️ Tutorial Instalasi (Step-by-Step)

Pastikan di laptop lo udah ke-install **Node.js** (wajib versi 18 ke atas biar aman).

1. **Clone Repo Ini**
   Buka terminal atau PowerShell lo, terus jalanin perintah ini buat nge-clone *source code* BobbyTools ke laptop lo:
   ```bash
   git clone https://github.com/username/bobbytools.git
   ```
   *(Jangan lupa ganti URL di atas pake link repo GitHub lo)*

2. **Masuk ke Folder Project**
   ```bash
   cd bobbytools
   ```

3. **Install Dependencies**
   Biar semua *library* (kayak menu interaktif Inquirer) ke-download:
   ```bash
   npm install
   ```

4. **Jadiin Command Global**
   Ini langkah krusial biar lo bisa manggil perintah `bobby` dari folder manapun di laptop lo (nggak harus selalu masuk ke folder bobbytools):
   ```bash
   npm link
   ```

Beres! Sekarang lo bisa nutup terminalnya, buka terminal baru di folder manapun yang lo mau, dan ketik `bobby`. Kalo muncul menunya, berarti instalasi lo sukses 100%.

---

## 🎮 Cara Penggunaan (The Workflow)

Cara pakenya gampang banget, alurnya cuma: **Pilih/Bikin Provider ➔ Masukin Akun ➔ Start Session**.

### Step 1: Buka BobbyTools
Ketik aja *command* sakti ini di terminal:
```bash
bobby
```

### Step 2: Setup Provider (Penyedia AI)
1. Di menu utama, pilih **📦 Manage Providers**.
2. Pilih **➕ Add Provider**.
3. Di sini lo punya dua pilihan:
   - **From Template:** Kalo lo males mikir, pilih ini. Kita udah nyediain puluhan template siap pakai (OpenAI, Groq, OpenRouter, DeepSeek, dll).
   - **Custom Provider:** Kalo provider kesayangan lo belum ada di template, lo bisa bikin sendiri. Lo bisa ngatur *Base URL*, *Env Var* buat API Key (misal `ANTHROPIC_API_KEY`), sampe nambahin parameter *custom* kayak *Account ID*.

### Step 3: Masukin Akun (Tuyul) Lo
Provider doang nggak ada gunanya kalo nggak ada isinya.
1. Masih di menu Manage Providers, pilih **👤 Manage Accounts**. (Atau bisa juga langsung klik Manage Accounts di menu Manage Provider).
2. Pilih provider yang barusan lo bikin.
3. Klik **➕ Add Account**. 
4. Masukin nama akunnya (misal: "tuyul-groq-1"), terus masukin *API Key*-nya. 
*(Lo bisa nambahin sebanyak apapun akun yang lo mau di sini).*

### Step 4: Gas Launching! (Start Session)
Kalo provider dan akun udah *ready*, balik ke Menu Utama (tekan `<` atau pilih menu *Back*).
1. Pilih **🚀 Start Session**.
2. **Select Provider:** Pilih provider mana yang mau lo pake.
3. **Select Account:** Pilih akun mana yang mau lo tumbalin. Di sini bakal kelihatan akun mana yang statusnya masih hijau (Active) atau merah (Limited).
4. **Select Model:** Ketik/pilih modelnya (misal `gpt-4o`, `llama3-70b`, dll).
5. **Launch With:** Pilih lo mau ngejalanin CLI apa. (Bisa `opencode`, `aider`, atau lo ketik *custom command* lo sendiri).

*BAM!* BobbyTools bakal nge-set ENV di *background* dan langsung ngejalanin CLI tujuan lo. Lo tinggal nunggu *prompt* CLI-nya muncul dan bisa *coding* dengan tenang.

---

## 💡 Fitur Advanced (Tips & Trick)

**1. Quick Launch (Biar Gak Ribet Milih Lagi)**
Kalo lo ngerasa capek milih provider dan akun yang sama terus tiap kali buka terminal, lo bisa *bypass* semua menu itu pakai perintah:
```bash
bobby go
```
Ini bakal langsung ngebuka sesi terakhir yang lo pake. Super cepet!

**2. Opencode Native Plugin (Selain OpenAI)**
Standarnya, BobbyTools maksa `opencode` buat ngebaca API pakai standar OpenAI (`@ai-sdk/openai-compatible`). 
Tapi kalo lo mau nembak API asli kayak Anthropic atau Gemini langsung tanpa perantara OpenRouter, lo gampang banget ubahnya:
- Masuk ke **Manage Providers** ➔ **Edit Provider**.
- Pilih provider-nya, terus pilih menu edit **Opencode Plugin**.
- Ubah isi *default*-nya jadi *plugin* bawaan Vercel AI SDK, misalnya `@ai-sdk/anthropic` atau `@ai-sdk/google`.

**3. Batch Delete (Hapus Akun Massal)**
Punya 50 akun dan mau dihapus semuanya karena udah kena *limit*? Nggak perlu pegel jempol. Masuk ke menu **Delete Account**, pencet **Spasi** buat nyentang akun mana aja yang mau dibuang, pencet huruf `a` buat *select all*, terus pencet **Enter**. Kelar.

---

## 🧠 Konfigurasi Lokal

Data rahasia (API Key dll) lo 100% aman dan nggak dikirim kemana-mana. BobbyTools cuma nyimpen datanya di lokal laptop lo, tepatnya di `~/.bobbytools/config.json`. 

*(Pastiin lo nggak pernah iseng nge-push file config ini ke repo public ya!)*

## 🤝 Berkontribusi

Nemu *bug*? Punya ide fitur yang lebih gila? Atau ngerasa kodenya bisa dibikin lebih rapi? *Feel free* buat buka Issue atau lempar *Pull Request*. Santai aja bro, semua *PR welcome*!

---
Dibuat dengan keringat dan kopi ☕ oleh **Bobby Leonardo** & Contributors.
