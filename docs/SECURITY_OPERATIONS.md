# Limiti, destinazioni di rete e audit

Queste modifiche sono successive alla release pubblicata v2.0.7. Non implicano
un aggiornamento del servizio pubblico o un audit storico già eseguito.

## Autorizzazione delle operazioni

Per decisione di progetto, **Move resta il controllo definitivo** di ruoli,
proprietà e capability all'esecuzione. Le API autenticano il wallet e vincolano
sender e rete, ma preparano transazioni unsigned. Non viene aggiunto un secondo
sistema completo di autorizzazione delle risorse nelle API. La mancata
duplicazione è una scelta architetturale, non un intervento ancora da completare.
Questo non costituisce una nuova verifica di tutti i controlli Move.

## Limiti applicativi configurabili

I valori predefiniti operano anche senza Traefik e valgono per processo:

| Variabile | Default | Effetto |
|---|---:|---|
| WEBVIEW_READS_PER_MINUTE | 240 | Richieste GET/HEAD API per IP al minuto; health sintetica esclusa |
| WEBVIEW_READ_CONCURRENCY_PER_IP | 8 | Letture API contemporanee per IP |
| WEBVIEW_READ_CONCURRENCY | 64 | Letture API contemporanee globali |
| WEBVIEW_STREAMS_PER_IP | 4 | Connessioni SSE per IP |
| WEBVIEW_STREAMS | 64 | Connessioni SSE globali |
| WEBVIEW_STREAM_MAX_AGE_MS | 300000 | Durata massima SSE, poi EventSource può riconnettersi |
| WEBVIEW_UPSTREAM_TIMEOUT_MS | 15000 | Timeout di ogni richiesta upstream, compresa la lettura del body |
| WEBVIEW_UPSTREAM_CONCURRENCY | 32 | Richieste RPC/GraphQL/market/EULA contemporanee nel processo Webview |
| WEBVIEW_UPSTREAM_PER_MINUTE | 1200 | Richieste upstream nel processo Webview per minuto |
| WEBVIEW_UPSTREAM_MAX_BYTES | 10000000 | Massimo body upstream letto dal processo Webview |

Restano i limiti v2.0.7 per autenticazione e preparazione. I subprocessi del
client sono limitati separatamente a quattro con il loro timeout complessivo;
non condividono il contatore delle chiamate RPC del processo Webview.

Le letture in eccesso ricevono 429/Retry-After; la saturazione upstream restituisce
un errore controllato. Una disconnessione non libera lo slot di lettura mentre
il lavoro continua. Le SSE chiudono connessioni lente quando il buffer non
accetta altre scritture; il poll in corso conserva lo slot fino al completamento.
I timeout upstream abortiscono il trasporto e la lettura, non solo l'attesa HTTP.

NAT e proxy condividono le quote IP. Configurare soltanto proxy realmente fidati
in WEBVIEW_TRUSTED_PROXIES. In multireplica le quote locali non diventano limiti
di cluster: occorrono quote distribuite o una protezione equivalente sul proxy.
Le protezioni dell'applicazione non sostituiscono difese DDoS o limiti TCP del server.

## Allowlist tramite ambiente

Sì: si può impostare la policy applicativa negli ambienti di Webview e nodi:

```dotenv
TASK_HTTP_ALLOWED_HOSTS=storage.example.com,*.data.example.com
TASK_HTTP_ALLOWED_PORTS=80,443
TASK_HTTP_DENIED_HOSTS=management.example.com
```

- Lista vuota: rimangono consentite sorgenti HTTP/HTTPS pubbliche come prima.
- Nome esatto: autorizza soltanto quel nome, senza sottodomini impliciti.
- `*.data.example.com`: autorizza sottodomini, non `data.example.com` stesso.
- Ogni destinazione di redirect deve essere consentita; gli header vengono
  rimossi quando cambia origine. Non si autorizzano redirect HTTPS verso HTTP.
- Le restrizioni IP/DNS restano obbligatorie: una allowlist non può consentire
  localhost, metadati cloud o reti private.
- Le porte effettive includono i default 80/443 se non scritte nell'URL.
- La policy nell'ambiente della Webview prevale sulle impostazioni del client
  eseguito come subprocesso. Configurare anche l'ambiente dei nodi che scaricano
  effettivamente i task. Il client autonomo usa il proprio ambiente.

Queste variabili riguardano **le sorgenti HTTP dei task**. Non limitano gli
endpoint infrastrutturali configurati dall'operatore: RPC, GraphQL, IPFS, EULA e
provider richiedono una policy distinta. Un vero firewall egress del server o
container resta un controllo operativo separato; nessuna regola firewall è
installata automaticamente da queste variabili.

## Docker logs e audit

Docker raccoglie stdout/stderr: **basta come mezzo di raccolta solo dopo che
l'applicazione emette gli eventi di audit necessari**. I vecchi messaggi di
avvio e gli errori non erano un registro completo delle richieste.

Ora la Webview scrive un evento JSON per riga nel file di testo configurato e,
se richiesto, anche su stdout. Lo schema � `oracle.audit.v1` per richiesta API conclusa
o interrotta: timestamp, request ID, metodo, route normalizzata, stato, durata,
IP pseudonimizzato e, quando verificati, wallet/rete. Le richieste health non
vengono registrate per evitare rumore. La disconnessione è indicata con 499 e
non dimostra che il lavoro sia stato immediatamente cancellato.

Non vengono registrati token, firme, challenge, corpo delle richieste,
contenuto dei task, query string, ID dei task nei percorsi o output grezzo del
client. Gli errori del client vengono ridotti a codici controllati.

```dotenv
WEBVIEW_AUDIT_ENABLED=true
WEBVIEW_AUDIT_FILE=./logs/audit.log
WEBVIEW_AUDIT_MAX_FILE_MB=10
WEBVIEW_AUDIT_MAX_FILES=5
WEBVIEW_AUDIT_STDOUT=true
WEBVIEW_AUDIT_IP_SALT=
```

Il log è attivo di default. Per correlare gli stessi IP tra riavvii, impostare un
salt casuale stabile, custodito lato server; se vuoto viene generato per processo.
Questo salt non è una chiave wallet e non va pubblicato. I wallet registrati
sono identificativi pubblici ma il registro va comunque protetto dagli accessi.

La copia stdout ha inoltre la rotazione Docker `json-file`: 10 MB per file, cinque file
al massimo. È un limite di spazio, **non una garanzia di giorni di conservazione**.
Prima di ricreare container o cambiare il driver, esportare i log che si vogliono
conservare. Per conservazione duratura o resistente alle modifiche privilegiate,
inoltrare gli eventi a un collettore separato con accesso e retention definiti.

Analisi del file corrente:

```bash
node webview/scripts/audit-report.mjs webview/logs/audit.log
```

Per lo storico completo includere anche gli archivi ruotati. Nel deployment
Docker si pu� esportare la directory con `docker cp webview:/workspace/webview/logs ./audit-export`.
In alternativa, esportazione della copia stdout:

```bash
docker logs --timestamps --since 2026-10-30T00:00:00Z webview > webview-audit.log 2>&1
node webview/scripts/audit-report.mjs webview-audit.log
```

Il report locale conta eventi, stati, route, codici, wallet distinti e intervallo
osservato; accetta righe JSON, prefisso timestamp Docker e formato json-file.
Non interpreta assenza di eventi come assenza di abusi e non chiama servizi
esterni. Lo strumento può leggere vecchi file, ma non inventa eventi che non
erano stati emessi o che sono stati eliminati dalla rotazione.

## Cosa resta per l'audit storico

Servono i log conservati del vecchio container e del proxy, l'indirizzo del
vecchio wallet server e la sua cronologia on-chain. I log Docker da soli non
dimostrano richieste mai registrate, tentativi SSRF riusciti o assenza di spesa.
La cronologia on-chain è necessaria per valutare transazioni, gas e funding.
Nessuna indagine sulle installazioni esistenti è stata eseguita con questa patch.

La rimozione delle chiavi obsolete rimane un'attività dei node manager secondo
le release note: non eliminare chiavi nodo o client autonomo. Le istruzioni non
provano che le installazioni siano state pulite.

## Stato aggiornato rispetto ai punti discussi

| Punto | Stato di questa revisione locale |
|---|---|
| Autorizzazione risorse/ruoli nell'API | Non prevista: controllo definitivo in Move, come deciso; identità e rete restano verificate nell'API |
| Limiti sul servizio | Implementati per letture API, SSE e trasporto upstream, oltre ai limiti di autenticazione/preparazione v2.0.7; per processo |
| Allowlist tramite ambiente | Implementata e opzionale per le sorgenti HTTP dei task; configurazione dei domini a carico dell'operatore |
| Firewall egress | Attività infrastrutturale distinta, non installato da questa patch |
| Pulizia chiavi delle installazioni esistenti | Istruzioni di release; esecuzione a carico dei node manager |
| Registrazione audit su file con rotazione e riepilogo | Implementati per gli eventi emessi dopo aggiornamento; file persistente nel Compose |
| Audit storico effettivo | Da eseguire con log conservati, wallet e transazioni; i nuovi eventi non recuperano il passato |
| Deployment e verifica pubblica | Non eseguiti; v2.0.8 pubblicata come release del repository |

Verifica locale: 70 test superati (Webview 35, client 12, nodo 23), controlli
TypeScript e build passati. Smoke dell'handler SSE effettivo con RPC simulato:
durata massima rispettata, slot trattenuto dopo chiusura finché il poll termina,
successivo riutilizzo dello slot e audit senza query/ID task. Nessuna transazione
on-chain o chiamata a provider esterni usata per questi test. Docker non è
disponibile qui: rotazione e contenuti dell'immagine richiedono verifica sul server.
