# 📻 Radio Udine RP — la radio push-to-talk di Udine RP ITA

Una radio stile walkie-talkie (come Zello) per la community **Udine RP ITA**:

- **Tieni premuto e parla**: tutti quelli nel canale ti sentono in tempo reale
- **Un solo utente alla volta** per canale, come una radio vera ("canale occupato")
- **Canali per reparto**: Generale, Centrale 112, Polizia, Carabinieri, GdF, Polizia Locale, 118, VVF, Soccorso Stradale, Staff (con password)
- **Cronologia**: gli ultimi vocali si possono riascoltare, più una chat di testo
- **🚨 SOS**: allerta con sirena a tutto il canale
- **Effetto radio** (fruscio e beep), **tasto della tastiera** per parlare dal PC
- Si **installa come app** sul telefono (Android e iPhone)

---

## 1. Accendere la radio (sul tuo PC)

1. Doppio clic su **`avvia.bat`**
2. Si apre una finestra nera (è il server: **non chiuderla**) e poi il browser su `http://localhost:3000`
3. Scrivi il tuo nome RP, scegli il reparto e premi **Accendi la radio**

> Dal PC dove gira il server, all'indirizzo `http://localhost:3000`, funziona tutto, microfono compreso.

## 2. Far entrare gli amici (serve un link **https**)

I browser attivano il microfono **solo su indirizzi `https://`**. Dal telefono, con l'indirizzo `http://192.168...`, si può solo ascoltare. Hai due strade:

### A) Link veloce e gratis (dal tuo PC), consigliato per iniziare

1. **Una volta sola**: apri PowerShell e scrivi `winget install --id Cloudflare.cloudflared`
2. Avvia la radio con **`avvia.bat`**
3. Doppio clic su **`condividi-online.bat`**: dopo qualche secondo compare un link tipo
   `https://parole-a-caso.trycloudflare.com`
4. Manda quel link agli amici su Discord. Fatto!

⚠️ Funziona finché il tuo PC è acceso con **entrambe** le finestre aperte. Il link **cambia ogni volta** che riapri `condividi-online.bat`.

### B) Link fisso, sempre acceso (Render.com, gratis)

1. Crea un account su [github.com](https://github.com) e carica questa cartella in un nuovo repository (senza `node_modules`)
2. Crea un account su [render.com](https://render.com) → **New +** → **Blueprint** → scegli il repository
3. Render legge `render.yaml` da solo. Se vuoi, imposta `SERVER_PASSWORD` (codice d'accesso), altrimenti lascialo vuoto
4. Dopo qualche minuto avrai un link fisso tipo `https://radio-udine-rp.onrender.com`

⚠️ Nel piano gratis il server "si addormenta" dopo 15 minuti senza nessuno collegato: il primo accesso può metterci circa un minuto.

## 3. Installarla come app sul telefono

- **Android (Chrome)**: apri il link → menu **⋮** → **Installa app** (o "Aggiungi a schermata Home")
- **iPhone (Safari)**: apri il link → tasto **Condividi** → **Aggiungi alla schermata Home**

## 4. Come si usa

| Cosa | Come |
|---|---|
| Parlare | **Tieni premuto** il pulsante rotondo, aspetta il beep, parla, rilascia |
| Parlare dal PC | Tieni premuto **Spazio** (si cambia nelle ⚙️ Impostazioni) |
| Cambiare canale | Menu **☰** (sul telefono) o lista a sinistra (sul PC) |
| Riascoltare un vocale | Tasto **▶** nella cronologia |
| Allerta | Tasto **🚨 SOS**: sirena per tutti nel canale |
| Modalità "premi una volta" | ⚙️ Impostazioni → Pulsante → *Premi 1 volta* |
| Provare il microfono | ⚙️ Impostazioni → **Prova microfono** (registra 3 secondi e te li fa risentire) |

## 5. Personalizzare (file `config.json`)

Aprilo con il Blocco note. **Dopo ogni modifica chiudi e riapri `avvia.bat`.**

- `nomeServer`: nome mostrato nell'app
- `passwordServer`: se lo compili, serve un codice per entrare (utile se il link è pubblico)
- `canali`: aggiungi, togli o rinomina i canali. `password` vuota significa canale aperto.
  **Cambia la password del canale Staff** (ora è `staff2026`)
- `reparti`: la lista che compare al login, con icona e colore
- `durataMassimaTrasmissione`: secondi massimi per ogni trasmissione (predefinito 60)
- `messaggiVocaliSalvati`: quanti vocali tenere per canale (0 = nessuno)

Attenzione a virgole e virgolette: se sbagli, il server all'avvio ti dice dov'è l'errore.

## 6. Da sapere

- È un'app web: sul telefono tienila **aperta e in primo piano**. L'opzione *Schermo sempre acceso* (attiva di default) evita che il telefono si blocchi.
- Il tasto della tastiera funziona solo quando **la finestra del browser è attiva**. Mentre giochi a schermo intero conviene usare **il telefono come radio**.
- Vocali e chat restano in memoria: si cancellano quando spegni il server.
- Per sicurezza, i vocali si possono riascoltare solo da chi è nel canale.

## 7. Problemi comuni

- **"La porta 3000 è già usata"**: la radio è già accesa in un'altra finestra, chiudila.
- **Il pulsante dice "SOLO ASCOLTO"**: toccalo e segui le istruzioni. Di solito manca il permesso del microfono (lucchetto 🔒 accanto all'indirizzo → Microfono → Consenti) oppure il link non è `https://`.
- **Non sento niente**: controlla il tasto 🔊 (non deve essere 🔇), il volume nelle impostazioni, e se compare la barra "Audio in pausa" toccala.
- **Controllo automatico**: apri PowerShell nella cartella e scrivi `npm test` (simula più radio e verifica che tutto funzioni).
