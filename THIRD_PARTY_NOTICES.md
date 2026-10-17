# Third-party notices

## Mapika/decider

`server/systemone-adapter.ts` is a TypeScript port of parts of [Mapika/decider](https://github.com/Mapika/decider) (`decider/systemone.py` and `decider/prompt.py`), which is licensed under the Apache License, Version 2.0. The full license text is in [LICENSES/Apache-2.0-decider.txt](LICENSES/Apache-2.0-decider.txt). The port changes the original code: it is rewritten in TypeScript to translate Jev `/v1/systemone` requests for a plain GGUF runtime.

## npm dependencies

MuJoCo (`@mujoco/mujoco`, Apache-2.0), three.js (MIT) and the other packages in `package.json` are installed from npm under their own licenses and are not vendored in this repository.
