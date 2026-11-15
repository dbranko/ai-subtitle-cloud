# Trenutni plan rada

Stanje na dan 2026-11-15. Grana: `claude/intelligent-heisenberg-i96tw4`.

## Gdje smo

| Faza | Sadržaj                                         | Stanje                                             |
| ---- | ----------------------------------------------- | -------------------------------------------------- |
| 0    | Specifikacija, arhitektura, roadmap             | Završeno, odobreno                                 |
| 1    | Monorepo, baza, health, Docker                  | Završeno, odobreno                                 |
| 2    | Prevodilački engine, AI provajderi              | Završeno, odobreno (živi test s OpenAI)            |
| 3    | Asinhroni job engine, napredak, SSE, obavijesti | Završeno, odobreno                                 |
| 4    | Izvori titlova (OpenSubtitles), keš             | Završeno, odobreno (živi test)                     |
| 5    | Stremio add-on                                  | Završeno, provjereno u Stremiu 6.0.7 (HTTPS tunel) |
| 6    | Dashboard i obavijesti                          | **U toku**                                         |
| 7    | Sigurnost, robusnost, testovi                   | Nije počelo                                        |
| 8    | Deploy i dokumentacija                          | Nije počelo                                        |

## Upravo urađeno (izvan plana, na zahtjev vlasnika)

**Stremio prevodi samo kad se odabere u meniju titlova** — automatski režim je uklonjen:

- otvaranje videa ne pokreće ništa;
- u meniju titlova stoji `<jezik> · AI translate`; tek odabir te stavke pokreće prevod;
- dok prevod traje stavka glasi `<jezik> · AI 42%`; kad je gotov, zamjenjuje je pravi titl;
- `STREMIO_AUTO_TRANSLATE` više ne postoji (ako je ostao u `.env`, ignoriše se).

Čeka se: **provjera vlasnika u pravom Stremiu** da samo otvaranje filma ne pokreće posao
(`docker compose up -d --build`).

## Faza 6 — šta je gotovo

Backend (commitano i pushano, svi testovi prolaze):

- podešavanja u bazi (`settings`), primjenjuju se bez restarta u workeru, API-ju i add-onu;
- API ključevi šifrovani AES-256-GCM, ključ u `<data>/secret.key` (0600); API nikad ne vraća
  ključ, samo „podešen / izvor / zadnja 4 znaka“;
- `GET/PUT /api/v1/settings`, `GET /api/v1/activity`, `GET /api/v1/jobs` sa filterom i
  stranicama (`scope`, `status`, `limit`, `offset`, `total`);
- indeks `job_events(jobId, id)` za vremensku liniju posla.

Već postojeće iz faze 3/5: živi napredak (SSE), obavijesti u pregledniku, ručni prevod
(upload SRT i po IMDb ID-u), Stremio kartica, preuzimanje SRT-a.

## Faza 6 — šta preostaje

1. **API**: `GET /api/v1/jobs/:id/events` — vremenska linija posla (promjene stanja, bez
   ponavljanja svakog segmenta).
2. **Navigacija u dashboardu**: Pregled · Historija · Podešavanja · Detalji posla
   (`#/jobs/<id>`); postojeći elementi i `data-testid` ostaju.
3. **Pregled (glavna strana)**: aktivni poslovi uživo, nedavno završeni, neuspjeli,
   trenutni AI provajder i model, nedavna aktivnost.
4. **Detalji posla**: sve činjenice o poslu (izvor, jezici, modeli, tokeni, trošak, vremena,
   greška), vremenska linija, otkaži / ponovi / preuzmi.
5. **Historija**: tabela s filterom (završeni / neuspjeli / otkazani), stranice, linkovi za
   preuzimanje i detalje.
6. **Podešavanja**:
   - AI: provajder, model, rezervni provajder i model, effort, temperatura, veličina
     segmenta, profil;
   - API ključevi (samo upis, prikaz „…zadnja 4“, brisanje);
   - izvori: jezici izvora, OpenSubtitles nalog;
   - keš: starost i veličina, dugme za čišćenje;
   - Stremio: jezici, dnevni limit, oznake jezika;
   - podrazumijevani ciljni jezik i uputstva za stil.
7. **Testovi**:
   - unit: vremenska linija, validacija podešavanja kroz API;
   - Playwright: više aktivnih poslova istovremeno, čuvanje podešavanja (i da ključ nikad
     ne stigne u preglednik), historija s filterom i stranicama, detalji posla;
   - postojeći testovi za SSE reconnect i refresh preglednika ostaju zeleni.
8. **Dokumentacija**: README, DEVELOPMENT_ROADMAP, ARCHITECTURE, API, SECURITY
   (šifrovanje ključeva), CHANGELOG.
9. `pnpm check` + `pnpm test:e2e`, commit, push, izvještaj — pa **stop i čekanje odobrenja
   za fazu 7**.

## Otvorena pitanja / kasnije

- Serverski deploy (`docker-compose.server.yml` + `deploy/Caddyfile`) je commitan ali
  netestiran — pripada fazi 8; trenutno nema slobodnog Hetzner servera, koristi se
  cloudflared tunel.
