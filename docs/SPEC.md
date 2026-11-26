# Entropi Tabanlı Akıllı Çıktı Filtresi — Revize Spesifikasyon (v1)

> Bu doküman, orijinal "Bilgi Entropisi Tabanlı Akıllı Log ve Çıktı Filtresi" spesifikasyonunun
> grill-with-docs incelemesinden sonra alınan kararlarla revize edilmiş hâlidir. Kararların gerekçesi
> `docs/adr/` altında, terimler `docs/GLOSSARY.md` içindedir. Terimler (Capture, Digest, Elision,
> Slice, Template, Novelty, Signal Line, Halo, Budget) bu dokümanda o sözlükteki anlamlarıyla kullanılır.

## 1. Problem

Kodlama ajanlarının çalıştırdığı derleme, test ve kurulum komutlarının çıktısı büyük oranda tekrarlayan
şablon satırdır. Bu satırlar token harcar ve "ortada kaybolma" etkisini büyütür. Mevcut araçlar iki
yerde tıkanır:

- **Sabit satır kesme** (ilk/son N satır) logun ortasındaki kök hatayı atar; ajan hatayı göremeyip
  yanlış varsayımla döngüye girer.
- **Yeniden getirme cezası**: kesilen bilgiyi geri almak için yapılan ek çağrılar tasarrufu yer.
  Hedef "daha çok satır silmek" değil, **bilgi taşıyan satırları korurken** gürültüyü atmak ve atılan
  kısma ucuz, hedefli bir dönüş yolu bırakmaktır.

## 2. Mimari

Tek TypeScript paketi (Node ≥20, esbuild ile tek dosya `dist/entropy-filter.mjs`), ortak çekirdek.

| Katman | Bileşen | Kapsam |
| --- | --- | --- |
| Çekirdek | Filtre motoru + Capture deposu | Hepsi |
| Otomasyon | `entropy-filter hook post-tool-use [--client copilot]` | Claude Code, Copilot (CLI + VS Code) |
| Araçlar | `entropy-filter serve` (stdio MCP): `entropy_exec`, `entropy_read_slice` | Hepsi |
| Yönerge | `skills/entropy-filter/SKILL.md`, `.cursor/rules`, `.clinerules`, `AGENTS.md`, `.github/copilot-instructions.md`, Antigravity `rules/AGENTS.md` | İlgili istemci |

CLI: `serve`, `hook post-tool-use`, `exec -- <komut>`, `filter [dosya]`, `slice <id> <başlangıç> <bitiş>`,
`init --client <claude|cursor|cline|codex|copilot|antigravity>`, `stats`.

Sistem HTTP portu dinlemez; yalnızca stdio ve yerel dosya kullanır. MCP araç yüzeyi oturum boyunca sabittir.

## 3. Claude Code entegrasyonu (ADR-0003)

Yalnızca **PostToolUse + `hookSpecificOutput.updatedToolOutput`** kullanılır; komutlar asla yeniden
yazılmaz. Claude Code 2.1.330 üzerinde gerçek koşuyla doğrulanan davranış:

| Durum | Kanca girdisi | Davranış |
| --- | --- | --- |
| Bash, çıkış 0 | `tool_response.{stdout, stderr, interrupted, isImage, noOutputExpected, …}` | Uzunsa her akış ayrı Capture + Digest olur |
| Bash, çıktı > 30.000 karakter | `stdout` 30.000'de kesik, tam metin `persistedOutputPath` dosyasında | Capture **o dosyadan** okunur |
| Bash, çıkış ≠ 0 | `PostToolUseFailure`, `error: "Exit code N\n…"` | Değiştirilemez → kanca hiçbir şey yapmaz |
| Read | `tool_response.file.{content, numLines, startLine, totalLines}` | Log benzeri dosyaysa Digest; Capture yazılmaz |

Başarısız komutların çıktısı kancayla küçültülemediği için SKILL.md ve tüm istemci kuralları,
**test, derleme ve lint komutlarının doğrudan `entropy_exec` ile çalıştırılmasını** açıkça şart koşar.
`entropy_exec` komut başarısız olsa da Digest ve çıkış kodu döndürür.

Değiştirilmeyecek durumlar (olduğu gibi geçer): `interrupted`, `isImage`, `backgroundTaskId` dolu,
`ENTROPY_FILTER=off`, kısa çıktı (§4.1), hariç tutulan komut (§6), herhangi bir iç hata (fail-open).

### 3.1 Read kapsamı

- `offset` veya `limit` parametresi olan Read çağrısı **hedefli okumadır, asla filtrelenmez** (Elision
  açarken döngü oluşmasın).
- Kaynak kod / yapılandırma uzantıları (`.ts`, `.py`, `.java`, `.json`, `.md`, `.xml`, `.yaml`, …) asla filtrelenmez.
- `.log`, `.out`, `.err` dosyaları kısa eşiği aşarsa filtrelenir. Diğer uzantılar (veya uzantısız)
  yalnızca satırların ≥%40'ı en az 3 kez tekrarlanan Template'lere aitse filtrelenir.
- Read için Capture yazılmaz: dosya diskte durur. Elision'lar dosyanın gerçek satır numaralarını verir;
  model atlanan aralığı Read `offset`/`limit` ile okur.
- Grep, Glob ve diğer MCP araçlarının çıktısı v1 kapsamı dışındadır.

### 3.2 Diğer istemciler (ADR-0004)

| İstemci | Otomatik süzme | Kurulum (`init --client …`) |
| --- | --- | --- |
| Copilot CLI / VS Code agent | `postToolUse` → `modifiedResult` (bash/powershell; sıfırdan farklı çıkışlar dahil) | `~/.entropy-filter/bin/` kopyası, `~/.copilot/mcp-config.json`, `~/.copilot/hooks/entropy-filter.json`, `.vscode/mcp.json`, `.github/copilot-instructions.md` |
| Antigravity | Yok: PostToolUse çıktıyı görmez ve değiştiremez | Eklenti `~/.gemini/config/plugins/entropy-filter/` (MCP + rules + skill); depo kökü de aynı eklentidir |
| Cursor, Cline, Codex | Yok | MCP + kural dosyası |

Kancası olmayan istemcilerde test/derleme/lint komutları kurallar aracılığıyla `entropy_exec`'e yönlendirilir.

## 4. Filtre boru hattı

### 4.1 Kısa çıktı geçişi

Çıktı **≤30 satır ve ≤8.000 karakter** ise hiç dokunulmaz (sıfır kayıp, Capture yok). Az satırlı ama
çok uzun çıktı (minify JS, tek satır JSON) filtreye girer.

### 4.2 Gürültü kapısı (satır numarası korunur)

Satır numaraları her zaman Capture'daki ham satırlara göredir. Kapı satır silmez, yalnızca puanlama
için satırın "temiz" hâlini üretir ve bazı satırları atlanabilir işaretler:

- ANSI renk/imleç ve OSC dizileri temizlenir.
- `\r` içeren satırda yalnızca son `\r` sonrası tutulur (ilerleme çubuğu üzerine yazma).
- Yalnızca spinner / ilerleme çubuğu / yüzde içeren satırlar ve boş satırlar gürültü sayılır.
- 2.000 karakteri aşan tek satır, baş ve sonu korunarak satır içinde kısaltılır: `…⟪+184312 chars⟫…`.

### 4.3 Puanlama (ADR-0001)

- **Signal Line**: iki dilli hata işaretlerinden birini içeren satır. EN: `error`, `fail(ed|ure)`,
  `exception`, `traceback`, `fatal`, `panic`, `assert`, `segfault`, `exit code`, `not ok`, `✗ ✕ ✘`, …
  TR: `hata`, `istisna`, `başarısız`, `çöktü`, `zaman aşımı`, `bulunamadı`, `reddedildi`, `geçersiz`, …
  Büyük/küçük harf ve Türkçe `İ/ı` farkı yok sayılır. Sıfır sayaçlar (`0 errors`, `failed: 0`,
  `hata yok`) sinyal değildir; yol içindeki sözcükler (`src/error-handler.ts`) sayılmaz. Signal Line
  koşulsuz korunur; puan artırımı değildir. Aynı Template'e sahip Signal Line'lardan yalnızca ilk iki
  ve son geçiş zorunludur (500 kez tekrarlanan `ERROR retrying` Budget'ı yutmasın); kalanlar Elision olur.
- **Yığın izi**: Signal Line'ı izleyen yığın çerçevesi satırları (`at f (a.js:1:2)`, `File "x", line 3`,
  girintili devam satırları) Halo'yu 20 satıra kadar uzatır.
- **Novelty**: satır önce Template'e indirgenir (sayı, hex, UUID, zaman damgası, yol, tırnaklı dize →
  yer tutucu). Puan = `0.5·I(template) + 0.5·I(önek)`; burada `I(x) = -log2(sayı(x)/toplam)` ve önek,
  Template'in ilk iki sözcüğüdür (`npm WARN …` gibi tekil ama aynı kalıplı satırları yakalar).
  Satır içi sözcük entropisi yalnızca eşitlik bozucudur.
- **Kuyruk**: son 5 anlamlı satır her zaman korunur (test özetleri sondadır). Araca özel "hepsi geçti"
  tanıyıcısı yoktur.

### 4.4 Seçim ve Budget

1. Budget = `min(max(%25 · ham karakter, 2.000), 8.000)` karakter (yapılandırılabilir).
2. Zorunlu küme: Signal Line'lar + Halo'ları (varsayılan ±3) + kuyruk.
3. Zorunlu küme Budget'ı aşarsa: önce Halo genişliği 3→1→0 düşürülür; yine aşarsa Signal Line'lar
   baştan ve sondan dönüşümlü (1., son, 2., sondan 2., …) sığdığı kadar alınır. 8.000 tavanı kesindir.
4. Kalan Budget yalnızca **nadir** satırlarla doldurulur: Template'i en çok 2 kez geçen ve öneki
   satırların %5'inden (en az 5) fazlasında görülmeyen satırlar, Novelty puanına göre. Budget bir
   tavandır, hedef değil: tekrarlayan satırlar boş yer kalsa da eklenmez.
5. Seçilmeyen ardışık satırlar tek Elision olur. Bir aralığın kendisi Elision'dan kısaysa satırlar tutulur.
6. Digest her zaman **orijinal satır sırasıyla** üretilir.

**İki akış:** stdout ve stderr ayrı Capture/Digest olur ama 8.000 tavanını paylaşır; önce stderr'e
yer ayrılır, kalan stdout'a verilir.

### 4.5 Digest biçimi

```
[entropy-filter c7f2a1 · 3000→112 lines · omitted ranges: entropy_read_slice(capture_id, start_line, end_line)]
> jest --ci
⟪L2-311 ×310 "PASS <path> (<n>ms)"⟫
FAIL src/billing/invoice.test.ts
  ● Invoice › applies KDV
    Expected: 120
    Received: 100
      at Object.<anonymous> (src/billing/invoice.test.ts:42:19)
⟪L319-2994 ×2676 "PASS <path> (<n>ms)"⟫
Tests: 1 failed, 2990 passed, 2991 total
```

Elision: `⟪L<başlangıç>-<bitiş> ×<satır sayısı> "<en sık Template>"⟫`. Read Digest başlığı Capture
kimliği yerine dosya yolunu ve "Read offset/limit" yönergesini verir.

## 5. Capture deposu (ADR-0002)

- Kök: git worktree kökü (yoksa cwd); `ENTROPY_FILTER_ROOT` ile ezilebilir.
- Konum: `.entropy-filter/captures/<id>.log` (+ `<id>.json` meta: komut, akış, zaman, satır, bayt).
  Klasör kendi `.gitignore` (`*`) dosyasını yazar; kullanıcının `.gitignore`'una dokunulmaz.
- Kimlik: 6 hex karakter.
- Döngüsel temizlik: proje başına 200 Capture veya 100 MB aşılınca en eskiler silinir; tek Capture
  en çok 16 MB (fazlası kesilir, meta'da işaretlenir). TTL yoktur; oturum sonunda silinmez.
- Silinmiş Capture istenirse: `Capture c7f2a1 rotasyonla silindi; komutu yeniden çalıştırın.`
- `.entropy-filter/stats.jsonl`: her Digest, geçiş ve Slice için bir satır (yeniden getirme ölçümü, §8).

## 6. Yapılandırma

`.entropy-filter/config.json` (isteğe bağlı, commit'lenebilir):

```json
{ "passthroughCommands": ["terraform plan"], "budgetRatio": 0.25, "maxDigestChars": 8000,
  "halo": 3, "shortLines": 30 }
```

- Varsayılan hariç komutlar (çıktısı içeriktir): `git diff`, `git show`, `git log -p`, `cat`, `head`,
  `tail`, `sed -n`, `jq`, `less`. `passthroughCommands` bu listeye eklenir. Komut `&&`, `;`, `|`
  ile bölünür; herhangi bir parçanın programı listedeyse çıktı geçer.
- `ENTROPY_FILTER=off` her şeyi kapatır. Başka ayar yoktur.

## 7. MCP araçları

| Araç | İşlev | Notasyon |
| --- | --- | --- |
| `entropy_exec` | `command` (+ `cwd`, `timeout_ms`) çalıştırır; çıkış kodu + Digest döndürür, ham akışları Capture'a yazar | yan etkili |
| `entropy_read_slice` | `capture_id`, `start_line`, `end_line` aralığını ham döndürür (en çok 400 satır / 40.000 karakter) | `readOnlyHint: true` |

`entropy_filter` aracı **yoktur**: modelin bağlamındaki metni filtrelemek token kazandırmaz. Metin
filtreleme CLI'dadır: `entropy-filter filter < build.log`.

## 8. Doğrulama

- **Recall kapısı (CI, zorunlu):** `test/fixtures/` derlemi (jest, pytest, cargo, tsc, gradle, npm
  install, ANSI/ilerleme çubuklu çıktı, Türkçe ERP logu, karma TR/EN). Her fikstürün `.needles`
  dosyasındaki her satır Digest'te birebir bulunmalı: **iğne hatırlama = %100**. Sıkıştırma oranı
  raporlanır ve fikstür başına üst sınırı vardır.
- **Geçiş testi:** kısa/temiz çıktı (≤30 satır) bayt bayt aynı döner, Capture yazılmaz.
- **Canlı A/B (elle):** `bench/live-ab.mjs` aynı görevi eklentili ve eklentisiz `claude -p` ile çalıştırır;
  toplam token, `entropy_read_slice` sayısı, aynı komutun yeniden çalıştırılma sayısı ve görev
  başarısını karşılaştırır. Sürüm öncesi çalıştırılır, CI kapısı değildir.

### 8.1 İlk ölçümler (v0.1.0)

- Recall kapısı: 12 fikstürün tamamında iğne hatırlama %100; Digest ham çıktının %1,3–19,5'i.
- 200.000 satırlık (12 MB) logda kanca ~0,7 sn.
- Canlı A/B, 1 koşu, `claude-haiku-5-5`: bulunan bilgi 5/5 → 5/5, maliyet $0,0135 → $0,0070, girdi
  token 387 bin → 221 bin. Tek koşu anlamlı değildir; sürüm öncesi `--runs 5` ile tekrarlanmalı.
- Gözlem: Haiku, SKILL.md'ye rağmen `entropy_exec` yerine Bash seçti (başarısız komutun sonuna
  `; echo $?` ekleyerek kancanın devreye girmesini sağladı). Başarısız komutlarda kancanın kör noktası
  (ADR-0003) bu yüzden gerçek bir risktir; v2'de opsiyonel sarmalama A/B verisiyle değerlendirilir.

## 9. Güvenilirlik

- Kanca fail-open: ayrıştırma, bellek, izin veya zaman hatasında hiçbir çıktı vermeden 0 ile çıkar.
- Kanca 32 MB'tan büyük girdiyi işlemez. Zaman aşımı 5 sn.
- Digest üretimi deterministiktir: aynı girdi → aynı Digest (Capture kimliği hariç).

## 10. Kapsam dışı (v1)

Sinir ağı tabanlı sıkıştırıcılar; AST/kod iskeletleme; HTTP proxy; oturumlar arası durum defteri
(state-ledger'ın işi); komut sarmalama ile çıkış kodu maskeleme (ADR-0003), Antigravity `run_command`
sarmalama dahil (ADR-0004); Grep/Glob/MCP çıktıları; Gemini CLI istemcisi.
