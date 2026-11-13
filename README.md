# PVPC hoy y mañana

Web estática con el precio PVPC de la luz en España hora a hora (hoy y, cuando se publica, mañana).

- Datos: REE (`apidatos.ree.es`, serie PVPC 1001), sin token, en €/kWh. Sin dependencias ni build.
- Archivos: `index.html` (interfaz), `pvpc.js` (lógica pura), `test.mjs` (`node test.mjs`).
- Local: `python3 -m http.server 8000` y abrir `http://localhost:8000/`. Publicar: GitHub Pages desde la raíz.
- Mañana: oficial sobre las 20:15; antes, estimación = spot de mañana + (PVPC − spot) de hace 7 días.
- Simulación de otro día: `?fecha=AAAA-MM-DD`.
- Subir `VERSION` en `pvpc.js` (se ve en el pie) en cada cambio publicado.
- Instalable en el móvil (iPhone/Android): `icon.svg` + `icon-*.png` + `manifest.webmanifest`; sin service worker (los datos son en vivo).
