# Pacchetto sito statico Netlify

Contenuto principale:
- `index.html`
- `styles.css`
- `script.js`
- `netlify.toml`
- `netlify/functions/rss-monitor.js`

## Monitoraggio RSS

La sezione "Segnali contrari da monitorare" non usa piu proxy pubblici come `rss2json`.
Il frontend chiama una Netlify Function locale:

```text
/.netlify/functions/rss-monitor?topic=egypt-somalia
```

La funzione:
1. scarica lato server i feed RSS configurati;
2. converte RSS/RDF/Atom in oggetti JSON;
3. filtra le notizie con le keyword della tematica selezionata;
4. deduplica per link/guid/titolo;
5. ordina per data decrescente;
6. restituisce le ultime 10 notizie.

## Tematiche supportate

- `egypt-somalia` - Accordi Egitto-Somalia
- `somaliland` - Dossier Somaliland
- `ethiopia-sea-access` - Accesso etiope al mare
- `egypt-economy` - Fragilita economica egiziana
- `gerd-opacity` - Opacita sui rilasci GERD

## Feed RSS usati

- BBC Africa
- BBC World
- Agenzia Nova
- ANSA English
- ANSAmed arabo
- Horn Observer
- International Crisis Group
- The New Humanitarian
- Africanews
- AllAfrica

## Deploy

Caricare l'intera cartella su Netlify. Netlify riconoscera automaticamente `netlify.toml` e pubblichera le funzioni dalla cartella `netlify/functions`.

Nota: gli asset immagine referenziati dall'HTML devono essere presenti nella cartella `assets/` con gli stessi nomi usati nel file HTML.
