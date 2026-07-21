# ScriptLab — Métricas, fórmulas y fuentes

Documento de consulta. ScriptLab procesa el texto localmente en el navegador. Las métricas marcadas como **heurísticas** o **calculadas** no son validaciones de rendimiento de YouTube.

## 1. Salud del guion (ICN)

**Tipo:** calculada con componentes heurísticos.

**Fórmula:**

```text
ICN = hs × 0.31 + cl × 0.22 + pa × 0.22 + pr × 0.17 + (CTA ? 8 : 0)
```

- **Hook (hs), peso 0.31:** longitud, pregunta, números, urgencia y alineación léxica con la promesa. Fuente: heurística interna.
- **Claridad (cl), peso 0.22:** índice de Fernández-Huerta. Fuente primaria: Fernández-Huerta (1959), adaptación española de Flesch.
- **Ritmo (pa), peso 0.22:** presencia de visuales/giros y variación de longitud de oraciones. Fuente: heurística interna; referencia direccional Cutting et al. (2016).
- **Promesa (pr), peso 0.17:** solapamiento léxico entre hook y promesa. Fuente: heurística interna.
- **CTA, +8 puntos:** presencia de un bloque CTA. Fuente: regla estructural interna.

El ICN no es una predicción validada de retención. Es un índice compuesto para orientar la revisión del guion.

## 2. Claridad: Fernández-Huerta

**Tipo:** fórmula publicada; su traducción a retención de video es inferencial.

```text
FH = 206.84 − 60 × (sílabas / palabra) − 1.02 × (palabras / frase)
```

**Peso dentro del ICN:** 0.22. **Peso dentro de Retención:** 0.07, como legibilidad.

**Fuente:** Fernández-Huerta (1959), “Medidas sencillas de lecturabilidad”, Consigna 214. La fórmula se conserva como escala de legibilidad; no se presenta como una relación causal con APV.

## 3. Retención estimada (APV)

**Tipo:** proyección calculada sobre reglas heurísticas; no es una predicción validada con datos propios.

```text
APV = clamp[15, 95](Σ scoreᵢ × weightᵢ)
```

En modo heurístico se usan ocho factores y sus pesos se normalizan por la suma de esos ocho pesos (0.89), porque el factor emocional requiere el resultado del modelo de sentimiento. Cada `scoreᵢ` está en una escala interna de 0 a 100.

| Factor | Peso declarado | Fórmula o señal | Fuente del peso / limitación |
|---|---:|---|---|
| Fuerza del hook | 0.25 | Longitud, pregunta, datos, urgencia y promesa | PrePublish (2026), Think with Google (2024), Backlinko; evidencia secundaria convergente |
| Ritmo | 0.17 | Duración media, CV de duración, bloques largos y variación de oraciones | Seidel (2024), Springer; apoyo secundario de PrePublish |
| Pattern interrupts | 0.14 | Proporción de bloques GIRO/VISUAL/CTA | Kahneman (1973), Sokolov (1963); evidencia cuantitativa secundaria declarada en el motor |
| Densidad de contenido | 0.11 | Cambios temáticos por minuto mediante solapamiento léxico | Miller (1956), Sweller (1988); la traducción a temas/min es inferencial |
| Entrega de promesa | 0.09 | Posición y solapamiento de la resolución con la promesa | RetentionRabbit (2025), PrePublish (2026); correlacional, no causal |
| Legibilidad | 0.07 | Fernández-Huerta y mapeo interno a 0–100 | Fernández-Huerta (1959); el vínculo con retención es inferencial |
| Posición del CTA | 0.03 | Existencia, posición, longitud y verbo de acción | ClixieAI (2025), Wistia; fuentes indirectas sobre conversión, no retención |
| Completitud narrativa | 0.03 | Hook, contexto, evidencia, CTA y opcionalmente giro/visual | Song et al. (2023), eNeuro; Booker (2004); peso bajo y heurístico |
| Arco emocional | 0.11 | Resultado de sentimiento por bloque | Berger, Levermann et al. (2026), Springer; Song et al. (2023), eNeuro. Requiere Modo IA y aún no se integra como factor del engine |

### Curva por bloque

La curva usa una forma baseline y otra para hook fuerte, interpoladas por posición relativa. Las formas son aproximaciones propias basadas en Wistia State of Video Report (2025) y RetentionRabbit (2025), no valores validados numéricamente.

Modificadores documentados:

- Pattern interrupt: `0.05 × 1/log2(n+1)`. El 0.05 es una escala conservadora inferida del spike de reenganche reportado por Wistia/Gopinath (2025); la habituación logarítmica se fundamenta en Sokolov (1963) y Rankin et al. (2009).
- Bloque mayor a 50 segundos: `−0.04`. Heurística interna no validada.
- Bloque mayor a 80 segundos: `−0.06` adicional. Heurística interna no validada.
- Hook fuerte en el primer bloque: `+0.05`. Heurística interna no validada.
- CTA: `+0.03`. Heurística interna no validada.
- Bloque vacío: `−0.15`. Heurística interna no validada.
- Riesgo de fuga: retención menor a `0.35`. Umbral orientativo basado en la forma de curvas publicadas; no es un corte clínico ni validado para este producto.

**Confianza:** `min(0.85, 0.3 + bloques_con_contenido × 0.05)`. Fórmula interna no validada; expresa cobertura del análisis, no probabilidad estadística.

## 4. Carga cognitiva

**Tipo:** heurística calculada.

Componentes:

1. **Ritmo de habla:** WPM configurado frente a 130 WPM, referencia Faculty eCommons (2025), “780-word rule”.
2. **Densidad informativa:** temas/min mediante solapamiento léxico menor a 15%; la relación con Miller (1956) y Sweller (1988) es inferencial.
3. **Carga de oración:** palabras promedio por oración; referencia teórica Sweller (1988).
4. **Puntos de descanso:** proporción de bloques VISUAL/GIRO; referencia de segmentación de Sweller (1988).

**Peso:** no participa como factor independiente del APV; se muestra como diagnóstico separado. Los cortes de nivel (`75`, `50`, `30`) son reglas internas y no una escala académica de carga cognitiva.

## 5. Arco emocional

**Tipo:** calculada con modelo IA; no es diagnóstico psicológico.

El modelo usado es `Xenova/robertuito-sentiment-analysis`. Los saltos tonales se calculan sobre el cambio absoluto de valencia:

| Banda | Umbral | Fuente |
|---|---:|---|
| Detección mínima | `≥ 0.25` | Traslación declarada de VADER |
| Bajo | `0.25–0.50` | Hutto & Gilbert (2014), VADER, ICWSM |
| Medio | `0.50–0.75` | Hutto & Gilbert (2014), escala trasladada |
| Alto | `≥ 0.75` | Hutto & Gilbert (2014), escala trasladada |

La escala original de VADER `−4..+4` se traslada a `−1..+1` dividiendo por 4. Esta traslación es explícita y lineal; la interpretación narrativa sigue siendo inferencial.

## 6. Análisis semántico IA

**Tipo:** calculado sobre embeddings; no validado como medición narrativa universal.

- **Alineación hook–promesa:** similitud coseno normalizada respecto del baseline pairwise del guion. La normalización es una decisión inferencial del producto.
- **Repetición:** similitud coseno entre bloques; umbral `0.85`. La separación de contrastes usa diferencia de valencia `≥ 0.50`. Son umbrales inferenciales documentados en el worker.
- **Ritmo de temas:** segmentos por minuto y cambios cuando la similitud de transiciones cae por debajo de `media − 1 desviación estándar`. Si hay contenido, se cuenta al menos un tema estimado para evitar mostrar un cero vacío. Es una regla adaptativa inferida, no una validación de comportamiento de audiencia.
- **Cobertura semántica:** comparación de bloques con centroides de ejemplos; umbral adaptativo `media − 1 desviación estándar`. Es una regla adaptativa inferida.

Modelo: `Xenova/multilingual-e5-small`, pipeline de extracción de características, prefijo `query: `, pooling mean y normalización L2.

## 7. Calibración con datos reales

**Tipo:** calculada sobre registros propios del usuario.

- Mínimo: `5` muestras por bucket formato × género.
- Cap de recalibración: `±8` puntos porcentuales.
- Nueva referencia: promedio del APV real del bucket, limitado por el cap.

**Fuente:** parámetros de diseño del sistema ScriptLab; no son una afirmación científica. La calibración solo representa los datos cargados por el usuario.

## Referencias

- Berger, J., Levermann, A. et al. (2026). Trabajo sobre narración y engagement. Springer.
- Booker, C. (2004). *The Seven Basic Plots*.
- Cutting et al. (2016). Referencia direccional sobre ritmo visual.
- Fernández-Huerta (1959). “Medidas sencillas de lecturabilidad”. Consigna 214.
- Hutto, C. J. & Gilbert, E. (2014). VADER. ICWSM.
- Kahneman, D. (1973). *Attention and Effort*.
- Miller, G. A. (1956). “The Magical Number Seven, Plus or Minus Two”.
- Rankin et al. (2009). “Habituation Revisited”. *Neurobiology of Learning and Memory*.
- Seidel (2024). “Short, Long, and Segmented Learning Videos”. Springer.
- Sokolov, E. N. (1963). Teoría de la habituación y respuesta orientadora.
- Song et al. (2023). Trabajo sobre dramatic arc y engagement. *eNeuro*.
- Sweller, J. (1988). Cognitive Load Theory.
- Wistia. *State of Video Report* (2025).
- PrePublish (2026), Think with Google (2024), Backlinko, RetentionRabbit (2025) y ClixieAI (2025): referencias secundarias declaradas en el contrato y el motor.
