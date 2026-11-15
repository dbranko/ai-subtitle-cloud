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
| 6    | Dashboard i obavijesti                          | Završeno, odobreno                                 |
| 7    | Sigurnost, robusnost, testovi                   | Završeno, odobreno                                 |
| 8    | Deploy i dokumentacija                          | **U toku** — kućni server                          |

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

## Faza 7 — urađeno

**Integracijski testovi kroz pravi produkcijski put** (lažna je samo mreža):

- AI: pravi Claude/OpenAI/Gemini adapteri (zvanični SDK-ovi) sa lažnim HTTP-om u pravom
  formatu svakog provajdera — rate limit sa i bez `retry-after`, preopterećenje, odbijen
  ključ, svi provajderi pali pa ponovni pokušaj, odsječen odgovor, otkazivanje tokom pauze;
- film i epizoda × srpski latinica / srpski ćirilica / hrvatski kroz pravi OpenSubtitles
  adapter, worker, engine i keš; tajming upoređen titl po titl; drugi zahtjev iz keša;
- Playwright: oblici zahtjeva Stremio klijenata, pad workera i restart add-ona usred
  Stremio prevoda, zlonamjerne adrese, dashboard pod CSP-om, CSRF u pravom pregledniku;
- fuzz testovi: parser (3500 fajlova), API (600 tijela zahtjeva), add-on (1400 adresa).

**Pronađeno i popravljeno:**

1. Jedan odsječen ili prazan AI odgovor obarao je cijeli prevod → sada se ponavlja samo
   taj segment.
2. Add-on sa tokenom: neispravna `%` adresa ostavljala je zahtjev bez odgovora (neuhvaćen
   `URIError`) → sada 400.
3. API je upisivao `AUTH_TOKEN` u log (SSE `?token=`) → sada `[redacted]`.
4. Dashboard: neispravan link posla rušio je stranicu → sada „Job not found“.
5. Parser: broj sa više od 9 cifara uziman je kao indeks → sada je tekst.
6. Ranjive zavisnosti Stremio SDK-a (`path-to-regexp`, `tmp`) → zamijenjene ispravljenim.

**Nova zaštita:** bez `AUTH_TOKEN` servisi odgovaraju samo poznatim imenima hosta
(localhost, 127.0.0.1, javne adrese, `ALLOWED_HOSTS`); API odbija izmjene koje šalje druga
web stranica; sigurnosna zaglavlja i CSP. Pregled testova: `docs/TESTING.md`.

**Važno za postojeću instalaciju:** ako dashboard ili add-on otvarate preko nekog drugog
imena (npr. ime računara u mreži) **bez** `AUTH_TOKEN`, dodajte to ime u `ALLOWED_HOSTS`.
Tunel sa tokenom radi kao i prije.

## Faza 8 — u toku: kućni server

Debian + Docker + Nginx Proxy Manager, Stremio na Google TV-u, samo kućna mreža.
Uputstvo: `docs/DEPLOY_HOME.md`. Pripremljeno i testirano ovdje u Dockeru (nginx podešen kao
NPM): `scripts/home-setup.sh <ime>` sve pokrene i ispiše šta upisati u NPM i Stremio;
`home-check`, `home-backup`, `home-restore`, `home-update`.

## Sljedeće

- Vlasnik: pokrenuti na serveru, podesiti NPM, instalirati add-on na Google TV, javiti
  rezultat `scripts/home-check.sh`.
- Potvrditi tačno ime (`duckdns.org` ili `duckddns.org`).
- Ostatak faze 8: CI, provjera da nijedna tajna nije commitana, uputstvo za prenos.

## Otvorena pitanja / kasnije

- Serverski deploy (`docker-compose.server.yml` + `deploy/Caddyfile`) je commitan ali
  netestiran — pripada fazi 8; trenutno nema slobodnog Hetzner servera, koristi se
  cloudflared tunel.
