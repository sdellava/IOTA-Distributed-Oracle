# Stato delle richieste di sicurezza — v2.0.7

Aggiornato il 30 ottobre 2026. Questa tabella riguarda codice e verifiche locali
della release, non prova che un'installazione pubblica sia stata aggiornata.
Il report ricevuto non includeva richieste originali, revisione del server o
prove di transazioni governance non autorizzate.

| Richiesta del partner | Completezza nella release | Evidenza e limiti |
|---|---|---|
| Correggere SSRF STORAGE in prepare e schedule | Implementata e testata localmente | Controlli IPv4/IPv6, DNS vincolato alla connessione, verifica di ogni redirect, header di instradamento vietati, timeout e cancellazione body. Non è una prova del deployment pubblico. |
| Eliminare firma server pubblica `/api/tasks/execute` | Implementata e testata localmente | Endpoint, runner e wrapper rimossi; 404 anche con token. Preparazione Webview impedisce caricamento/generazione dell'identità client. |
| Proteggere prepare e gestione nodi dall'accesso anonimo | Implementata e testata localmente | Cinque endpoint di preparazione e POST network richiedono una sessione wallet. Anche varianti maiuscole/trailing slash applicano il controllo. Dashboard e GET pubbliche restano tali. |
| Verificare firma wallet e identità del richiedente | Implementata e testata localmente | Firma PersonalMessage, challenge monouso di 2 minuti, sessione di 15 minuti, vincoli su servizio/origine/wallet/rete, scadenza e revoca. Client non interattivo incluso. |
| Autorizzazione e proprietà delle risorse | Parziale | Sender e rete sono vincolati alla sessione; restano controlli di registro già presenti e autorizzazioni Move alla firma/invio. La release non aggiunge un controllo API completo di ogni ruolo e capability di task/governance. |
| Rate limiting e controllo consumo risorse | Implementato per autenticazione e preparazione; parziale sull'intero servizio | Quote IP e wallet, memoria limitata per sessioni/challenge, massimo quattro subprocessi effettivi. Limiti per processo; GET/RPC/SSE e deployment multireplica richiedono ulteriori controlli. |
| Allowlist e isolamento della rete in uscita | Parziale | Destinazioni interne e speciali bloccate nel trasporto del task. Nessuna allowlist di domini né firewall egress installato; restano attività/configurazioni operative. |
| Rimuovere/isolare chiavi private dalla Webview | Implementato nel codice e packaging; pulizia installazioni richiesta | Webview prepara senza chiavi e filtra l'ambiente dei figli; nuove immagini escludono file chiave e `.env` reale. Node manager devono eliminare impostazioni, mount e copie obsolete nelle proprie installazioni. Chiavi nodo e client autonomo preservate. |
| Ridurre informazioni in status, schedule ed errori | Parziale | Risposte di preparazione senza comandi, percorsi e output dei processi; errori child controllati. GET status/schedule restano pubbliche e non è stata completata una minimizzazione di tutte le risposte/errori. Dati on-chain già pubblici non diventano privati. |
| Audit storico richieste, transazioni, saldi e funding | Non eseguito | Richiede accesso ai log e all'identità effettivamente usata nel deployment. Nessuna conclusione di assenza di abuso. |
| Verifica del servizio pubblicato e pulizia immagini/container | Da eseguire dopo aggiornamento | Test HTTP locali e suite offline completati. Docker non disponibile qui; nessun deploy o invio on-chain effettuato. |

La release chiude nel codice il percorso SSRF esaminato e la firma pubblica
tramite execute, e aggiunge autenticazione delle operazioni. Non equivale alla
chiusura di tutte le raccomandazioni del partner né dimostra un precedente abuso
governance. Il rischio di abuso dei servizi pubblici consentiti, esaurimento
risorse e configurazioni operative scorrette resta da gestire come indicato.

Riferimenti: [protocollo API](WEBVIEW_API_AUTHENTICATION.md),
[release note e istruzioni per i node manager](release%20notes/RELEASE_NOTE_v2.0.7.md).
