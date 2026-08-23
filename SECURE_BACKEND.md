# Bezbedni API backend

## Status

Backend je lokalno pripremljen, ali još nije objavljen. Produkcijski Worker,
secrets i GitHub Pages izmena ne smeju biti objavljeni bez eksplicitne dozvole
vlasnika projekta.

- Frontend: `https://svadme-dot.github.io/resi-zadatak/`
- Worker name: `resi-zadatak-api`
- Planirani endpoint:
  `https://resi-zadatak-api.<account-subdomain>.workers.dev/v1/interactions`
- Lokalni restore tag: `backup-before-secure-api-backend`
- Restore tag pre opcione lokalne rezerve:
  `backup-before-local-api-fallback`
- Radna grana: `secure-api-backend`

Cloudflare kontrolna tabla je 23.08.2026. proverena u prijavljenom nalogu:
Workers plan je `Free`, cena je `$0`, status je `Active`, a Billing prikazuje
`No payment method on file`. Paid plan ostaje odvojeno dugme `Upgrade`; ono nije
otvarano niti aktivirano.

## Arhitektura

`GitHub Pages -> Cloudflare Worker -> Gemini Interactions API`

Worker koristi jedan SQLite Durable Object `RateCoordinator` kao globalni,
atomarni koordinator limita. Browser šalje samo sadržaj zadatka i neutralni broj
slota 1-4. Worker mapira slot na server-side secret, fiksira postojeći endpoint,
model, system prompt, `code_execution`, high thinking i streaming podešavanja,
pa tek nakon uspešne rezervacije šalje jedan upstream poziv.

Frontend zadržava postojeću retry/fallback state mašinu kako bi thinking,
parcijalni odgovor, Stop i `previous_interaction_id` nastavili da rade isto.
Redosled je uvek KEY1 -> KEY2 -> KEY3 -> KEY4; nema random ili round-robin
izbora. Browser nikada ne dobija vrednost server-side Worker ključa.

Kao neobavezna rezerva, Settings sada može lokalno da zapamti 1-4 zasebna API
ključa. Ova druga faza se ne koristi za normalne upstream greške, kvotu,
timeout, grešku ključa ili server-side rate limit. Aktivira se samo pre početka
odgovora kada frontend pouzdano utvrdi da Cloudflare gateway/deployment ili
njegov rate koordinator nisu dostupni, odnosno kada sva četiri Worker slota nisu
konfigurisana. Worker svaki svoj odgovor označava headerom `X-Math-Gateway: 1`,
pa obična AI greška iz zdravog gateway-a ne može neprimetno da zaobiđe server.

Gateway i lokalni interaction ID-jevi imaju odvojene identitete (`gateway:1`
naspram `local:1`). ID se šalje samo istom namespaced profilu: važeći lokalni ID
može nastaviti lokalni razgovor, dok se ID drugog transporta nikada ne šalje i
kontekst se tada bezbedno obnavlja iz lokalne istorije razgovora.

## Secrets

Dozvoljeni nazivi Worker secrets su:

- `GEMINI_API_KEY_1`
- `GEMINI_API_KEY_2`
- `GEMINI_API_KEY_3`
- `GEMINI_API_KEY_4`

Vrednosti se ne čuvaju u repozitorijumu. Nakon odobrenja produkcijskih izmena,
svaki secret se unosi interaktivno iz direktorijuma `worker`:

```powershell
npx wrangler secret put GEMINI_API_KEY_1
npx wrangler secret put GEMINI_API_KEY_2
npx wrangler secret put GEMINI_API_KEY_3
npx wrangler secret put GEMINI_API_KEY_4
```

Iste komande služe za kasniju zamenu ključeva. Ne prosleđivati vrednosti kroz
argument, URL, GitHub Actions log ili dokumentaciju.

## Deploy procedura

Ove komande su pripremljene, ali se ne izvršavaju bez eksplicitnog odobrenja:

```powershell
cd worker
npx wrangler whoami
npm test
npx wrangler deploy
```

Posle prvog Worker deploy-a treba uneti četiri secrets, proveriti `/health` i
mock/ograničeni produkcijski tok, upisati stvarni Worker URL u jedinu frontend
konstantu `API_GATEWAY_URL`, ponovo pokrenuti build i testove, pa tek onda
objaviti GitHub Pages izmenu.

## Free plan i limit poziva

Pre deploy-a u Cloudflare dashboard-u mora biti potvrđeno da nalog ostaje na
Workers Free planu i da nema koraka koji traži karticu, Payment Method, Upgrade,
Paid ili Subscription.

Ta provera je završena 23.08.2026: aktivan je `Workers Free`, `$0`, bez payment
method-a, billing adrese i plaćene Workers pretplate. Produkcijski deploy i dalje
čeka zasebnu eksplicitnu dozvolu vlasnika.

Trenutno dokumentovani relevantni Free limiti su:

- Worker: 100.000 ulaznih zahteva dnevno, 10 ms CPU po pozivu i 128 MB memorije;
- SQLite Durable Objects: 100.000 zahteva i 100.000 upisanih redova dnevno,
  uz 13.000 GB-s trajanja dnevno;
- prekoračenje Free kvote dovodi do odbijanja zahteva, ne do dokumentovane
  automatske naplate; ovo je zaključak iz odvojenog Paid plana i dokumentovanog
  fail ponašanja, ne ugovorna garancija o billing-u.

Svaki slot ima red od najviše 10 serverskih timestampova. Pri rezervaciji se
uklanjaju samo vrednosti strogo starije od `now - 60.000 ms`; timestamp tačno na
granici ostaje aktivan. Rezervacija se trajno upisuje pre svakog stvarnog
upstream pokušaja i nikada se ne vraća posle 429, 5xx, timeouta ili prekida.

Maksimalno 4 x 10 x 1.440 = 57.600 odobrenih upstream pokušaja dnevno, što je
ispod navedenih Free dnevnih kvota. Zlonamerni odbijeni zahtevi i dalje mogu
potrošiti dnevnu Worker/DO kvotu i privremeno učiniti javnu aplikaciju
nedostupnom.

Važan test pre produkcije: Free plan ima samo 10 ms CPU po Worker pozivu.
Worker zato prima najviše 3 MiB JSON-a i 2 MiB JPEG-a, a frontend normalnu sliku
prvo zadržava na postojećih 1800 px / quality 0,9 i samo ako je prevelika
adaptivno je svodi na najviše 1,5 MiB. I pored te rezerve, payload blizu gornje
granice mora biti izmeren kroz remote preview pre objave; veliki base64 JSON može
preći CPU limit i dobiti Cloudflare 1102.

### Ograničenje lokalne rezerve

Direktan browser poziv ne prolazi kroz Durable Object, pa serverski globalni
hard limit ne može obuhvatiti lokalne ključeve. Frontend zato pre svakog stvarnog
lokalnog pokušaja trajno rezerviše timestamp i konzervativno dozvoljava najviše
10 pokušaja u rolling 60 sekundi po fingerprintu ključa. Koristi Web Locks i
localStorage da smanji trke između tabova i isti ključ u dva slota deli isti
bucket. Rezervacija se ne vraća posle greške.

Ovo je samo best-effort zaštita jednog browser origin-a: korisnik može obrisati
storage, drugi uređaj nema isti brojač, a isti ključ korišćen i kroz Worker i
direktno nema zajednički zbir. Zato se za lokalnu rezervu ne tvrdi da ispunjava
globalni server-side hard cap. Ona se koristi samo kada gateway nije dostupan,
a za strogu garanciju treba je ostaviti praznu.

Postoji i neizbežna at-most-once neizvesnost: ako browser izgubi POST vezu pre
nego što dobije bilo kakav HTTP odgovor, ne može dokazati da li je Worker već
rezervisao i poslao upstream zahtev. Frontend tada proverava označeni `/health`;
ako je gateway dostupan, ne prelazi lokalno niti fan-outuje druge slotove. Ako su
i POST i health nedostupni, opcioni lokalni pokušaj može ipak uslediti, pa u
retkom prekidu tačno između prijema zahteva i odgovora mogu postojati dve
obračunate rezervacije. Bez upstream idempotency podrške to se ne može potpuno
ukloniti. Isto ograničenje važi za postojeći compatibility recovery: ako se
označeni stream tiho završi bez completion događaja i bez prikazanog sadržaja,
frontend može poslati jedan novi sync zahtev da povrati rezultat. Svaki takav
poziv se zasebno rezerviše i može predstavljati drugi obračunati upstream
pokušaj, čak i ako je prvi zahtev bio prihvaćen pre tihog prekida.

## Security zaštite

- samo `POST`/`OPTIONS` na `/v1/interactions` i neutralni `GET /health`;
- tačan JSON ugovor, najviše jedna JPEG slika, 3 MiB body i 2 MiB image limit;
- nema arbitrary URL-a, endpointa, modela, prompta ili alata iz browsera;
- CORS dozvoljava samo `https://svadme-dot.github.io`;
- secrets se dodaju samo u upstream header i ne ulaze u javni odgovor/log;
- upstream greške, metadata, SSE komentari i provider/model oznake se
  sanitizuju pre slanja browseru;
- limiter ili Durable Object greška radi fail-closed, bez nezaštićenog poziva;
- upstream redirecti se ne prate, a odgovor ima timeout i neutralne headere.

CORS nije autentikacija. Pošto je aplikacija javna i nema login, napadač može
imitirati dozvoljeni zahtev i iscrpeti besplatnu kvotu. Tačan globalni limit
štiti ključeve od više od 40 upstream poziva u bilo kojih 60 sekundi, ali ne može
garantovati dostupnost anonimnog javnog endpointa. Potpuna zaštita zahtevala bi
stvarnu autentikaciju, što bi promenilo traženo iskustvo „otvori link i koristi“.

Opcioni lokalni ključevi imaju drugačiji bezbednosni profil: vrednosti su u
localStorage-u, dostupne su kodu stranice, ekstenzijama i DevTools-u, a direktni
Network zahtev nužno prikazuje ključ, endpoint i interni model/config. Ključevi
se nikada ne uvoze automatski iz `api_keys.txt`, ne ulaze u build, chat, URL ili
Git i moraju biti ručno uneti samo ako vlasnik želi ovu rezervu. Za takav ključ
treba postaviti tačan GitHub Pages referrer i ograničiti ga samo na potreban API.
Naziv servisa ostaje vidljiv u normalnom UI-ju samo unutar ekrana za API ključeve;
DevTools ne može sakriti podatke direktnog browser zahteva.

## Rollback

Originalno stanje je sačuvano tagom `backup-before-secure-api-backend` na
commitu `6419629923ebbafe58d23e819fbbb0fe1070a9ed`.

Stanje sa bezbednim Worker backendom, ali pre opcione lokalne rezerve, sačuvano
je tagom `backup-before-local-api-fallback` na commitu
`0bd629d1e8bc0f01c37591e3e8a9ced48e42bf67`.

Za rollback samo lokalne rezerve, bez gubitka secure backend izmene:

```powershell
git status --short
git switch -c rollback-without-local-fallback backup-before-local-api-fallback
```

Za lokalni pregled stare verzije bez brisanja rada:

```powershell
git status --short
git switch --detach backup-before-secure-api-backend
```

Za nastavak rada na bezbednoj rollback grani:

```powershell
git switch -c rollback-to-pre-backend backup-before-secure-api-backend
```

Ne koristiti `reset --hard`, force-push niti brisati branch/tag. Ako je Worker
već objavljen, prvo vratiti Pages kod sa restore taga, a gašenje ili brisanje
Worker-a uraditi odvojeno tek uz eksplicitnu dozvolu.
