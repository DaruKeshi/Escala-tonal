/* ============================================================================
   audio-worker.js — WEB WORKER de análisis musical
   ----------------------------------------------------------------------------
   Este archivo contiene TODO el procesamiento pesado y corre en un HILO
   aparte del navegador (concepto de Web Worker), por lo que la interfaz
   nunca se congela mientras se analiza el audio.

   Pipeline del algoritmo:
     1. FFT (Transformada Rápida de Fourier, radix-2)  -> contenido espectral
        y vector cromático (energía por clase de altura: Do, Do#, Re...).
     2. Autocorrelación normalizada (NSDF simplificada) -> altura tonal (f0)
        de cada cuadro, es decir, la nota realmente sonada en cada instante.
     3. Fusión de ambos -> histograma cromático ponderado.
     4. Búsqueda de tónica + modo (mayor/menor) probando las 12 rotaciones
        contra las plantillas de intervalos de cada escala.
   ============================================================================ */

/* Nombres de las doce clases de altura (nomenclatura en español) */
const NOTAS = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];

/* Plantillas de intervalos (en semitonos desde la tónica) */
const ESCALA_MAYOR = [0, 2, 4, 5, 7, 9, 11];        // T T ST T T T ST
const ESCALA_MENOR = [0, 2, 3, 5, 7, 8, 10];        // T ST T T ST T T

/* Parámetros de análisis */
const TAM_FFT    = 4096;  // ventana para el análisis espectral (FFT)
const SALTO      = 2048;  // hop entre ventanas consecutivas
const TAM_GRAVE  = 2048;  // ventana para la autocorrelación (más liviana)
const FACTOR_PITCH = 4;   // reduce el coste de autocorrelación sin afectar el rango de notas
const NOTA_MIN_HZ = 60;   // rango musical razonable para detectar f0
const NOTA_MAX_HZ = 1000;

/* ---------------------------------------------------------------------------
   RECEPCIÓN DE MENSAJES DESDE EL HILO PRINCIPAL
   --------------------------------------------------------------------------- */
self.onmessage = function (e) {
  const { type, pcm, sampleRate } = e.data;
  if (type !== "analizar") return;
  try {
    const r = analizar(pcm, sampleRate);
    self.postMessage({ type: "resultado", ...r });
  } catch (err) {
    self.postMessage({ type: "error", mensaje: err.message || String(err) });
  }
};

/* ---------------------------------------------------------------------------
   ANÁLISIS COMPLETO
   --------------------------------------------------------------------------- */
function analizar(pcm, sr) {
  if (pcm.length < TAM_FFT * 2) {
    throw new Error("El audio es demasiado corto (se necesitan ~2 cuadros de 4096 muestras).");
  }

  const pitchHist = new Float64Array(12);   // clases de altura detectadas por f0
  const chromaEsp = new Float64Array(12);   // energía espectral por clase
  const cuadrosConNota = [];                // cuadros con pitch detectado
  const fftRe = new Float32Array(TAM_FFT);
  const fftIm = new Float32Array(TAM_FFT);
  const magnitudes = new Float32Array(TAM_FFT / 2);
  let framesTotal = 0;

  /* Recorremos la señal con ventanas superpuestas */
  for (let i = 0; i + TAM_FFT <= pcm.length; i += SALTO) {
    framesTotal++;
    const cuadro = pcm.subarray(i, i + TAM_FFT);

    /* --- 1) ESPECTRO POR TRANSFORMADA DE FOURIER --- */
    analizarEspectro(cuadro, sr, chromaEsp, fftRe, fftIm, magnitudes);

    /* --- 2) ALTURA TONAL POR AUTOCORRELACIÓN --- */
    const sub = cuadro.subarray(0, TAM_GRAVE);
    const pitch = detectarPitch(sub, sr);
    if (pitch) {
      const midi = 69 + 12 * Math.log2(pitch.f0 / 440);
      const nota  = Math.round(midi);
      const clase = ((nota % 12) + 12) % 12;
      pitchHist[clase] += 1;
      cuadrosConNota.push({
        tiempo: i / sr,
        nota,
        clase,
        f0: pitch.f0,
        cents: (midi - nota) * 100,
      });
    }
  }

  if (framesTotal === 0) throw new Error("No se pudo segmentar el audio.");

  /* --- 3) FUSIÓN DE AMBAS FUENTES EN UN HISTOGRAMA CROMÁTICO --- */
  const hist = fusionarHistogramas(chromaEsp, pitchHist);

  /* --- 4) TÓNICA Y MODO --- */
  const { tonica, modo, puntaje } = buscarEscala(hist);
  const confianza = calcularConfianza(hist, tonica, modo === "mayor" ? ESCALA_MAYOR : ESCALA_MENOR);

  const plantilla = modo === "mayor" ? ESCALA_MAYOR : ESCALA_MENOR;
  const notasEscala = plantilla.map((g) => NOTAS[(tonica + g) % 12]);

  return {
    tonica,
    modo,
    nombreEscala: `${NOTAS[tonica]} ${modo === "mayor" ? "Mayor" : "menor"}`,
    notasEscala,
    confianza,
    puntaje,
    histograma: arrayASerie(hist),
    segmentos: agruparSegmentos(cuadrosConNota),
    framesTotal,
  };
}

/* ---------------------------------------------------------------------------
   TRANSFORMADA RÁPIDA DE FOURIER (radix-2 iterativa, in-place)
   re/im: Float32Array del mismo tamaño, potencia de dos.
   --------------------------------------------------------------------------- */
function fft(re, im) {
  const n = re.length;

  /* Reordenamiento bit-reversal */
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  /* Etapas mariposa (butterfly) */
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a  = i + k, b = i + k + len / 2;
        const uR = re[a], uI = im[a];
        const vR = re[b] * cRe - im[b] * cIm;
        const vI = re[b] * cIm + im[b] * cRe;
        re[a] = uR + vR; im[a] = uI + vI;
        re[b] = uR - vR; im[b] = uI - vI;
        const nR = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nR;
      }
    }
  }
}

/* ---------------------------------------------------------------------------
   ESPECTRO DE UN CUADRO -> APC (Análisis de clases de altura)
   Suma la energía de los picos del espectro a su clase cromática.
   --------------------------------------------------------------------------- */
function analizarEspectro(cuadro, sr, chromaEsp, re, im, mags) {
  const N = cuadro.length;

  /* Ventana de Hann (reduce el leakage espectral) */
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    re[i] = cuadro[i] * w;
  }
  im.fill(0);

  fft(re, im);

  /* Magnitudes para k = 0 .. N/2 */
  const M = Math.floor(N / 2);
  let maxMag = 0;
  for (let k = 3; k < M; k++) {
    mags[k] = Math.hypot(re[k], im[k]);
    if (mags[k] > maxMag) maxMag = mags[k];
  }
  if (maxMag <= 1e-9) return;

  /* Detección de picos: máximo local con energía significativa */
  const umbral = 0.12 * maxMag;
  for (let k = 4; k < M - 1; k++) {
    if (mags[k] > mags[k - 1] && mags[k] >= mags[k + 1] && mags[k] > umbral) {
      const frec = (k * sr) / N;
      if (frec < 30 || frec > 3500) continue;
      const midi = 69 + 12 * Math.log2(frec / 440);
      const clase = ((Math.round(midi) % 12) + 12) % 12;
      chromaEsp[clase] += mags[k]; // los armónicos refuerzan su clase
    }
  }
}

/* ---------------------------------------------------------------------------
   ALTURA TONAL POR AUTOCORRELACIÓN NORMALIZADA (estilo NSDF/McLeod)
   Devuelve { f0 } si encuentra un período claro, o null si el cuadro es
   silencio / ruido. La normalización evita el sesgo hacia retrasos (lags)
   pequeños y mitiga el error de octava.
   --------------------------------------------------------------------------- */
function detectarPitch(cuadro, sr) {
  const N = Math.floor(cuadro.length / FACTOR_PITCH);

  /* Promediar bloques reduce la frecuencia de muestreo para acelerar la correlación. */
  const x = new Float64Array(N);
  let rms = 0, media = 0;
  for (let i = 0; i < N; i++) {
    let muestra = 0;
    for (let j = 0; j < FACTOR_PITCH; j++) {
      muestra += cuadro[i * FACTOR_PITCH + j];
    }
    x[i] = muestra / FACTOR_PITCH;
    media += x[i];
    rms += x[i] * x[i];
  }
  rms = Math.sqrt(rms / N);
  if (rms < 0.004) return null;

  /* Eliminar componente DC */
  media /= N;
  for (let i = 0; i < N; i++) x[i] -= media;

  const srReducido = sr / FACTOR_PITCH;
  const lagMin = Math.max(2, Math.floor(srReducido / NOTA_MAX_HZ));
  const lagMax = Math.min(Math.floor(srReducido / NOTA_MIN_HZ), N - 2);

  /* Sumas acumuladas de energía para normalizar O(1) por lag */
  const pref = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) pref[i + 1] = pref[i] + x[i] * x[i];

  const nsdf = new Float64Array(lagMax + 2);
  let maxVal = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let corr = 0;
    const L = N - lag;
    for (let i = 0; i < L; i++) corr += x[i] * x[i + lag];
    const e1 = pref[L];
    const e2 = pref[N] - pref[lag];
    const norm = Math.sqrt(e1 * e2) || 1e-12;
    nsdf[lag] = corr / norm; // en [-1, 1]
    if (nsdf[lag] > maxVal) maxVal = nsdf[lag];
  }

  /* Señal demasiado inarmónica */
  if (maxVal < 0.35) return null;

  /* Primer pico local que supere el 85 % del máximo:
     se prefiere el período FUNDAMENTAL y no sus múltiplos (error de octava) */
  const umbral = 0.85 * maxVal;
  let bestLag = -1;
  for (let lag = lagMin + 1; lag < lagMax; lag++) {
    if (nsdf[lag] >= umbral && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] > nsdf[lag + 1]) {
      bestLag = lag;
      break;
    }
  }
  if (bestLag < 0) return null;

  /* Interpolación parabólica: precisión sub-muestra del período */
  const y0 = nsdf[bestLag - 1], y1 = nsdf[bestLag], y2 = nsdf[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = Math.abs(denom) > 1e-12 ? (0.5 * (y0 - y2)) / denom : 0;
  const lagFino = bestLag + Math.max(-0.5, Math.min(0.5, delta));

  const f0 = srReducido / lagFino;
  if (f0 < NOTA_MIN_HZ || f0 > NOTA_MAX_HZ) return null;
  return { f0 };
}

/* ---------------------------------------------------------------------------
   FUSIÓN: normaliza cada fuente y las promedia con igual peso
   --------------------------------------------------------------------------- */
function fusionarHistogramas(chromaEsp, pitchHist) {
  const out = new Float64Array(12);
  const nC = suma(chromaEsp), nP = suma(pitchHist);
  for (let i = 0; i < 12; i++) {
    const a = nC > 0 ? chromaEsp[i] / nC : 0;
    const b = nP > 0 ? pitchHist[i] / nP : 0;
    out[i] = 0.5 * a + 0.5 * b;
  }
  return out;
}

function suma(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }

/* ---------------------------------------------------------------------------
   BÚSQUEDA DE ESCALA: prueba las 12 tónicas × {mayor, menor} y premia la
   energía dentro de la plantilla, castigando levemente la externa.
   --------------------------------------------------------------------------- */
function buscarEscala(hist) {
  const plantillas = [
    { modo: "mayor", grados: ESCALA_MAYOR },
    { modo: "menor", grados: ESCALA_MENOR },
  ];
  let mejor = { tonica: 0, modo: null, puntaje: -Infinity };
  for (let t = 0; t < 12; t++) {
    for (const p of plantillas) {
      let s = 0;
      const dentro = new Set(p.grados.map((g) => (t + g) % 12));
      for (let i = 0; i < 12; i++) {
        s += hist[i] * (dentro.has(i) ? 1.0 : -0.35);
      }
      if (s > mejor.puntaje) mejor = { tonica: t, modo: p.modo, puntaje: s };
    }
  }
  return { tonica: mejor.tonica, modo: mejor.modo, puntaje: mejor.puntaje };
}

/* Fracción de la energía cromática que cae DENTRO de la escala detectada */
function calcularConfianza(hist, tonica, grados) {
  const dentro = new Set(grados.map((g) => (tonica + g) % 12));
  let total = 0, enEscala = 0;
  for (let i = 0; i < 12; i++) {
    total += hist[i];
    if (dentro.has(i)) enEscala += hist[i];
  }
  return total > 0 ? enEscala / total : 0;
}

/* Agrupa cuadros consecutivos con la MISMA nota en segmentos musicales */
function agruparSegmentos(cuadros) {
  const segmentos = [];
  let actual = null;
  for (const c of cuadros) {
    if (actual && c.nota === actual.nota) {
      actual.conteo++;
      actual.f0s.push(c.f0);
      actual.cents = (actual.cents * (actual.conteo - 1) + c.cents) / actual.conteo;
    } else {
      if (actual && actual.conteo >= 3) segmentos.push(actual);
      actual = { nota: c.nota, inicio: c.tiempo, conteo: 1, f0s: [c.f0], cents: c.cents };
    }
  }
  if (actual && actual.conteo >= 3) segmentos.push(actual);

  return segmentos.map((s) => {
    const f0 = s.f0s.reduce((a, b) => a + b, 0) / s.f0s.length;
    const octava = Math.floor(s.nota / 12) - 1;
    return { tiempo: +s.inicio.toFixed(2), nota: NOTAS[s.nota % 12], octava, f0: +f0.toFixed(1), cents: +s.cents.toFixed(0) };
  });
}

/* Float64Array -> array plano serializable */
function arrayASerie(a) {
  const out = [];
  for (let i = 0; i < a.length; i++) out.push(+a[i].toFixed(4));
  return out;
}
