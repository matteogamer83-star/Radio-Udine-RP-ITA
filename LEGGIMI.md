# 📻 Radio Udine RP — la radio push-to-talk di Udine RP ITA

Una radio stile walkie-talkie (come Zello) per la community **Udine RP ITA**:

- **Tieni premuto e parla**: chi è nel canale ti sente **in diretta**, mentre parli
- **Solo chi ha un account** creato dal Founder o dallo Staff può entrare
- **Pannello Founder/Staff** 🛡️ per gestire utenti, canali (radio), password e ruoli
- **Ruoli personalizzati** (Comandante, Vice, Staff…) con permessi decisi **solo dal Founder**
- **Tasto PTT per Windows**: parli tenendo premuto un tasto **anche dentro al gioco**
- **🚨 SOS**: sirena, schermata rossa e **una voce che legge la posizione**; arriva anche alla Centrale
- Canale **🔁 Prova audio (eco)**: parli e ti risenti subito, così controlli microfono e casse da solo
- Cronologia con riascolto dei vocali, chat di testo, effetto radio, installabile come app sul telefono

---

## 1. Chi può fare cosa

| | Founder 👑 | Ruolo con permessi (es. Staff) | Utente normale |
|---|:-:|:-:|:-:|
| Parlare, ascoltare, chat, SOS | ✅ | ✅ | ✅ |
| Creare account, cambiare password, disattivare o eliminare utenti normali | ✅ | ✅ se ha «Gestire gli utenti» | ❌ |
| Aggiungere o togliere canali, cambiare le password dei canali (anche Staff) | ✅ | ✅ se ha «Gestire i canali» | ❌ |
| Entrare in tutti i canali senza password | ✅ | ✅ se ha «Accesso a tutti i canali» | ❌ |
| Creare ruoli e decidere i loro permessi | ✅ | ❌ | ❌ |
| Dare un ruolo con permessi (cioè creare Staff) | ✅ | ❌ | ❌ |
| Modificare lo Staff | ✅ | ❌ | ❌ |
| Impostazioni del server e backup | ✅ | ❌ | ❌ |

Il Founder è uno solo e si crea alla prima accensione con il **codice di installazione**.

## 2. Mettere la radio su Render (link https fisso)

### 2a. Prima di tutto: dove salvare gli account (gratis, una volta sola)

Su Render i file si cancellano ad ogni riavvio. Gli account vengono quindi salvati in un **Gist privato** sul tuo GitHub:

1. Su [github.com](https://github.com) clicca la tua foto → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. **Generate new token (classic)**. Note: `radio`. Expiration: **No expiration**. Spunta **solo** la casella **gist**. Poi **Generate token**
3. Copia il codice che inizia con `ghp_` (si vede una volta sola!)
4. Su [render.com](https://render.com) apri il servizio della radio → **Environment** → **Add Environment Variable**:
   - `GITHUB_TOKEN` = il codice copiato
   - `SETUP_CODE` = un numero che scegli tu, es. `482913` (serve per creare il Founder)
   - puoi **eliminare** `SERVER_PASSWORD`: non serve più, ora ci sono gli account
5. **Save Changes**

### 2b. Caricare la nuova versione

Nel tuo repository GitHub carica (trascinandoli in **Add file → Upload files**) tutti i file e le cartelle di questa cartella **tranne** `node_modules` e `data`. Render si aggiorna da solo in un paio di minuti.

### 2c. Creare il Founder

1. Apri il link della radio: compare **"Prima accensione"**
2. Scrivi il **codice di installazione** (quello di `SETUP_CODE`, oppure lo trovi su Render → **Logs**), il tuo nome utente, la password e il nome RP
3. Sei dentro come 👑 Founder. Premi 🛡️ per aprire il **pannello**

> In 🛡️ → **Server** vedi dove sono salvati i dati. Se c'è scritto **TEMPORANEO**, il `GITHUB_TOKEN` manca o è sbagliato.

## 3. Creare gli account per gli altri

🛡️ → **Utenti** → **➕ Nuovo utente** → nome utente, nome RP, sigla, ruolo → **Crea utente**.
Compare un riquadro con link, utente e password: premi **📋 Copia** e mandalo **in privato** alla persona.

Dal pannello puoi anche dare una nuova password 🔑, disattivare 🚫 (la persona viene buttata fuori subito) o eliminare 🗑️.

## 4. Canali e password

🛡️ → **Canali**: aggiungi, modifica, elimina e riordina (↑ ↓) i canali. Per ogni canale puoi scegliere:

- **🔒 Password** (vuota = canale libero)
- **👥 Chi può vederlo**: spunta i ruoli che possono entrare (nessuno spuntato = tutti)
- **🚨 Centrale**: riceve gli SOS di **tutti** i canali
- **🔁 Eco**: canale di prova audio

## 5. Ruoli personalizzati (solo Founder)

🛡️ → **Ruoli** → **➕ Nuovo ruolo**: nome (es. *Comandante*), icona, colore e permessi:

- **Gestire gli utenti**: creare account, nuove password, disattivare ed eliminare (solo utenti normali)
- **Gestire i canali**: aggiungere e togliere radio, cambiare password e accessi
- **Accesso a tutti i canali**: entra ovunque senza password

Un ruolo con almeno un permesso conta come **Staff**: solo il Founder può assegnarlo e solo il Founder può modificare chi lo ha.

## 6. Parlare anche dentro al gioco (Windows) 🎮

Il browser da solo sente i tasti solo quando la sua finestra è in primo piano. Per questo c'è il **tasto PTT per Windows**:

1. Nella radio: ⚙️ **Impostazioni** → **🎮 Tasto PTT anche in gioco** → **⬇️ Scarica**
2. Apri il file `Radio-Udine-RP-Tasto.bat` scaricato.
   - Se il browser avvisa che il file *"potrebbe essere pericoloso"*, scegli **Mantieni**
   - Se compare *"PC protetto da Windows"*, clicca **Ulteriori informazioni** → **Esegui comunque**
3. Nella finestra nera **premi il tasto** che vuoi usare. Consigliato: un **tasto laterale del mouse** o un tasto che il gioco non usa
4. Lascia aperte **la finestra nera** e **la radio nel browser** (anche ridotte a icona)
5. Entra in gioco e **tieni premuto quel tasto**: parli in radio. Nella finestra nera vedi `>>> IN ONDA` e quante persone ti ascoltano

Funziona come il push-to-talk di Discord. Se avvii il gioco "come amministratore", avvia anche il file del tasto come amministratore.
Il file contiene il tuo codice personale: **non condividerlo**. Per cambiare tasto riaprilo e scrivi `C`.

## 7. 🚨 SOS

Premi **🚨 SOS**, scrivi dove sei (es. *Piazza Libertà, vicino alla stazione*) e invia. Chi è nel tuo canale e nella **Centrale Operativa**:

- sente una **sirena** (anche se ha l'audio su muto)
- vede una **schermata rossa** con nome, ruolo e posizione
- sente **una voce che legge la posizione** due volte
- può premere **✅ Ricevuto, intervengo**: tu vedi e senti chi sta arrivando

## 8. Usare la radio sul PC del server (senza Render)

Doppio clic su **`avvia.bat`**: si apre la radio su `http://localhost:3000`. Alla prima accensione il **codice di installazione** è scritto nella finestra nera.
I dati sono salvati nella cartella `data` (non cancellarla). Per far entrare amici da fuori usa `condividi-online.bat` (vedi sotto) o Render.

**Link veloce dal tuo PC (gratis):** una volta sola scrivi in PowerShell `winget install --id Cloudflare.cloudflared`; poi, con la radio accesa, doppio clic su **`condividi-online.bat`** e manda il link `https://….trycloudflare.com` che compare. Cambia ogni volta che lo riapri.

## 9. Installarla come app sul telefono

- **Android (Chrome)**: ⚙️ Impostazioni → **📲 Installa**, oppure menu **⋮** → *Installa app*
- **iPhone (Safari)**: tasto **Condividi** → **Aggiungi alla schermata Home**

## 10. Problemi comuni

- **"Parlo ma non sento niente"**: è normale, **chi parla non sente sé stesso**; gli altri ti sentono in diretta. Per provarti da solo entra in **🔁 Prova audio (eco)**: parli, rilasci e ti risenti.
  Mentre parli il display ti dice quante persone ti stanno ascoltando.
- **Non sento gli altri**: controlla il tasto 🔊 (non 🔇) e il volume in ⚙️. Se compare la barra gialla *"Audio bloccato"* toccala. Sul telefono tieni la radio aperta in primo piano (*Schermo sempre acceso* è attivo di default).
- **Il pulsante dice "SOLO ASCOLTO"**: toccalo e segui le istruzioni (permesso del microfono o link non `https://`).
- **Il tasto PC non fa niente**: la radio nel browser deve essere aperta e con l'accesso fatto. In ⚙️ deve essere attivo *"Questo browser risponde al tasto PC"*. In alto deve comparire ⌨️.
- **Render ci mette tanto ad aprirsi**: nel piano gratis dopo 15 minuti senza nessuno si "addormenta"; il primo accesso può richiedere circa un minuto.
- **Ho perso la password del Founder**: un altro con «Gestire gli utenti» non può cambiarla. Ripristina un backup oppure cancella i dati (Gist o cartella `data`) e rifai la prima accensione.
- **Controllo automatico**: apri PowerShell in questa cartella e scrivi `npm test` (simula Founder, Staff e utenti e verifica 56 cose).
