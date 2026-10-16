# dbscope

**Claude için veritabanı haritası.** Hangi veritabanı, dil ya da framework olursa olsun projenin veri modelini çıkarır, ilişkileri localhost'ta bir ER diyagramı olarak gösterir ve projenin ne yaptığını analiz eder. Claude'a her prompt'ta **yalnızca o prompt'la ilgili tabloları**, aynı oturumda **tekrar etmeden** gönderir.

```
Sen:      "iptal edilen siparişleri müşteriye göre raporla"
dbscope:  → orders, customers, order_items … prompt'a eklenir (bu oturumda daha önce gönderilenler tekrar gönderilmez)
Claude:   migration ve model dosyalarını taramadan doğrudan işe başlar
```

---

## İçindekiler

- [Ne sağlar, ne sağlamaz](#ne-sağlar-ne-sağlamaz)
- [Nasıl çalışır](#nasıl-çalışır)
- [Kurulum](#kurulum)
- [Claude Code ile kullanım](#claude-code-ile-kullanım)
- [Panel (localhost)](#panel-localhost)
- [Desteklenen veritabanları](#desteklenen-veritabanları)
- [Desteklenen diller ve framework'ler](#desteklenen-diller-ve-frameworkler)
- [Bağlantı nasıl bulunur](#bağlantı-nasıl-bulunur)
- [Token optimizasyonu](#token-optimizasyonu)
- [Ölçüm: gerçekten tasarruf ediyor mu?](#ölçüm-gerçekten-tasarruf-ediyor-mu)
- [Senin girdiğin bilgiler nereye gider](#senin-girdiğin-bilgiler-nereye-gider)
- [CLI komutları](#cli-komutları)
- [MCP araçları](#mcp-araçları)
- [Güvenlik ve gizlilik](#güvenlik-ve-gizlilik)
- [Sorun giderme](#sorun-giderme)
- [Proje yapısı](#proje-yapısı)

---

## Ne sağlar, ne sağlamaz

**Sağladıkları**
- Claude, şemayı öğrenmek için migration, entity ve model dosyalarını okumak zorunda kalmaz. Büyük şemalarda bu en pahalı keşif adımıdır.
- FK'sı tanımlı olmayan ilişkileri (`CustomerId → Customers`) önceden bilir, onları aramaya da gerek kalmaz.
- Aynı oturumda aynı tablo ikinci kez gönderilmez. Geniş tablolarda sadece önemli kolonlar gönderilir. DB ile ilgisiz prompt'lara hiçbir şey eklenmez.

**Sağlamadıkları**
- Claude değiştireceği servis ve repository kodunu yine okur. dbscope yalnızca şema keşfini kısaltır.
- Küçük şemalarda ya da DB ile ilgisi az olan işlerde kazanç küçüktür. Gerçek etkiyi kendi projende [ölçebilirsin](#ölçüm-gerçekten-tasarruf-ediyor-mu).

## Nasıl çalışır

```mermaid
flowchart LR
    SRC[(Veritabanları<br/>PG · MySQL · MSSQL · Oracle · SQLite<br/>Mongo · Firestore · DynamoDB · Redis<br/>Cassandra · ClickHouse · Neo4j · Elastic)] -->|salt okunur| A
    CODE[ORM / model kodu<br/>EF Core · JPA · Django · Rails<br/>Laravel · TypeORM · Prisma · GORM …] -->|bağlantı yoksa| A
    A[Analiz<br/>ilişkiler · modüller · amaç] --> M[.dbscope/model.json]
    U[Sen: prompt] --> H[Hook]
    M --> H
    S[Oturum hafızası] <--> H
    H -->|yalnızca yeni ve ilgili tablolar| C[Claude]
    C <-->|gerektiğinde| T[MCP araçları]
    H --> P[Panel · localhost:4777]
    T --> P
```

1. **Analiz:** dbscope projede bulduğu bütün veri kaynaklarını sırayla dener. Bağlanamadığını atlar, birden fazla farklı DB varsa hepsini tek modelde birleştirir (`main.orders`, `analytics.page_views`). Hiçbirine bağlanamazsa şemayı Prisma ya da SQL dosyalarından veya ORM model kodundan çıkarır.
2. **Hook:** Her prompt'ta çalışır. Prompt'u şemayla eşleştirir, bu oturumda daha önce gönderilmemiş ilgili tabloları kompakt biçimde ekler.
3. **MCP:** Claude daha fazla detaya ihtiyaç duyarsa `describe_tables`, `find_path` gibi araçları kendisi çağırır.
4. **Panel:** Hook'un ve araçların yaptığı her şey canlı olarak izlenir.

## Kurulum

Gereksinim: **Node.js 22.13 veya üzeri** ve **Claude Code**.

```bash
git clone https://github.com/<kullanici>/dbscope.git
cd dbscope
npm install
npm link
```

`npm link` komutu `dbscope` komutunu her dizinden kullanılabilir yapar. Kurulumda `dbscope` komutu PATH'te bulunursa projeye yazılan `.mcp.json` ve hook ayarı makineye özel yol yerine sadece `dbscope` komutunu içerir. Böylece bu dosyalar git'e eklenip ekipçe kullanılabilir.

Veritabanı sürücüleri `optionalDependencies` olarak gelir. Kurulamayan bir sürücü olursa sadece o veritabanı türü devre dışı kalır.

### Bir projeye bağlama

```bash
dbscope install ~/projelerim/benim-projem
```

| Dosya | Ne eklenir |
|---|---|
| `.mcp.json` | dbscope MCP sunucusu |
| `.claude/settings.json` | `UserPromptSubmit` hook'u (bağlam ekler) ve `SessionStart` hook'u (`/clear` ve `/compact` sonrası oturum hafızasını sıfırlar) |
| `.claude/settings.local.json` | dbscope MCP sunucusunu onaylı yapar |
| `CLAUDE.md` | Claude'a dbscope'u nasıl kullanacağını anlatan kısa bir not |
| `.gitignore` | `.dbscope/` |

### Bütün projeler için

```bash
dbscope install --global
```

Bu komuttan sonra Claude Code'u hangi projede açarsan aç dbscope çalışır. Veri kaynağı bulunmayan projelerde hiçbir şey yapmaz.

## Claude Code ile kullanım

```bash
cd ~/projelerim/benim-projem && claude
```

1. İlk açılışta dbscope MCP sunucusu için onay istenirse onayla.
2. `/mcp` yazarak dbscope araçlarının yüklendiğini kontrol et.
3. **Prompt'unu her zamanki gibi yaz.** Başka bir şey yapman gerekmiyor.
4. Panelin **Canlı** sekmesinde her prompt'ta hangi tabloların gönderildiğini, hangilerinin zaten bağlamda olduğunu ve kaç token gittiğini görürsün.

İstersen Claude'dan açıkça da isteyebilirsin:

```
> projenin amacını dbscope ile analiz et ve save_project_summary ile kaydet
> order_items tablosundan customers tablosuna join yolu ne?
> invoices tablosunun ne işe yaradığını koddan bul ve annotate_table ile kaydet
> DB'ye bağlanamıyorsun; modelleri koddan oku ve submit_schema ile gönder
```

## Panel (localhost)

`dbscope serve <proje>` komutu **http://localhost:4777** adresini açar. Claude Code oturumu başladığında panel kendiliğinden de başlar.

- **ER diyagramı:** Tablolar kolonlarıyla birlikte kart olarak gösterilir. İlişki çizgileri FK kolonundan hedef PK kolonuna gider. Kesikli çizgiler isimden çıkarılan ilişkilerdir. Tablolar modül bölgelerine ayrılmıştır.
  - Tekerlekle yakınlaştırılır, sürükleyerek kaydırılır.
  - Kartlar başlığından tutulup taşınabilir. Çift tıklayınca bütün kolonlar açılır.
  - Uzaklaşınca kartlar yalnızca tablo adını gösterir.
  - Sağ altta mini harita var, `/` ile tablo araması yapılır.
- **Prompt vurgusu:** Claude'a bir prompt gittiğinde gönderilen tablolar (camgöbeği), komşuları (mor) ve oturumda zaten bulunanlar (kesikli) vurgulanır. İlişki çizgilerinde akış animasyonu görünür. Sağ üstteki HUD panelinde token dökümü yer alır.
- **Genel:** Projenin amacı (düzenlenebilir), alan tahmini, token ekonomisi, modüller.
- **Canlı:** Prompt akışı ve prompt simülatörü (Claude'a gitmeden ne gönderileceğini gösterir).
- **Tablolar:** Rol filtreleri ve arama. Tablo detayında açıklama ve takma ad düzenlenir, tablonun Claude'a giden hali de burada görünür.
- **Tüketim:** Claude Code oturum kayıtlarından okunan gerçek token kullanımı. dbscope'lu ve dbscope'suz oturumlar karşılaştırılır.

## Desteklenen veritabanları

| Veritabanı | Bağlantı örneği |
|---|---|
| PostgreSQL (Supabase, Neon, RDS, Cockroach, Timescale) | `postgres://user:pass@host:5432/db` |
| MySQL / MariaDB / PlanetScale | `mysql://user:pass@host:3306/db` |
| SQL Server / Azure SQL | `sqlserver://user:pass@host:1433/db` veya ADO string |
| Oracle | `oracle://user:pass@host:1521/service` |
| SQLite | `./data/app.db` |
| Turso / libSQL | `libsql://…?authToken=…` |
| ClickHouse | `clickhouse://user:pass@host:8123/db` |
| MongoDB | `mongodb://…`, `mongodb+srv://…` |
| Firebase Firestore | service-account JSON, `firestore://<proje>` |
| DynamoDB | `dynamodb://eu-west-1`, `dynamodb://localhost:8000` |
| Cassandra / ScyllaDB | `cassandra://host:9042/keyspace` |
| Elasticsearch / OpenSearch | `elasticsearch://host:9200` |
| Neo4j | `bolt://user:pass@host:7687`, `neo4j+s://…` |
| Redis / Valkey | `redis://host:6379` |
| Prisma şeması, SQL dosyaları | `schema.prisma`, `schema.sql`, `migrations/` |
| **Bunların dışındaki her şey** | Claude kodu okur ve şemayı `submit_schema` ile gönderir, ya da `dbscope import schema.json` |

Bağlantı yerine JDBC URL de verilebilir (`jdbc:postgresql://…`, `jdbc:sqlserver://…;databaseName=…`, `jdbc:oracle:thin:@//…`).

## Desteklenen diller ve framework'ler

**Bağlantı ayarlarını okuduğu yerler**

| Ekosistem | Dosya |
|---|---|
| Node, PHP/Laravel/Symfony, Go, Python, Ruby… | `.env*` (`DATABASE_URL`, `DB_HOST`/`DB_DATABASE`/…, `MONGO_URI`, `REDIS_URL`…) |
| .NET | `appsettings*.json` → `ConnectionStrings` |
| Java / Kotlin (Spring) | `application*.properties`, `application*.yml` (`spring.datasource.*`, JDBC) |
| Python / Django | `settings.py` → `DATABASES` (`os.environ.get`, `env()`, `dj_database_url`) |
| Ruby on Rails | `config/database.yml` (ERB `ENV`, anchor'lar) |
| Elixir / Phoenix | `config/dev.exs` (Ecto Repo) |
| Node ORM'leri | `ormconfig.json` (TypeORM), `config/config.json` (Sequelize) |
| Docker | `docker-compose.yml` (postgres, mysql, mongo, redis, mssql, clickhouse, neo4j… servisleri ve port eşlemeleri) |
| Firebase | service-account JSON, `GOOGLE_APPLICATION_CREDENTIALS`, `.firebaserc` |

**DB'ye bağlanılamadığında şemayı çıkardığı model kodları**

EF Core (C#), JPA/Hibernate (Java, Kotlin), Django ORM, SQLAlchemy/SQLModel, Rails `schema.rb`, Laravel migrations, TypeORM, Sequelize, Mongoose, Drizzle, Prisma, GORM (Go), Ecto (Elixir).

## Bağlantı nasıl bulunur

1. `--db` parametresi ya da panelden seçilen kaynak (`.dbscope/config.json`)
2. Ortam değişkenleri ve `.env*` dosyaları
3. Framework ayarları (yukarıdaki tablo) ve `docker-compose`
4. Firebase anahtarları
5. SQLite dosyaları (test, e2e ve backup klasörlerindekiler en sona konur)
6. Prisma, SQL ve ORM model dosyaları (yalnızca hiçbir canlı DB'ye bağlanılamazsa)

Bütün adaylar denenir, bağlanılamayanlar atlanır. Aynı şemanın kopyaları (ör. e2e veritabanı) tek kaynak sayılır. Birden fazla farklı DB tek modelde birleştirilir. Tek kaynakla çalışmak istersen `.dbscope/config.json` dosyasına `{"multi": false}` ekle.

```bash
dbscope detect <proje>
```

Bu komut bulunan bütün adayları listeler.

## Token optimizasyonu

| Mekanizma | Ne yapar |
|---|---|
| **Seçici bağlam** | Sadece prompt'la eşleşen tablolar gönderilir. Bunlara bağlı tablolar yalnızca anahtar kolonlarıyla gider. |
| **Oturum hafızası** | Bir tablo bir oturumda bir kez gönderilir. Sonraki prompt'larda sadece "zaten bağlamda: …" satırı eklenir. `/clear` ve `/compact` sonrasında hafıza sıfırlanır. |
| **Kolon kırpma** | 16'dan fazla kolonu olan tablolarda PK, FK, enum kolonları ve prompt'ta geçen kolonlar gönderilir. Geri kalanlar `+N cols` olarak özetlenir (`describe_tables` ile istenebilir). |
| **Kısa notasyon** | Tipler kısaltılır (`str`, `int`, `ts`, `dec`…). Açıklama ve proje satırı oturum başına bir kez gönderilir. |
| **Bütçe** | Prompt başına bağlam ~1.400 tokenı geçerse en az ilgili tablolar yalnızca anahtar kolonlarına indirilir. |
| **İlgisiz prompt filtresi** | Sadece genel bir kelimeyle eşleşen prompt'lara ("sıralama **order**'ını çevir") bağlam eklenmez. |
| **Kısa araç tanımları** | MCP araç açıklamaları kısa tutulduğu için her oturumun sabit maliyeti düşüktür. |

Örnek: aynı konuyla ilgili ardışık prompt'larda ilk prompt ilgili tabloları getirir. Sonrakiler yalnızca yeni tabloları ekler, tablolar zaten bağlamdaysa sadece adlarını içeren tek bir satır gönderilir.

## Ölçüm: gerçekten tasarruf ediyor mu?

Panel ve hook'un gösterdiği tasarruf, **dbscope'un kendi bağlamını** naif bir bağlamla karşılaştırır. Claude'un toplam harcamasını ölçmek için iki yol var:

```bash
dbscope usage --dir <proje>
```
Claude Code oturum kayıtlarından prompt başına input/output token, tur sayısı ve Read/Grep sayısını okur. dbscope'lu ve dbscope'suz oturumları karşılaştırır. Aynı bilgi panelin **Tüketim** sekmesinde de var.

```bash
dbscope bench gorevler.txt --dir <proje>
```
Kesin A/B ölçümü. Dosyadaki her görevi `claude -p` ile bir kez dbscope'suz, bir kez dbscope'lu çalıştırır ve toplam token, maliyet ve tur sayısını karşılaştırır. **Senin Claude planından kullanım harcar.** Görev dosyasında her satır bir görevdir, boş satırlar atlanır.

## Senin girdiğin bilgiler nereye gider

| Panelde girilen | Etkisi |
|---|---|
| **Projenin amacı** | İlk cümlesi her oturumun ilk bağlamına eklenir, tamamı `get_overview` aracında görünür. Otomatik tahminin yerini alır. |
| **Tablo açıklaması** ("bu tablo ne işe yarar") | Tablo her gönderildiğinde yanına eklenir. Açıklamadaki kelimeler prompt'ta geçerse tablo eşleşir. |
| **Takma adlar** | Güçlü eşleşme sinyalidir: `receipts` tablosuna "fiş" takma adı eklenirse "fiş" yazınca bu tablo gelir. |
| **"Onayla ve öğret"** | Prompt'taki kelimeler ile tablolar arasındaki ilişki öğrenilir. |
| **Modül açıklaması** (Claude `save_project_summary` ile yazar) | O modülden bir tablo gönderildiğinde oturum başına bir kez eklenir. |

Claude da `annotate_table`, `save_project_summary` ve `confirm_tables` araçlarıyla aynı bilgileri yazabilir. Bunların hepsi `.dbscope/knowledge.json` dosyasında tutulur.

## CLI komutları

| Komut | Ne yapar |
|---|---|
| `dbscope [serve] [dir] [--db <bağlantı>] [--port 4777] [--no-open]` | Gerekirse analiz eder ve paneli açar |
| `dbscope analyze [dir] [--db <bağlantı>] [--no-samples]` | Şemayı yeniden analiz eder |
| `dbscope detect [dir]` | Bulunan veri kaynaklarını listeler |
| `dbscope context "<prompt>" [--dir d]` | Bu prompt için Claude'a gönderilecek bağlamı gösterir |
| `dbscope usage [--dir d]` | Claude Code oturumlarının gerçek token kullanımını gösterir |
| `dbscope bench <gorevler.txt> [--dir d] [--max-turns 12] [--model m]` | dbscope'lu ve dbscope'suz A/B ölçümü yapar |
| `dbscope import <schema.json> [--dir d]` | JSON şema içe aktarır |
| `dbscope install [dir]` · `dbscope install --global` | Claude Code entegrasyonunu kurar |
| `dbscope mcp` · `dbscope hook` | Claude Code tarafından çağrılır |

## MCP araçları

| Araç | Ne yapar |
|---|---|
| `get_overview` | Projenin amacı, modüller ve tablo adları |
| `relevant_tables` | Bir görev için ilgili tablolar |
| `describe_tables` | Tabloların tam tanımı (kırpılmamış) |
| `search_schema` | Tablo ve kolon adlarında arama (TR/EN) |
| `find_path` | İki tablo arasındaki join yolu (hub tablolardan kaçınır) |
| `annotate_table` | Tabloya açıklama ve takma ad kaydeder |
| `save_project_summary` | Projenin amacını ve modül açıklamalarını kaydeder |
| `confirm_tables` | Bir görevde kullanılan tabloları kaydeder (öğrenme) |
| `refresh_schema` | Şemayı yeniden analiz eder |
| `submit_schema` | Desteklenmeyen kaynaklar için şemayı doğrudan alır |
| `dashboard_url` | Panel adresi |

MCP araçları Claude Desktop, Cursor ve VS Code gibi diğer MCP istemcilerinde de çalışır. Prompt'a otomatik bağlam ekleyen hook ise Claude Code'a özeldir.

`submit_schema` ve `dbscope import` için JSON formatı:

```json
{ "dialect": "dynamodb", "database": "prod",
  "tables": [
    { "name": "users", "columns": [{ "name": "id", "type": "S", "pk": true }, "email"] },
    { "name": "orders", "columns": ["id", "userId", "status"],
      "fks": [{ "columns": ["userId"], "refTable": "users", "refColumns": ["id"] }] } ] }
```

## Güvenlik ve gizlilik

- **Analiz salt okunurdur.** Sadece katalog/şema sorguları, satır sayıları ve `status`/`type`/`role` gibi kolonlardan en fazla 8 farklı değer okunur. Bu değer toplamayı kapatmak için `--no-samples` kullan ya da `.dbscope/config.json` dosyasına `"samples": false` ekle.
- Veri satırları Claude'a gönderilmez.
- Panel yalnızca `127.0.0.1` adresini dinler.
- `.dbscope/` klasörü git dışında tutulur. Bu klasördeki `config.json` dosyası bağlantı adresi içerebilir.
- Otomatik tespit uzak bir sunucu (ör. production) bulursa oraya bağlanır. İstemiyorsan `--db` ile yerel/staging bir bağlantı ver veya panelden başka bir kaynak seç.

## Sorun giderme

| Sorun | Çözüm |
|---|---|
| `/mcp` listesinde dbscope yok | Claude Code'u proje klasöründe yeniden başlat ve onay istenirse onayla |
| `[dbscope]` bloğu eklenmiyor | `dbscope analyze` çalıştır, sonra `dbscope context "…"` ile test et. Prompt DB ile ilgisizse blok eklenmemesi normaldir. |
| "Hiçbir kaynağa bağlanılamadı" | Hata listesine bak. `dbscope detect` ile adayları gör, `--db` ile bağlantıyı açıkça ver. |
| `"…" paketi gerekli` | İlgili sürücüyü kur: `npm i pg` / `mysql2` / `mssql` / `oracledb` / `mongodb` / `firebase-admin` / `@aws-sdk/client-dynamodb` / `cassandra-driver` / `neo4j-driver` / `@libsql/client` / `redis` |
| Yanlış tablolar eşleşiyor | Panelden takma ad ekle ya da "Onayla ve öğret" ile doğru eşleşmeyi kaydet |
| Port 4777 dolu | Sıradaki boş port kullanılır, ya da `--port` ver |

## Proje yapısı

```
bin/dbscope.js          CLI
src/
  detect.js             kaynak tespiti (.env, appsettings, firebase, sqlite, prisma, sql)
  frameworks.js         Django, Rails, Spring/JDBC, Elixir, TypeORM/Sequelize, docker-compose
  connectors/           postgres · mysql · mssql · oracle · sqlite · libsql · clickhouse · mongo · firestore
                        dynamodb · cassandra · elasticsearch · neo4j · redis · prisma · sqlddl · code (ORM'ler)
  analyze.js            ilişki çıkarımı, tablo rolleri, modüller, amaç tahmini
  text.js               TR/EN normalize, kökleme, eşanlamlılar
  match.js              prompt → tablo eşleştirme, bağlam bütçesi, join yolu
  format.js             kompakt notasyon, kolon kırpma
  session.js            oturum hafızası (tekrar önleme)
  knowledge.js          açıklamalar, takma adlar, öğrenilen eşleşmeler
  engine.js             çoklu kaynak analizi, bağlam üretimi
  usage.js · bench.js   gerçek token ölçümü
  mcp.js · hook.js      Claude Code entegrasyonu
  server.js · install.js
web/                    panel (SVG ER motoru: er.js)
test/                   npm test
```

## Lisans

# Dbscope – Restricted Use License

Copyright (c) 2026 dbscope contributors. All rights reserved.

## 1. Grant of License

The copyright holder grants the recipient a limited, non-exclusive, non-transferable, non-sublicensable, revocable license to use the Software solely for personal, internal evaluation, or other explicitly authorized non-commercial purposes.

This license grants only the right to use the Software in its original form and does not transfer any ownership or intellectual property rights.

## 2. Restrictions

Without the prior written permission of the copyright holder, you may not:

- Use the Software for any commercial purpose, including selling, licensing, renting, or providing it as part of a paid service.
- Modify, adapt, translate, or create derivative works based on the Software.
- Incorporate the Software or any part of it into your own product, application, platform, or commercial offering.
- Redistribute, sublicense, publish, sell, or otherwise make the Software available to third parties.
- Remove or alter copyright notices, license terms, or proprietary notices.
- Use the Software to develop or offer a competing product or service.

## 3. Ownership

The Software and all associated intellectual property rights remain the exclusive property of the copyright holder. No rights are granted except those expressly stated in this license.

## 4. Termination

Any violation of this license automatically terminates the rights granted herein, subject to applicable law. Upon termination, you must cease all use of the Software and destroy any copies in your possession, to the extent legally required.

## 5. Disclaimer of Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT.

TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE COPYRIGHT HOLDER SHALL NOT BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM THE SOFTWARE OR ITS USE.

## 6. Additional Permissions

Any rights not expressly granted by this license are reserved by the copyright holder. Commercial use, modification, redistribution, integration into other products, or the creation of derivative works requires prior written authorization from the copyright holder.
