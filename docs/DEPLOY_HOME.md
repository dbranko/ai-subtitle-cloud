# Instalacija na kućni server (Debian + Docker + Nginx Proxy Manager)

Uputstvo za vlasnika. Rezultat: Stremio na Google TV-u koristi add-on preko
`https://<vaše-ime>/…`, a dashboard je dostupan iz kućne mreže. Node.js ni `npm` ne treba
instalirati — sve radi u Dockeru.

```
Google TV / PC  ──HTTPS──▶  Nginx Proxy Manager (80/443)  ──▶  server:7001  dashboard + API
                                                     └─/<token>──▶  server:7000  Stremio add-on
```

Portovi 7000 i 7001 se **ne prosljeđuju** na ruteru; spolja je vidljiv samo NPM, a njegova
pristupna lista (Access List) propušta samo kućnu mrežu. Sve adrese aplikacije su dodatno
zaštićene tokenom.

## Šta treba unaprijed

- Debian sa Dockerom i Docker Compose dodatkom 2.24.4 ili novijim (`docker compose version`).
- `git` (`sudo apt install git`), po želji `curl` za provjere.
- Nginx Proxy Manager koji radi i prima portove 80 i 443.
- Ime (DuckDNS ili drugo) koje pokazuje na vašu javnu IP adresu, sa portovima 80/443
  proslijeđenim na server — tada NPM sam dobija Let's Encrypt certifikat.

## 1. Preuzimanje koda

```bash
git clone --branch claude/intelligent-heisenberg-i96tw4 https://github.com/dbranko/ai-subtitle-cloud.git
cd ai-subtitle-cloud
```

Repozitorij je privatan: kad `git` traži lozinku, upišite GitHub korisničko ime i
**personal access token** (GitHub → Settings → Developer settings → Personal access tokens,
dovoljno je pravo čitanja ovog repozitorija), ne lozinku naloga.

## 2. Pokretanje

Kao običan korisnik koji smije koristiti Docker (ili sa `sudo`):

```bash
scripts/home-setup.sh sorabstremio.duckdns.org
```

(upišite svoje tačno ime). Skripta:

1. provjeri Docker;
2. napravi `.env` (dozvole 600), generiše pristupni token, upiše javnu adresu;
3. izgradi i pokrene aplikaciju (prvi put nekoliko minuta) i sačeka da sve bude spremno;
4. **ispiše tačne vrijednosti za Nginx Proxy Manager i adresu za Stremio.**

Ponovno pokretanje je bezbjedno: postojeći token i podešavanja se zadržavaju.

## 3. Nginx Proxy Manager

Unesite ono što je skripta ispisala. Ukratko:

**Access Lists → Add Access List**

- Name: `Home network`
- Access: `allow` → vaša kućna mreža (npr. `192.168.1.0/24`), zatim `deny` → `all`

**Hosts → Proxy Hosts → Add Proxy Host**

| Kartica          | Polje                        | Vrijednost                                     |
| ---------------- | ---------------------------- | ---------------------------------------------- |
| Details          | Domain Names                 | vaše ime, npr. `sorabstremio.duckdns.org`      |
|                  | Scheme / Forward Host / Port | `http` / IP adresa servera / `7001`            |
|                  | Block Common Exploits        | uključeno                                      |
|                  | Access List                  | `Home network`                                 |
| Custom locations | Define location              | `/<token>` (skripta ispisuje tačnu vrijednost) |
|                  | Scheme / Forward Host / Port | `http` / IP adresa servera / `7000`            |
| SSL              | SSL Certificate              | Request a new SSL Certificate                  |
|                  | Force SSL, HTTP/2            | uključeno                                      |
| Advanced         | Custom Nginx Configuration   | vidi ispod                                     |

```nginx
proxy_buffering off;
proxy_read_timeout 1h;
access_log off;
```

**Upišite samo te tri linije** — bez linija sa ` ``` ` iznad i ispod (to su oznake ovog
dokumenta, ne konfiguracija). Ako ih nginx dobije, ne pokreće se, a NPM-ova stranica na portu 81
prestaje da se otvara; popravka: `docker exec <npm-kontejner> sed -i '/```/d'
/data/nginx/proxy_host/<broj>.conf`, restart kontejnera, pa ispraviti polje u NPM-u.

Prve dvije linije su potrebne da napredak prevoda u dashboardu ide uživo; treća drži token
izvan NPM logova.

## 4. Provjera

```bash
scripts/home-check.sh
```

Očekivano: svi kontejneri „ready“, dashboard i add-on odgovaraju preko HTTPS-a, a add-on
bez tokena nije dostupan.

## 5. Stremio na Google TV-u

Add-ons → polje za pretragu → zalijepite adresu koju je skripta ispisala:

```
https://<vaše-ime>/<token>/manifest.json
```

Lakše je adresu poslati sebi na telefon i instalirati add-on sa Stremio aplikacije na
telefonu ili web.stremio.com istim nalogom — add-oni se sinhronizuju na TV.

Dashboard: otvorite jednom `https://<vaše-ime>/?token=<token>` u pregledniku na računaru ili
telefonu; token se zapamti, a adresa se očisti. Tamo u **Settings** upišite AI ključ
(npr. Anthropic) — ne treba restart.

## Održavanje

| Šta              | Komanda                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| Provjera         | `scripts/home-check.sh`                                                   |
| Backup           | `scripts/home-backup.sh` → `backups/` (zadnjih 10)                        |
| Vraćanje backupa | `scripts/home-restore.sh backups/asc-….tar.gz`                            |
| Nova verzija     | `scripts/home-update.sh` (prvo napravi backup)                            |
| Logovi           | `docker compose -f docker-compose.yml -f docker-compose.home.yml logs -f` |

- Backup sadrži bazu, prevode, `data/secret.key` (ključ kojim su šifrovani sačuvani API
  ključevi) i `.env`. Čuvajte ga privatno; bez `secret.key` sačuvani ključevi se ne mogu
  pročitati. Servisi se za backup zaustave na nekoliko sekundi.
- Automatski dnevni backup (u 4:15):
  `crontab -e` → `15 4 * * * cd /putanja/do/ai-subtitle-cloud && scripts/home-backup.sh >/dev/null 2>&1`
- Nakon restarta servera sve se samo pokreće (`restart: unless-stopped`), ako je Docker
  servis uključen: `sudo systemctl enable docker`.

## Novi token (ako je token procurio)

```bash
sed -i 's/^AUTH_TOKEN=.*/AUTH_TOKEN=/' .env
scripts/home-setup.sh <vaše-ime>
```

Zatim u NPM-u promijenite Custom location na novi `/<token>` i ponovo instalirajte add-on u
Stremiu (stara adresa prestaje da radi).

## Ako nešto ne radi

| Simptom                                        | Uzrok i rješenje                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Kod kuće adresa ne otvara ništa, a spolja radi | Ruter ne podržava „NAT loopback“ (hairpin). Rješenje: u ruteru/Pi-hole-u dodajte lokalni DNS zapis `ime → IP servera`. |
| NPM ne može dobiti certifikat                  | Ime ne pokazuje na javnu IP ili port 80 nije proslijeđen. Provjera: `getent hosts <ime>` i port forwarding na ruteru.  |
| `403 Forbidden` (stranica NPM-a)               | Uređaj nije u mreži iz Access Liste — provjerite opseg (`192.168.x.0/24`).                                             |
| `{"err":"unauthorized"}`                       | Adresa add-ona bez tačnog tokena — kopirajte je ponovo iz `scripts/home-setup.sh`.                                     |
| Napredak u dashboardu ne ide uživo             | Nedostaje `proxy_buffering off;` u Advanced.                                                                           |
| `host_not_allowed`                             | Ne bi trebalo da se desi sa tokenom; ako ste uklonili `AUTH_TOKEN`, dodajte ime u `ALLOWED_HOSTS`.                     |
