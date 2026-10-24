# 🎼 Reconocedor de Escalas Tonales

Sistema web que analiza un sonido (micrófono, archivo o escala sintetizada) y
determina su **escala tonal**: la tónica y si es **mayor o menor**.
Todo el procesamiento pesado corre en un **Web Worker**.

## Estructura del proyecto

```
reconocedor-escalas/
├── index.html            → interfaz de usuario
├── css/styles.css        → estilos
└── js/
    ├── app.js            → hilo principal: Web Audio API (captura, síntesis, decodificación) y gráficos
    └── audio-worker.js   → WEB WORKER: FFT + autocorrelación + detección de escala
```

## Cómo funciona (resumen teórico)

1. **Web Audio API** — `getUserMedia`/`MediaRecorder`/`decodeAudioData`/osciladores
   capturan el sonido y lo convierten a PCM mono (`Float32Array`).
2. **Web Worker** — el PCM se transfiere al worker (`postMessage` con
   *transferable*, sin copia) para no congelar la interfaz.
3. **Transformada de Fourier (FFT radix-2)** — obtiene el espectro de cada
   cuadro de 4096 muestras (ventana de Hann) y construye un *vector cromático*:
   la energía de los picos (incluyendo armónicos) se acumula en su clase de
   altura (Do, Do#, Re…).
4. **Autocorrelación normalizada (estilo NSDF/McLeod)** — detecta la altura
   tonal f0 de cada cuadro buscando el primer pico ≥ 85 % del máximo e
   interpolando parabólicamente: así se evita el clásico error de octava y el
   sesgo hacia retrasos cortos.
5. **Detección de la escala** — se fusionan ambas fuentes en un histograma
   cromático y se prueban las **12 tónicas × {mayor, menor}** contra las
   plantillas de intervalos:
   - Mayor: `T T ST T T T ST` → semitonos `[0,2,4,5,7,9,11]`
   - Menor: `T ST T T ST T T` → semitonos `[0,2,3,5,7,8,10]`

   Gana la combinación con más energía dentro de la plantilla (las notas
   exteriores descontán). La **confianza** es el porcentaje de energía
   cromática que cae dentro de la escala elegida.

## Ejecutar en tu PC

Los Web Workers **no funcionan abriendo `index.html` con doble clic**
(`file://`), y el micrófono exige HTTPS o `localhost`. Sirve la carpeta con
cualquiera de estas opciones:

```bash
# Opción A: Node.js
npx serve reconocedor-escalas

# Opción B: Python
cd reconocedor-escalas
python -m http.server 8000
```

Abre `http://localhost:8000`.

## Cómo probarlo rápido (sin instrumento)

1. Pulsa **«Generar y analizar»** → el sistema compone una escala con tónica
   aleatoria (no revelada), suena por los parlantes, se autograbó y el worker
   debe acertar la escala.
2. Luego prueba **cantar una escala** con el micrófono (do–re–mi–fa–sol–la–si–do)
   o **subir un archivo WAV/MP3** de una escala de un piano.

## Alojar el proyecto (gratis, por archivo estáticos)

| Servicio | Pasos |
|---|---|
| **GitHub Pages** (recomendado para entrega) | 1. Crea un repositorio en GitHub. 2. Sube todo el contenido de la carpeta. 3. En **Settings → Pages**, elige rama `main` / carpeta `(root)`. 4. Tu URL será `https://TUUSUARIO.github.io/REPO/` |
| **Netlify Drop** | Entra a `app.netlify.com/drop` y arrastra la carpeta completa. URL instantánea con HTTPS. |
| **Vercel** | `npx vercel` dentro de la carpeta y sigue el asistente. |

Ninguno requiere servidor ni base de datos: el proyecto es 100 % estático.
