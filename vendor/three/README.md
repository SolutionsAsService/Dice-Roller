# Vendored three.js

- Source: npm package `three@0.186.1` (three.js r186), `npm pack three@0.186.1`.
- License: MIT, see `LICENSE` (copied from the package).
- `three.module.min.js` / `three.core.min.js`: the package's `build/three.module.js` and `build/three.core.js`,
  minified because r186 no longer ships `.min.js` files:

  ```sh
  npx terser@5 build/three.core.js --module --compress --mangle --comments '/@license/' -o three.core.min.js
  sed "s#from './three.core.js'#from './three.core.min.js'#" build/three.module.js > three.module.patched.js
  npx terser@5 three.module.patched.js --module --compress --mangle --comments '/@license/' -o three.module.min.js
  ```

- `addons/geometries/RoundedBoxGeometry.js`, `addons/environments/RoomEnvironment.js`: copied unmodified from
  `examples/jsm/`. They import `'three'`, which the import map in `index.html` points at `three.module.min.js`.
