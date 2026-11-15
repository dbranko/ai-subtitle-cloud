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
| 6    | Dashboard i obavijesti                          | **Završeno — čeka odobrenje**                      |
| 7    | Sigurnost, robusnost, testovi                   | Nije počelo                                        |
| 8    | Deploy i dokumentacija                          | Nije počelo                                        |

## Urađeno izvan plana, na zahtjev vlasnika

**Stremio prevodi samo kad se odabere u meniju titlova** — automatski režim je uklonjen:

- otvaranje videa ne pokreće ništa;
- u meniju titlova stoji `<jezik> · AI translate`; tek odabir te stavke pokreće prevod;
- dok prevod traje stavka glasi `<jezik> · AI 42%`; kad je gotov, zamjenjuje je pravi titl;
- `STREMIO_AUTO_TRANSLATE` više ne postoji (ako je ostao u `.env`, ignoriše se).

Čeka se: **provjera vlasnika u pravom Stremiu** (`docker compose up -d --build`).

**Formatting tagovi više ne obaraju segment** (poruka „answer rejected … formatting tags must
be copied exactly“):

- tagovi se porede bez obzira na velika/mala slova, navodnike i razmake;
- tagovi koji obuhvataju cijeli titl ili cijele redove (`<i>…</i>`, `{\an8}`) vraćaju se iz
  originala automatski, bez novog AI poziva;
- ako ni u zadnjem pokušaju AI ne prenese tagove usred rečenice, titl se zadržava bez tih
  tagova (uz upozorenje `markup_simplified`) umjesto da cijeli posao padne.

## Faza 6 — urađeno

- podešavanja u bazi, primjenjuju se bez restarta; API ključevi šifrovani (AES-256-GCM) i
  nikad se ne vraćaju pregledniku;
- API: podešavanja, aktivnost, poslovi sa filterom i stranicama, vremenska linija posla
  (`GET /api/v1/jobs/:id/events`);
- dashboard: Pregled · Historija · Podešavanja · Detalji posla (`#/jobs/<id>`);
- pregled: AI provajder/model/rezervni/ključ, forme za prevod, aktivni poslovi uživo,
  obavijesti, Stremio, nedavni (sa brojem neuspjelih), nedavna aktivnost;
- detalji: sve činjenice, živi napredak, otkaži/ponovi/preuzmi, vremenska linija;
- historija: filter (svi/završeni/neuspjeli/otkazani), stranice po 20, preuzimanje;
- podešavanja: AI, ključevi (samo upis), izvori, Stremio, podrazumijevano, keš + čišćenje;
- testovi: unit (vremenska linija, validacija podešavanja) i Playwright (tri posla, dva
  paralelno; podešavanja bez curenja ključa; historija; detalji).

## Sljedeće

- **Odobrenje faze 6**, pa faza 7 (sigurnost, robusnost, integracijski testovi).

## Otvorena pitanja / kasnije

- Serverski deploy (`docker-compose.server.yml` + `deploy/Caddyfile`) je commitan ali
  netestiran — pripada fazi 8; trenutno nema slobodnog Hetzner servera, koristi se
  cloudflared tunel.
