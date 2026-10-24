# Reconocedor de escalas tonales

Aplicación web para estimar la tónica y el modo (mayor o menor) de una escala a partir de una grabación con el micrófono.

## Empezar

Abre la [aplicación web](http://darukeshi.github.io/Escala-tonal/) en un navegador moderno. Para usar el micrófono, permite el acceso cuando el navegador lo solicite.

### Ejecutar en tu computadora

Si prefieres ejecutarla localmente, sirve la carpeta del proyecto por HTTP; no abras `index.html` directamente, porque el navegador necesita un servidor para cargar el analizador de audio.

Con Python, ejecuta desde la carpeta del proyecto:

```bash
python -m http.server 8000
```

Después abre [http://localhost:8000](http://localhost:8000). Para detener el servidor, vuelve a la terminal y pulsa `Ctrl+C`.

## Analizar una escala

Usa el micrófono: pulsa **Iniciar grabación**, canta o toca una escala y pulsa **Detener y analizar**. La primera vez, permite el acceso al micrófono.

## Interpretar el resultado

El resultado incluye la tónica y el modo estimados, las notas de la escala y un porcentaje de confianza. También muestra las notas detectadas por segmentos, un histograma cromático y la forma de onda.

La confianza representa la proporción de energía cromática que coincide con la escala elegida; no es una garantía de que la detección sea correcta. El análisis puede variar según la afinación, el ruido de fondo, la calidad de la grabación y los instrumentos o sonidos mezclados.

## Consejos y solución de problemas

- Para usar el micrófono, abre la aplicación desde `localhost` o desde un sitio HTTPS y acepta el permiso del navegador.
- Graba una escala completa con notas claras y sostenidas, en un entorno silencioso. Mantén el micrófono cerca de la fuente de sonido sin saturarlo.

## Privacidad

El audio se procesa en el navegador y se utiliza para generar el resultado. La aplicación no lo sube a un servidor.
