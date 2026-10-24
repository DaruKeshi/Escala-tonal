/* ============================================================================
   app.js — HILO PRINCIPAL
   ----------------------------------------------------------------------------
   Responsabilidades (NADA de matemática pesada vive aquí, eso va al Worker):
     - Capturar audio con la Web Audio API: micrófono, archivo o síntesis.
     - Convertir el audio a PCM mono y enviarlo al Web Worker.
     - Recibir el resultado y pintarlo en pantalla.
   ============================================================================ */

/* ---------- Estado global ---------- */
let audioCtx = null;          // AudioContext compartido (Web Audio API)
let worker = null;            // Web Worker de análisis
let grabadora = null;         // MediaRecorder del micrófono
let grabando = false;
let analizando = false;

const refs = {};
["btnMic", "btnDetener", "btnPrueba", "selModo", "inputArchivo", "micEstado",
 "cardResultado", "nombreEscala", "confianza", "notasEscala", "notasDetectadas", "canvasHist",
 "canvasOnda", "tablaSegmentos", "log"].forEach((id) => (refs[id] = document.getElementById(id)));

/* ---------- Arranque ---------- */
document.addEventListener("DOMContentLoaded", () => {
  log("Sistema iniciado. Esperando una fuente de audio…");

  // El Worker se crea a partir del script; su ejecución es CONCURRENTE al hilo
  // principal de la página (aquí está el Web Worker del enunciado).
  worker = new Worker("js/audio-worker.js");

  worker.onmessage = (e) => {
    if (e.data.type === "resultado") mostrarResultado(e.data);
    if (e.data.type === "error") {
      log("❌ Error en el worker: " + e.data.mensaje, "err");
      finAnalisis();
    }
  };

  refs.btnMic.addEventListener("click", iniciarMicrofono);
  refs.btnDetener.addEventListener("click", detenerGrabacion);
  refs.btnPrueba.addEventListener("click", generarEscalaDePrueba);
  refs.inputArchivo.addEventListener("change", () => {
    const f = refs.inputArchivo.files[0];
    if (f) analizarBlob(f, "Archivo: " + f.name);
  });
});

/* ========================================================================== */
/* FUENTE 1: MICRÓFONO (Web Audio API + MediaRecorder)                        */
/* ========================================================================== */

async function iniciarMicrofono() {
  try {
    refs.micEstado.textContent = "Solicitando permiso de micrófono…";
    const flujo = await navigator.mediaDevices.getUserMedia({ audio: true });

    const opciones = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? { mimeType: "audio/webm;codecs=opus" } : {};
    grabadora = new MediaRecorder(flujo, opciones);
    grabadora.ondataavailable = (e) => chunksMic.push(e.data);
    grabadora.onstop = () => {
      grabando = false;
      refs.micEstado.textContent = "Grabación detenida. Analizando…";
      refs.micEstado.classList.remove("rec");
      analizarBlob(new Blob(chunksMic), "Grabación de micrófono");
      flujo.getTracks().forEach((t) => t.stop());
    };
    var chunksMic = []; // se llena mientras graba

    grabadora.start();
    grabando = true;
    refs.btnMic.disabled = true;
    refs.btnDetener.disabled = false;
    refs.micEstado.textContent = "🔴 Grabando… canta o interpreta la escala y detén.";
    refs.micEstado.classList.add("rec");
    log("🎤 Micrófono activo (" + grabadora.mimeType + ")");
  } catch (err) {
    refs.micEstado.textContent = "No se pudo acceder al micrófono.";
    log("❌ Micrófono: " + err.message, "err");
  }
}

function detenerGrabacion() {
  if (grabadora && grabando) {
    grabadora.stop();
    refs.btnMic.disabled = false;
    refs.btnDetener.disabled = true;
  }
}

/* ========================================================================== */
/* FUENTE 3: ESCALA SINTETIZADA DE PRUEBA                                     */
/* ========================================================================== */

/* Genere una escala completa (7 grados + repetición de la tónica), la graba
   con un MediaRecorder interno (MediaStreamDestination) y manda a analizar.
   Esto permite demostrar el sistema SIN micrófono. */
async function generarEscalaDePrueba() {
  if (analizando) return;
  iniciarAnalisis();

  const ac = ctx();
  const modoSel = refs.selModo.value;                    // aleatoria | mayor | menor
  const tonica = Math.floor(Math.random() * 12);         // tónica secreta 0..11
  const modo = modoSel === "aleatoria" ? (Math.random() < 0.5 ? "mayor" : "menor") : modoSel;

  const grados = modo === "mayor" ? [0, 2, 4, 5, 7, 9, 11, 12] : [0, 2, 3, 5, 7, 8, 10, 12];
  const dur = 0.45, sep = 0.15;

  // Destino invisible: el sintetizador SUENA en los parlantes Y se graba a la vez
  const dest = ac.createMediaStreamDestination();
  const grabadora = new MediaRecorder(dest.stream);

  const chunks = [];
  grabadora.ondataavailable = (e) => chunks.push(e.data);
  grabadora.onstop = async () => {
    log("🧪 Síntesis terminada; enviando al Web Worker…");
    analizarBlob(new Blob(chunks), "Escala sintetizada");
  };

  let t = ac.currentTime + 0.1;
  const inicio = t;
  grados.forEach((g, k) => {
    const osc = ac.createOscillator();
    const ganancia = ac.createGain();
    osc.type = "triangle";
    const midi = 60 + tonica + g;                        // Do central + tónica aleatoria
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);

    // Envolvente suave para evitar chasquidos
    ganancia.gain.setValueAtTime(0.0001, t);
    ganancia.gain.linearRampToValueAtTime(0.35, t + 0.03);
    ganancia.gain.setValueAtTime(0.35, t + dur - 0.05);
    ganancia.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc.connect(ganancia);
    ganancia.connect(ac.destination); // audible para el usuario
    ganancia.connect(dest);           // grabado para el análisis
    osc.start(t);
    osc.stop(t + dur);
    t += dur + sep;
  });

  const durTotal = t - inicio;
  grabadora.start(inicio);
  grabadora.stop(inicio + durTotal);

  log("🎹 Sintetizando escala " + modo + " (tónica oculta). Duración ≈ "
      + durTotal.toFixed(1) + " s. Escúchala y compara el resultado final.");
  refs.micEstado.textContent = "Escala de prueba sonando…";
}

/* ========================================================================== */
/* CONVERSIÓN A PCM MONO + ENVÍO AL WORKER                                     */
/* ========================================================================== */

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

async function analizarBlob(blob, etiqueta) {
  if (analizando) return;
  iniciarAnalisis();
  try {
    log("⏳ Decodificando audio (" + etiqueta + ")…");
    const buffer = await blob.arrayBuffer();
    const audio = await ctx().decodeAudioData(buffer); // Web Audio API: decodifica MP3/WAV/OGG/WEBM

    // Mezclar todos los canales a MONO (promedio)
    let pcm;
    if (audio.numberOfChannels === 1) {
      pcm = new Float32Array(audio.getChannelData(0));
    } else {
      const a = audio.getChannelData(0), b = audio.getChannelData(1);
      pcm = new Float32Array(audio.length);
      for (let i = 0; i < audio.length; i++) pcm[i] = (a[i] + b[i]) / 2;
    }

    log("✅ " + audio.duration.toFixed(1) + " s · " + audio.sampleRate
        + " Hz · " + audio.numberOfChannels + " canal(es) → " + pcm.length + " muestras");
    dibujarOnda(pcm);

    // TRANSFERENCIA CERO-COPIA: el buffer se transfiere al worker (transferable)
    // en lugar de copiarse; luego el worker lo procesa sin bloquear la UI.
    worker.postMessage({ type: "analizar", sampleRate: audio.sampleRate, pcm }, [pcm.buffer]);
  } catch (err) {
    log("❌ Al decodificar audio: " + err.message, "err");
    finAnalisis();
  }
}

/* ---------- Ciclo de vida de la UI durante el análisis ---------- */
function iniciarAnalisis() {
  analizando = true;
  refs.btnPrueba.disabled = true;
  refs.btnMic.disabled = true;
  refs.btnDetener.disabled = true;
  refs.cardResultado.hidden = true;
}

function finAnalisis() {
  analizando = false;
  refs.btnPrueba.disabled = false;
  refs.btnMic.disabled = false;
}

/* ========================================================================== */
/* RENDERIZADO DE RESULTADOS                                                  */
/* ========================================================================== */

function mostrarResultado(r) {
  finAnalisis();
  refs.cardResultado.hidden = false;

  refs.nombreEscala.textContent = "Escala: " + r.nombreEscala;
  refs.confianza.textContent =
    "Confianza: " + (r.confianza * 100).toFixed(1) + " % de la energía cromática dentro de la escala";

  refs.notasEscala.innerHTML = "";
  const etiqueta = document.createElement("span");
  etiqueta.className = "chip";
  etiqueta.style.borderColor = "var(--acento)";
  etiqueta.textContent = "Tónica: " + nombreNota(r.tonica);
  refs.notasEscala.appendChild(etiqueta);
  r.notasEscala.forEach((n) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.textContent = n;
    refs.notasEscala.appendChild(c);
  });

  // Secuencia real detectada por autocorrelación (nota por nota, en orden temporal)
  refs.notasDetectadas.innerHTML = "";
  if (r.segmentos.length) {
    r.segmentos.forEach((s) => {
      const c = document.createElement("span");
      c.className = "chip";
      c.style.borderColor = "var(--acento)";
      c.textContent = `${s.nota}${s.octava} · ${s.f0.toFixed(0)} Hz`;
      refs.notasDetectadas.appendChild(c);
    });
  } else {
    refs.notasDetectadas.innerHTML =
      '<span class="chip">No se detectaron notas sostenidas — graba más alto o más cerca del micrófono.</span>';
  }

  dibujarHistograma(r.histograma, r.tonica);
  dibujarTabla(r.segmentos);

  log("🎯 Resultado: " + r.nombreEscala + " · " + (r.confianza * 100).toFixed(1)
      + "% · " + r.framesTotal + " cuadros analizados en el worker", "ok");
}

function nombreNota(i) {
  return ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"][i];
}

/* Histograma cromático: una barra por clase de altura (12 semitonos) */
function dibujarHistograma(hist, tonica) {
  const cv = refs.canvasHist, ctx2 = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx2.clearRect(0, 0, W, H);
  const max = Math.max(...hist, 1e-6);
  const bw = W / 12;

  hist.forEach((v, i) => {
    const h = (v / max) * (H - 46);
    const x = i * bw + 6, y = H - 24 - h;
    ctx2.fillStyle = i === tonica ? "#7ee2a8" : "#6ea8fe";
    ctx2.fillRect(x, y, bw - 12, Math.max(h, 1));
    ctx2.fillStyle = "#9aa5c0";
    ctx2.font = "12px Segoe UI, sans-serif";
    ctx2.textAlign = "center";
    ctx2.fillText(nombreNota(i), x + (bw - 12) / 2, H - 8);
    if (v > max * 0.05) {
      ctx2.fillStyle = "#e7ecf7";
      ctx2.fillText((v * 100).toFixed(0), x + (bw - 12) / 2, y - 5);
    }
  });
  ctx2.fillStyle = "#9aa5c0";
  ctx2.textAlign = "left";
  ctx2.fillText("Tónica destacada en verde", 10, 16);
}

/* Forma de onda del audio analizado (mínimos/máximos por columna) */
function dibujarOnda(pcm) {
  const cv = refs.canvasOnda, ctx2 = cv.getContext("2d");
  const W = cv.width, H = cv.height, m = H / 2;
  ctx2.clearRect(0, 0, W, H);
  ctx2.strokeStyle = "#6ea8fe";
  ctx2.beginPath();
  const paso = pcm.length / W;
  for (let x = 0; x < W; x++) {
    let mn = 1, mx = -1;
    for (let i = Math.floor(x * paso); i < Math.floor((x + 1) * paso); i += 4) {
      const v = pcm[i] || 0;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    ctx2.moveTo(x, m - mn * (m - 4));
    ctx2.lineTo(x, m - mx * (m - 4) || m);
  }
  ctx2.stroke();
}

function dibujarTabla(segmentos) {
  const tb = refs.tablaSegmentos.tBodies[0];
  tb.innerHTML = "";
  if (!segmentos.length) {
    tb.innerHTML = '<tr><td colspan="5">No se detectaron notas sostenidas (sube el volumen o acércate al micrófono).</td></tr>';
    return;
  }
  for (const s of segmentos) {
    const tr = document.createElement("tr");
    [s.tiempo.toFixed(2) + " s", s.nota, s.octava, s.f0.toFixed(1), (s.cents > 0 ? "+" : "") + s.cents]
      .forEach((v) => {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      });
    tb.appendChild(tr);
  }
}

/* ---------- Registro ---------- */
function log(mensaje, clase) {
  const d = document.createElement("div");
  if (clase) d.className = clase;
  d.textContent = new Date().toLocaleTimeString() + "  " + mensaje;
  refs.log.prepend(d);
}
