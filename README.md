# PVPC hoy y mañana

Web estática que muestra el precio PVPC de la luz en España hora a hora (hoy y, cuando se publica, mañana).

- Datos: REE (`apidatos.ree.es`, serie PVPC 1001), sin token. Se muestran en €/kWh.
- Sin dependencias ni build: `index.html` (interfaz), `pvpc.js` (lógica pura), `test.mjs` (pruebas).
- Probar la lógica: `node test.mjs`
- Ver en local (hace falta HTTP por los módulos ES): `python3 -m http.server 8000` y abrir `http://localhost:8000/`
- Publicar: GitHub Pages desde la raíz de la rama principal.
- Los precios de mañana aparecen sobre las 20:15; a partir de las 20:00 se reintenta cada 10 minutos.
