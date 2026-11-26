# entropy-filter

> English: [README.md](README.md)

Kodlama ajanları çok sayıda derleme logu, test çıktısı ve kurulum çıktısı okur; bunların büyük kısmı tekrarlayan şablon satırdır. **entropy-filter** uzun çıktının yerine bir **Digest** koyar. Hatalar, yığın izleri, başarısız assertion'lar ve özet satırları kelimesi kelimesine ve orijinal sırasıyla kalır. Tekrarlayan satırlar, orada ne olduğunu ve nerede olduğunu söyleyen tek satırlık **Elision**'lara katlanır. Ham çıktı diskinde kalır, ajan atlanan herhangi bir aralığı komutu yeniden çalıştırmadan açabilir.

```
$ entropy-filter exec -- ./run-tests.sh
[exit 1 · 0.0s]
[entropy-filter 8239e9 · stdout · 606→13 lines · omitted ranges: entropy_read_slice(capture_id, start_line, end_line)]
⟪L1-297 ×297 "PASS <path> (<n> ms)"⟫
PASS src/mod298.test.ts (21 ms)
PASS src/mod299.test.ts (22 ms)
PASS src/mod300.test.ts (23 ms)
FAIL src/billing/invoice.test.ts
  ● Invoice › applies KDV
    Expected: 120
    Received: 100
      at Object.<anonymous> (src/billing/invoice.test.ts:42:23)
⟪L306-601 ×296 "PASS <path> (<n> ms)"⟫
PASS src/mod597.test.ts (40 ms)
PASS src/mod598.test.ts (41 ms)
PASS src/mod599.test.ts (42 ms)
PASS src/mod600.test.ts (3 ms)
Tests: 1 failed, 599 passed, 600 total
```

Milisaniyeler içinde CPU'da çalışır. Model, GPU veya ağ portu gerektirmez. Türkçe, İngilizce ve karma loglarda aynı şekilde çalışır.

## Neden yalnızca ilk ve son N satır tutulmuyor?

Çünkü önemli satır çoğu zaman ortadadır. Sabit baş/son kesme onu atar. Ajan ya tahmin yürütür ya da komutu yeniden çalıştırır. Yeniden çalıştırmanın maliyeti, kesmenin kazandırdığından fazladır. entropy-filter her satır için ayrı karar verir:

- **Signal Line**'lar her zaman korunur: `error`, `FAIL`, `Exception`, `Traceback`, `panic`, `exit code N`, … ve Türkçe `HATA`, `İstisna`, `Başarısız`, `Çöktü`, `Zaman aşımı`, `bulunamadı`, …. Her birinin birkaç komşu satırı (**Halo**) ve ardından gelen yığın izi de korunur.
- **Novelty**: her satır bir **Template**'e indirgenir; sayılar, yollar, kimlikler ve zaman damgaları yer tutucuya dönüşür. 400 kez görülen bir Template neredeyse hiç bilgi taşımaz, tek seferlik bir satır çok bilgi taşır. Bu, Template'in Shannon öz-bilgisidir: `-log2(p)`.
- Son 5 satır her zaman korunur, çünkü test özetleri oradadır.
- Her şey bir **Budget**'a sığar: ham boyutun %25'i, en fazla 8.000 karakter.

Ayrıntılar: [docs/SPEC.md](docs/SPEC.md) · terimler: [docs/GLOSSARY.md](docs/GLOSSARY.md) · kararlar: [docs/adr/](docs/adr/).

## Kurulum

### Claude Code (eklenti: kanca + MCP araçları + skill)

```
/plugin marketplace add tlh-k/entropy-filter
/plugin install entropy-filter@entropy-filter
```

- **PostToolUse kancası** başarılı uzun `Bash` çıktısını ve `Read` ile açılan uzun log dosyalarını küçültür. Kaynak kod hiçbir zaman filtrelenmez. `offset`/`limit` parametreli bir `Read` da filtrelenmez.
- **MCP araçları**: `entropy_exec` bir komutu çalıştırıp `[exit N]` ve bir Digest döndürür; `entropy_read_slice` saklanan bir çıktının ham satırlarını döndürür.
- **Skill**, ajana test, derleme ve lint komutlarını `entropy_exec` ile çalıştırmasını söyler. Bu önemli, çünkü Claude Code **sıfırdan farklı çıkış kodlu** bir komutun çıktısını kancanın değiştirmesine izin vermez ([ADR-0003](docs/adr/0003-replace-output-after-the-fact.md)).

### GitHub Copilot (CLI + VS Code agent: kanca + MCP + yönerge)

```bash
npx -y github:tlh-k/entropy-filter init --client copilot
```

Bu komut paketi `~/.entropy-filter/bin/` klasörüne kopyalar. MCP sunucusunu `~/.copilot/mcp-config.json` ve `.vscode/mcp.json` dosyalarına ekler, `~/.copilot/hooks/entropy-filter.json` içine bir `postToolUse` kancası kurar ve kuralları `.github/copilot-instructions.md` dosyasına yazar. Copilot'un kancası, **sıfırdan farklı kodla biten komutlar dahil** kabuk sonuçlarını değiştirebilir; yani başarısız test çıktıları da otomatik süzülür. Bu, Copilot'un belgelenmiş kanca şemasına göre doğrulandı; henüz canlı bir Copilot oturumunda denenmedi. VS Code agent kancaları önizleme aşamasında.

### Antigravity (eklenti: MCP + kurallar + skill)

```bash
npx -y github:tlh-k/entropy-filter init --client antigravity
```

Bu komut eklentiyi `~/.gemini/config/plugins/entropy-filter/` klasörüne kurar; ardından Antigravity'yi yeniden başlat. Antigravity'nin PostToolUse kancası araç çıktısını hiç görmez. Bu yüzden orada süzme yalnızca ajan komutları `entropy_exec` ile çalıştırdığında olur; kurallar ajana bunu söyler ([ADR-0004](docs/adr/0004-copilot-and-antigravity.md)).

### Cursor, Cline, Codex (MCP + kurallar)

```bash
npx -y github:tlh-k/entropy-filter init --client cursor   # .cursor/mcp.json + .cursor/rules/entropy-filter.mdc
```

```bash
npx -y github:tlh-k/entropy-filter init --client cline    # .clinerules/entropy-filter.md + yapıştırılacak sunucu JSON'u
```

```bash
npx -y github:tlh-k/entropy-filter init --client codex    # ~/.codex/config.toml + AGENTS.md bloğu
```

### CLI

```bash
entropy-filter exec -- npm test            # çıkış durumu + Digest; komutun çıkış koduyla çıkar
entropy-filter filter build.log            # bir dosyanın (veya stdin'in) Digest'i
entropy-filter slice c7f2a1 300 340        # saklanan bir çıktının ham satırları
entropy-filter stats                       # Digest, doğrudan geçiş ve okunan Slice sayıları
```

## Depolama ve gizlilik

- Ham çıktılar (**Capture**) proje kökünde `.entropy-filter/captures/` klasörüne yazılır. Bu klasör kendini git'te yok sayar.
- Capture'lar oturumlar arasında saklanır, böylece Elision'lar `--resume` ve compaction sonrasında da geçerli kalır. Projede 200 Capture'ı veya 100 MB'ı aşınca en eskiler silinir. Tek bir Capture en fazla 16 MB olabilir.
- Hiçbir şey makinenden çıkmaz. HTTP sunucusu yoktur, yalnızca stdio ve yerel dosyalar kullanılır.
- `.entropy-filter/stats.jsonl` Digest, doğrudan geçiş ve Slice okuma sayılarını tutar. Ajanın atlanan satırlar için geri dönmek zorunda kalıp kalmadığını buradan görebilirsin.

## Yapılandırma

Yapılandırma isteğe bağlıdır. Ayarlar `.entropy-filter/config.json` dosyasına yazılır:

```json
{ "passthroughCommands": ["terraform plan"], "budgetRatio": 0.25, "maxDigestChars": 8000, "halo": 3, "shortLines": 30 }
```

- 30 satır ve 8.000 karakter veya daha kısa çıktıya hiç dokunulmaz.
- `git diff`, `git show`, `git log -p`, `cat`, `head`, `tail`, `sed -n`, `jq` ve `less` hiçbir zaman filtrelenmez: bunların çıktısı zaten istediğin içeriktir.
- `ENTROPY_FILTER=off` her şeyi kapatır.

## Ölçüm

- `npm test` **recall kapısını** da çalıştırır. 12 fikstür içerir: jest, pytest, cargo, tsc, gradle, ANSI renkli npm, ilerleme çubuklu container derlemesi, go panic, vitest, Türkçe ERP logu, karma TR/EN ve kısa temiz çıktı. Yerleştirilen her hata satırı Digest'te kelimesi kelimesine bulunmalı, yoksa build kırılır. Şu an Digest'ler ham boyutun %1,3–19,5'i kadar.
- `entropy-filter replay --days 30` geçmiş Claude Code oturumlarını model çağırmadan filtreden geçirir. Ne kadar tasarruf edileceğini ve filtrenin geri kalan yerlerde neden devreye girmediğini gösterir. Yazarın son 30 gününde tüm Bash ve Read çıktısının **%7,5'ini** küçülttü. Uzun çıktının çoğunu ajan zaten kendisi kesmişti (`| head`, `| tail`, %21) ya da çıktı dosya içeriğiydi (`cat`, `sed -n`, `git diff`, %57). Tasarruf mütevazı ve çoğunlukla uzun derleme/test çıktısını kesmeden çalıştıran oturumlarda.
- `node bench/ab/run.mjs --repo <depon> --scenarios <klasör>` gerçek bir projede üç kollu bir A/B/C testi koşturur: eklenti kapalı, açık ve açık + `CLAUDE.md`'ye `entropy_exec` kullanmasını söyleyen tek satırlık bir ipucu. Her koşu temiz bir git worktree'de çalışır ve kolların sırası karıştırılır. Transcript'ten her koşunun bağlama giren karakter sayısını, filtrenin tetiklenip tetiklenmediğini, yeniden getirmeleri (`entropy_read_slice` ve hedefli `Read`) ve tekrar çalıştırmaları okur. Senaryolar senin projende kalan JSON dosyalarıdır. `node bench/ab/report.mjs results-ab.json` medyanları bootstrap %95 güven aralıklarıyla yazdırır.
- `node bench/live-ab.mjs --runs 5` aynı görevi `claude -p` ile eklentili ve eklentisiz çalıştırır. Token, maliyet, tur sayısı, Slice okuma ve tekrarlanan komut sayısını karşılaştırır. `claude-haiku-5-5` ile ilk tek koşu: iki koşuda da 5 bulgunun 5'i bulundu; maliyet eklentisiz $0.0135, eklentili $0.0070. Tek koşu sonuç sayılmaz; güvenmeden önce tekrarla.

## Geliştirme

```bash
npm install
npm run check      # typecheck + birim testleri + recall kapısı + build + paket üzerinde e2e
```

`dist/` klasörü commit'lenir, böylece `npx github:tlh-k/entropy-filter` derleme adımı olmadan çalışır. Güncel değilse CI kırılır.

## Lisans

MIT
