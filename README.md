# Jev Kune Do

Physically simulated robot fights in the browser, with Jev as every fighter's mind. (Codename and folder: split-decision; "Split Decision" is also the fight-night event mode.) MuJoCo (WASM) runs the physics in a Web Worker, three.js (WebGPU) renders, and Jev (TypeSafe AI) is each fighter's mind.

- `docs/PRD.md`: Demo 1 scope and success criteria
- `docs/CONCEPT.md`: research synthesis
- `docs/research/`: dossiers, fact-check, UniMate study

## Run

```bash
npm install
npm run dev   # http://localhost:5297
```

Jev calls go through the dev server's `/api/jev` proxy. The key is read from the macOS Keychain (`com.chrisdimarco.cabinet.api-keys` / `typesafe-jev`) or `TYPESAFE_API_KEY`, and never reaches the browser.

Keys: SPACE release the fighters · R reset · S slow motion
