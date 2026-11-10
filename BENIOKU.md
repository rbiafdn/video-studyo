# Video Stüdyo – Otomatik Yönetmen

Serbest formatlı bir Türkçe senaryodan (başlık, süre, müzik notları, bölümler, kamera tüyoları, dış ses, diyaloglar, ekran yazıları) tam bir video üreten yerel web uygulaması. Akış:

**Senaryoyu yapıştır → Claude çekim listesi çıkarır ve her çekim için aracı seçer → onay ekranında düzelt → "Onayla ve üret" → çekimler üretilir, ses katmanları eklenir, ffmpeg final videoyu birleştirir.**

Varlıklar (karakterler, mekânlar, anlatıcılar, müzik dosyaları) **Kütüphane** sekmesinde projeden bağımsız tutulur ve her videoda yeniden kullanılır.

## Kurulum

1. Node.js 18+ kurulu olmalı.
2. Klasörde `npm install`.
3. `.env.example` dosyasını `.env` olarak kopyalayıp anahtarları doldurun.
4. `npm start` → tarayıcıda `http://localhost:3000`.

ffmpeg ayrıca kurulmaz (`ffmpeg-static` ile gelir). Ekran yazıları için Türkçe karakterleri destekleyen Noto Sans fontu `assets/fonts/` altında gelir (SIL Open Font License).

## .env

| Değişken | Nereden | Ne için |
|---|---|---|
| `ANTHROPIC_API_KEY` | platform.claude.com → API Keys | Senaryoyu çekim listesine çevirme |
| `CLAUDE_MODEL` / `CLAUDE_MODEL_HARD` | `claude-sonnet-5-5` / `claude-opus-5-5` | Normal planlama / "Zor planlama" kutusu |
| `GEMINI_API_KEY` | aistudio.google.com → Get API key (faturalandırma açık olmalı) | İlk kare görselleri (referans fotoğraflı) + hareketli çekim videosu |
| `GEMINI_IMAGE_MODEL`, `GEMINI_IMAGE_SIZE` | `gemini-nano-banana-2.1`, `1K` | Görsel modeli |
| `VEO_MODEL`, `GEMINI_VIDEO_RESOLUTION`, `GEMINI_VIDEO_DURATION` | `gemini-omni-1.2-flash`, `720p`, `8s` | Hareketli çekim videosu (Veo'nun yerini alan model) |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Profil → API Keys | Sesler, ses değiştirme, müzik, efekt |
| `ELEVENLABS_DIALOGUE_MODEL` | `eleven_v4` | Diyaloglar; duygu etiketleri ([shouting], [crying], [whispers]) desteklenir |
| `ELEVENLABS_TTS_MODEL` | `eleven_multilingual_v2` | Dış ses (anlatıcı) |
| `ELEVENLABS_STS_MODEL` | `eleven_multilingual_sts_v2` | Voice Changer (klip sesini karakter sesine çevirme) |
| `ELEVENLABS_MUSIC_MODEL`, `ELEVENLABS_SFX_MODEL` | `music_v2_5`, `eleven_text_to_sound_v3` | Müzik ve ses efekti üretimi |
| `FAL_KEY` | fal.ai/dashboard/keys | Avatar (dudak uyumlu konuşma) ve Seedance |
| `FAL_AVATAR_MODEL`, `FAL_AVATAR_FALLBACK_MODEL` | `fal-ai/kling-video/ai-avatar/v2/standard`, `fal-ai/bytedance/omnihuman` | Avatar modeli ve yedeği |
| `SEEDANCE_MODEL`, `SEEDANCE_RESOLUTION` | `bytedance/seedance-2.5/us/image-to-video`, `720p` | Konuşmasız hareketli çekimler |

Anahtarlar sunucuda kalır. Eksik anahtar varsa üstteki nokta gri kalır, ilgili butonlar nedenini yazarak pasif olur.

## Kütüphane

- **Karakterler:** ad, kısa tarif, 1–4 referans fotoğraf, ElevenLabs sesi, ses notu. Tarif her görsel promptuna aynen eklenir; fotoğraflar Gemini'ye referans olarak gönderilir (karakter tutarlılığı).
- **Mekânlar:** ad, tarif, 1–4 referans fotoğraf.
- **Dış ses:** ad + ElevenLabs sesi (birden fazla anlatıcı olabilir).
- **Müzik / efekt dosyaları:** kendi mp3'leriniz, etiketli ("gergin keman"). Claude ses katmanında `library:<etiket>` yazarsa dosya eşleştirilir; yoksa ElevenLabs ile üretilir.

Claude senaryoda kütüphanede olmayan bir kişi bulursa karakterlere kendisi ekler (ses seçmeniz gerekir); emin olamadığı eşleştirmeleri onay ekranında "sorular" olarak gösterir.

## Çekim listesi ve araç seçimi

Claude her çekim için şu araçlardan birini seçer ve Türkçe gerekçe yazar:

| Araç | Ne zaman | Nasıl |
|---|---|---|
| **Avatar (fal.ai)** | Sabit kamera, tek kişi, uzun konuşma | Görsel → ElevenLabs sesi (duygu etiketli) → dudak uyumlu video |
| **Gemini (otomatik)** / **Flow (elle)** | Kamera hareketi + oyunculuk, güçlü duygu, iki kişi | Görsel → video (sesli); tek konuşan varsa ses Voice Changer ile karakter sesine çevrilir. En fazla 8 sn |
| **Seedance (fal.ai)** | Konuşmasız hareket, atmosfer, geçiş | Görsel → sessiz video; ses katmanlardan gelir |
| **Yazı kartı (ffmpeg)** | Açılış kancası, kapanış alıntısı | Siyah fon + yazı, yapay zeka yok, ücretsiz |

Dış ses satırları ElevenLabs ile ayrı üretilip zamanına yerleştirilir. Ekran yazıları (kanca, altyazı, kapanış kartı) hiçbir zaman video modeline yazdırılmaz; ffmpeg ile bindirilir.

Claude ayrıca **uyarılar** yazar: süreye sığmayan konuşmalar (Türkçe ≈ 2,5 kelime/sn), hedef süre aşımı, doğruluğu önemli metinler (ayet, hadis, istatistik → "kaynağını doğrulayın"), video filtresine takılabilecek ifadeler.

## Onay ekranı

Plan geldikten sonra hiçbir şey üretilmez. Zaman çizelgesinde bölümler ve çekimler sırayla; her çekimde süre, araç (açılır menüden değiştirilebilir), gerekçe, replik/dış ses/ekran yazısı (düzenlenebilir), promptlar (açılır) ve tahmini maliyet. Çekim silinip eklenebilir; ses katmanları (müzik / efekt / sessizlik; kütüphane veya üret) düzenlenebilir. Altta toplam tahmin ve **Onayla ve üret**.

## Üretim ve birleştirme

- Çekimler sırayla üretilir; Flow çekimleri "Flow bekleniyor" durumunda kalır (görseli indir → Flow'da üret → klibi yükle). Herhangi bir çekime "Elle klip yükle" ile kendi klibinizi koyabilirsiniz.
- Gemini video filtresi: Gemini bir sahneyi reddederse (bağırma, tehdit, korkmuş kişi gibi ifadeler) Claude video promptunu otomatik yumuşatır (replik aynen kalır) ve bir kez daha dener; yine reddedilirse hata mesajı Avatar aracına geçmeyi ya da promptu düzenlemeyi önerir. 4,5 saniyeye sığan çekimler için 4 saniyelik (yarı fiyat) video istenir.
- Müzik/efekt: kütüphaneden ya da ElevenLabs ile üretilir, süreye göre kırpılır, giriş/çıkış fade uygulanır.
- Birleştirme (ffmpeg): tüm çekimler aynı çözünürlükte (siyah bant yok), 30 fps H.264 + AAC. Diyalog/klip sesi + dış ses + müzik + efekt karıştırılır; konuşma olan yerde müzik otomatik kısılır (sidechain ducking), "sessizlik" bölümlerinde müzik tamamen kapanır. Bölüm renk tonu (soğuk mavi, sıcak, siyah-beyaz…) uygulanır. Ekran yazıları zamanına göre bindirilir (kanca üst-orta büyük; kapanış kartı siyah fon, beyaz + altın, yavaş fade-in). Bölüm geçişlerinde ve sonda kararma.
- Tüm çekimler bitince final otomatik birleşir; "Final videoyu indir" çıkar. Çekim değiştirdiyseniz "Finali yenile".

## Maliyet

- Birim fiyatlar `prices.json` dosyasında (`"tahmini": true` olanlar resmi sayfada bulunamayan değerlerdir; müzik fiyatı tahminidir). Dosya her okunuşta yenilenir.
- Onay ekranında çekim başına ve toplam tahmin; üretimde gerçek kullanım `data/videos/<id>/video.json` içindeki `costs` listelerine yazılır. Başlıkta harcama / bütçe çubuğu; bütçe aşılacaksa onay istenir.
- Üst çubukta ElevenLabs kalan kredi; Anthropic, Google ve fal.ai için fatura sayfası bağlantıları.

## Dosyalar

- `server.js` – Express sunucu ve API
- `lib/store.js` – `data/settings.json`, `data/library/` (library.json + dosyalar), `data/videos/<id>/video.json`
- `lib/claude.js` – otomatik yönetmen promptu ve yapısal JSON şeması
- `lib/gemini.js` – görsel (referans fotoğraflı) + video (Interactions API)
- `lib/elevenlabs.js` – sesler, duygu etiketli TTS, Voice Changer, müzik, efekt, bakiye
- `lib/fal.js` – avatar (Kling) ve Seedance kuyruk API'si
- `lib/media.js` – ffmpeg: yazı kartı, ekran yazıları, renk tonu, ducking, birleştirme
- `lib/jobs.js` – üretim akışı, kilitler, ses katmanları, elle klip, birleştirme
- `lib/costs.js` – fiyatlar, tahmin, kayıt, bütçe
- `public/index.html` – arayüz (tek dosya, saf JavaScript, koyu tema)
- `assets/fonts/` – Noto Sans (OFL)
