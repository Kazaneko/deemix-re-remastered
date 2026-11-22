# Modalità headless (server + interfaccia web)

Il backend di deemix gira in Node puro, senza Electron e senza finestra.
L'interfaccia, la stessa dell'app desktop, si apre dal browser su
`http://<ip-del-server>:6595`, protetta da password.

## Avvio con Docker

```bash
cp docker-compose.example.yml docker-compose.yml
echo 'DEEMIX_PASSWORD=una-password-lunga' > .env
chmod 600 .env
# in docker-compose.yml: sistema il percorso della musica e user: "uid:gid"
docker compose up -d
docker compose logs -f deemix
```

L'immagine è `ghcr.io/kazaneko/deemix-re-remastered:latest`. La CI la pubblica
da `main` e dai tag `v*`. Per costruirla in locale: `docker build -t deemix-headless .`

Senza Docker: `bun install && bun run build:headless`, poi
`DEEMIX_PASSWORD=... node dist-headless/server.js`.

## Variabili d'ambiente

| Variabile | Default | |
|---|---|---|
| `DEEMIX_PASSWORD` | obbligatoria | almeno 8 caratteri; se la cambi, tutti i browser vengono disconnessi |
| `DEEMIX_DATA_DIR` | `/data` | impostazioni, credenziali (file 0600), stato dei sync |
| `DEEMIX_MUSIC_DIR` | `/music` | cartella/e dei download, separate da `:`; i download non possono finire altrove |
| `DEEMIX_PORT` / `DEEMIX_HOST` | `6595` / `0.0.0.0` | |
| `DEEMIX_TRUST_PROXY` | spenta | `1` se c'è davanti un reverse proxy che imposta `X-Forwarded-*` |
| `DEEMIX_INSECURE_NO_AUTH` | spenta | `1` toglie la password: solo su reti di cui ti fidi completamente |

## Accesso da fuori casa

**Non aprire la porta sul router.** Chi raggiunge l'interfaccia può scaricare
con il tuo account Deezer, e la password è l'unica difesa. Da fuori casa passa
da una VPN (Tailscale, WireGuard) e apri `http://<ip-vpn-del-server>:6595`.

Se vuoi HTTPS, mettici davanti un reverse proxy (Caddy, Traefik) e imposta
`DEEMIX_TRUST_PROXY=1`: il cookie di sessione diventa `Secure` da solo.

## Differenze rispetto all'app desktop

- **Login Deezer**: con email e password, oppure incollando l'ARL. Il login
  tramite finestra del browser esiste solo sul desktop.
- **Scelta della cartella**: scrivi il percorso *sul server*, per esempio
  `/music/Album`. Viene accettato solo se esiste ed è dentro `DEEMIX_MUSIC_DIR`.
- **"Apri cartella"**: mostra il percorso sul server, perché da un browser non
  si può aprire il file manager di un'altra macchina.
- **Elimina**: sposta in `/music/.deemix-trash/` invece del cestino di sistema,
  quindi resta recuperabile. Svuotala a mano quando vuoi.
- **Credenziali**: in un container non c'è il portachiavi di sistema, quindi
  sono salvate offuscate (non cifrate) in `/data`, con permessi 0600. Proteggi
  quella cartella. I valori cifrati dall'app desktop col portachiavi non sono
  leggibili qui: vanno reinseriti.
- **Aggiornamenti**: niente auto-update; aggiorni l'immagine con
  `docker compose pull && docker compose up -d`.
- **Sync automatici**: all'avvio il server rifà il login Deezer con l'ARL
  salvato, quindi i sync programmati funzionano anche senza browser aperti.

## Come funziona

- `electron/headless/main.ts` avvia lo stesso `DeemixServer` dell'app desktop e
  gli collega un "front door" (`frontDoor.ts`). Il front door controlla la
  password (cookie firmato HMAC, `HttpOnly`, `SameSite=Strict`, tentativi falliti
  limitati per IP), serve l'interfaccia da `dist/` ed espone in `/headless/*` ciò
  che sul desktop passava per IPC: storage ed eventi (questi ultimi via SSE).
- `src/web/webBridge.ts` fa in modo che il frontend, nel browser, abbia lo
  stesso `window.electronAPI` che ha in Electron, ma via HTTP, e riscrive verso
  il server gli URL `http://127.0.0.1:<porta>` usati dagli store.
- Le chiamate dirette all'API pubblica di Deezer (`api.deezer.com`) passano dal
  server (`/headless/deezer-api/*`), perché Deezer non manda gli header CORS e
  un browser le bloccherebbe.
- Sul desktop non cambia niente: senza front door il server accetta ancora solo
  localhost.
