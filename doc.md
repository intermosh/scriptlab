# Documentación Técnica y Flujo de Datos: ScriptLab AI

Este documento describe la arquitectura de software, el flujo de datos y las bases algorítmicas de **ScriptLab AI**, un entorno cliente-servidor de edición y análisis de guiones que opera bajo un paradigma de **privacidad absoluta y cómputo local (Zero-Backend)**. 

El sistema utiliza heurísticas lingüísticas tradicionales de legibilidad adaptadas al español y un modelo transformador en formato ONNX ejecutado a través de WebAssembly (WASM) directamente en el navegador del usuario.

---

## 1. Arquitectura del Sistema

La aplicación está diseñada como una **Progressive Web App (PWA)** dividida en tres capas funcionales que se ejecutan enteramente en el hilo principal (*Main Thread*), un hilo de soporte para tareas en segundo plano (*Web Worker*) y la capa de almacenamiento persistente del navegador (*IndexedDB* y *Cache API*).

```
┌────────────────────────────────────────────────────────────────────────┐
│                              Navegador                                 │
│                                                                        │
│  ┌─────────────────────────┐               ┌────────────────────────┐  │
│  │       MAIN THREAD       │  postMessage  │    AI WORKER THREAD    │  │
│  │   • UI / DOM Reactivo   ├──────────────►│ • Transformers.js v3   │  │
│  │   • Heurísticas Locales │               │ • ONNX Runtime WASM    │  │
│  │   • Fórmula ICN         │◄──────────────┤ • Inferencia Local     │  │
│  │   • Web Speech (TTS)    │  onmessage    │ • multilingual-e5-small│  │
│  └────────────┬────────────┘               └───────────┬────────────┘  │
│               │                                        │               │
│               ▼ Read / Write                           ▼ Cache Model   │
│  ┌─────────────────────────┐               ┌────────────────────────┐  │
│  │     INDEXEDDB (v2)      │               │       CACHE API        │  │
│  │  • projects • analysis  │               │  • Assets de la PWA    │  │
│  │  • calibrations         │               │  • Archivos ONNX (.bin)│  │
│  └─────────────────────────┘               └────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 División de Procesos (Concurrencia)
- **Hilo Principal (`app.js`, `diagnostics.js`)**: Gestiona la manipulación del DOM, el arrastre de bloques, la síntesis de voz (Web Speech API) y los cálculos matemáticos de baja latencia (legibilidad, análisis de estructura y calibraciones).
- **Hilo de IA (`ai-worker.js`)**: Web Worker dedicado que encapsula el entorno de ejecución de Machine Learning. Evita el bloqueo del hilo de renderizado (`app.js`) durante la inicialización de módulos WASM y las operaciones de álgebra lineal necesarias para las inferencias del modelo.

---

## 2. Flujo de Datos Detallado

El ciclo de vida de la información sigue un flujo unidireccional reactivo gatillado por eventos de entrada del usuario (*input de texto* o *reordenamiento de bloques*):

```
[Entrada de Usuario / Evento]
               │
               ▼
┌──────────────────────────────┐
│  app.js: save() (Debounce)   │
└──────────────┬───────────────┘
               ├─────────────────────────────────────────┐
               ▼ (Asíncrono)                             ▼ (Síncrono)
┌──────────────────────────────┐          ┌──────────────────────────────┐
│      put('projects', p)      │          │   computeAnalysis() [H.P.]   │
└──────────────────────────────┘          └──────────────┬───────────────┘
                                                         ▼
                                          ┌──────────────────────────────┐
                                          │   Actualización UI (Rápida)  │
                                          └──────────────┬───────────────┘
                                                         ▼
                                          ┌──────────────────────────────┐
                                          │  scheduleAI() (Hash Check)  │
                                          └──────────────┬───────────────┘
                                                         │
                                    ┌────────────────────┴────────────────────┐
                                    ▼ [Existe en Caché IDB]                   ▼ [Nueva Frase]
                             ┌──────────────┐                          ┌──────────────┐
                             │ Leer Caché   │                          │ postMessage()│
                             └──────┬───────┘                          └──────┬───────┘
                                    │                                         ▼
                                    │                                  ┌──────────────┐
                                    │                                  │   ai-worker  │
                                    │                                  └──────┬───────┘
                                    │                                         ▼
                                    │                                  ┌──────────────┐
                                    │                                  │ Guardar      │
                                    │                                  │ Caché IDB    │
                                    │                                  └──────┬───────┘
                                    ▼                                         ▼
                             ┌────────────────────────────────────────────────┐
                             │       renderMetrics() -> Redibujar UI          │
                             └────────────────────────────────────────────────┘
```

### Paso 1: Captura e Ingesta
Cualquier cambio en los campos críticos del guion (Título, Promesa o el contenido de los bloques del flujo) invoca a la función `save()`. Para mitigar la sobrecarga de escritura en la base de datos, este proceso está demorado mediante un mecanismo de *debounce* de **350 ms**.

### Paso 2: Evaluación Heurística (Síncrona)
Inmediatamente tras la edición, se invoca `computeAnalysis()`. Este componente calcula en milisegundos las métricas estructurales tradicionales (presencia de llamadas a la acción, ritmo visual y fórmula de legibilidad), ofreciendo retroalimentación visual instantánea en la interfaz.

### Paso 3: Despacho al Motor de IA (Asíncrono)
Si el usuario tiene activado el **Modo AI (Embeddings)**, se dispara `scheduleAI()`. 
1. Se estructura una lista con el título, la promesa y los contenidos de texto de todos los bloques del guion.
2. Se computa un hash único de este conjunto utilizando un algoritmo de dispersión polinomial rápido de 32 bits (`contentHash`):
   $$\text{Hash} = \sum_{i=0}^{n-1} \text{charCodeAt}(i) \cdot 16777619^{n-1-i} \pmod{2^{32}}$$
3. Se consulta el almacén `analysisCache` de IndexedDB con este hash como clave primaria.
   - **Caso de acierto (*Cache Hit*)**: Se recuperan los resultados calculados previamente y se actualiza la interfaz, evitando el costo computacional de realizar inferencias repetidas sobre el mismo texto.
   - **Caso de fallo (*Cache Miss*)**: Se envía un mensaje (`postMessage`) al Web Worker con el listado de textos para su procesamiento.

### Paso 4: Inferencia y Generación de Embeddings
El Web Worker recibe los textos, realiza la codificación mediante el transformador, obtiene los vectores de características y calcula sus relaciones. Posteriormente, devuelve los resultados (`alignment`, `titleAlignment`, `redundancy`) al hilo principal, el cual actualiza el DOM de forma asíncrona y almacena los resultados en `analysisCache`.

---

## 3. Arquitectura Técnica del Componente de IA

El procesamiento semántico local de la aplicación prescinde de llamadas a APIs externas mediante la integración de la librería `@huggingface/transformers` [1].

### 3.1 Especificación del Modelo de Lenguaje
El sistema carga por defecto el modelo **`Xenova/multilingual-e5-small`** [2].
- **Familia del Modelo**: E5 (Embeddings de Textos Multilingües Eficientes).
- **Parámetros**: ~118 millones.
- **Precisión**: Cuantizado en punto flotante de 32 bits (ejecutado por defecto en la plataforma mediante WebAssembly).
- **Dimensión del Vector de Salida**: 384 dimensiones.
- **Soporte de Idiomas**: Multilingüe (incluye optimización explícita para español).

### 3.2 Estrategia de Ejecución y Caching del Modelo
El modelo se inicializa con la directiva `{device: 'wasm'}` para asegurar compatibilidad universal en navegadores que carecen de soporte nativo para WebGPU o WebGL en Web Workers (como entornos empresariales o navegadores específicos basados en Chromium).

Para la descarga y conservación del archivo ONNX de pesos, se configura:
```javascript
env.useBrowserCache = true;
env.allowRemoteModels = true;
```
Esto delega el almacenamiento persistente de los binarios del modelo directamente a la API **Cache Storage** del navegador bajo el espacio gestionado por la biblioteca. Al desactivarse el modo de IA, no se limpian estos datos físicos a menos que el usuario purgue el almacenamiento del navegador, permitiendo un arranque instantáneo en visitas posteriores sin necesidad de red.

### 3.3 Operaciones de Álgebra Lineal en el Worker
El pipeline de extracción de características se configura con pooling promedio y normalización vectorial de manera nativa:
```javascript
const out = await extractor(texts, { pooling: 'mean', normalize: true });
```
Dado que los vectores de salida están normalizados ($\|a\|_2 = 1, \|b\|_2 = 1$), el cálculo de la **Similitud Coseno** se reduce matemáticamente al producto punto entre ambos vectores. La función interna `dot(a, b)` realiza esta operación:
$$\text{Similitud Coseno}(a, b) = a \cdot b = \sum_{i=1}^{n} a_i b_i$$

```javascript
const dot = (a, b) => a && b ? a.reduce((s, x, i) => s + x * b[i], 0) : 0;
```

El worker calcula tres métricas clave:
1. **`alignment` (Alineación Hook-Promesa)**: Similitud semántica entre el gancho inicial del video (`HOOK`) y la propuesta de valor (`Promesa`). Un valor cercano a $1.0$ indica que el gancho aborda directamente la promesa declarada.
2. **`titleAlignment` (Alineación Hook-Título)**: Similitud entre el bloque `HOOK` y el título general del archivo.
3. **`redundancy` (Redundancia Secuencial)**: Se define como el valor máximo de similitud consecutiva entre bloques del guion:
   $$\text{redundancy} = \max \left( \{ \text{dot}(\text{block}_{i-1}, \text{block}_i) \mid 1 < i \le N \} \right)$$
   Un valor de redundancia excesivamente elevado advierte sobre el riesgo de que el guion repita ideas similares de manera consecutiva.

*Nota de precisión técnica*: En la implementación actual expuesta en `ai-worker.js`, el atributo `confidence` se retorna como un valor constante de valor flotante estático `0.72`. No responde a una función probabilística dinámica de la inferencia, sino a un valor estático de diseño del worker.

---

## 4. Algoritmos Heurísticos y Lingüísticos

Para asegurar un análisis dinámico instantáneo sin costo energético asociado al uso de la CPU para inferencias constantes, ScriptLab AI implementa heurísticas deterministas en el hilo principal.

### 4.1 Extractor de Sílabas en Español
Para determinar la densidad lingüística sin requerir diccionarios masivos en memoria, la función `syllables` utiliza un estimador iterativo simplificado de transiciones vocálicas:

```javascript
const syllables = w => {
  w = (w || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zñü]/g, '');
  let n = 0, last = false;
  for (const c of w) {
    const v = 'aeiouü'.includes(c);
    if (v && !last) n++;
    last = v;
  }
  return Math.max(1, n);
};
```
- **Lógica**: Se remueven diacríticos y tildes mediante la normalización canónica de descomposición (`NFD`). El algoritmo suma una sílaba cada vez que encuentra un carácter vocálico, siempre y cuando el carácter anterior no haya sido también una vocal.
- **Precisión**: Actúa como un aproximador eficaz para el conteo silábico general en español, ya que reduce los diptongos y triptongos a un solo núcleo silábico en la mayoría de los casos usuales, aunque carece de reglas complejas para hiatos fonológicos específicos.

### 4.2 Índice de Legibilidad Fernández-Huerta
Utiliza la adaptación validada para el idioma español [3] de la fórmula de Flesch Reading Ease:

$$\text{I.F.H.} = 206.84 - 60 \left( \frac{\text{Sílabas}}{\text{Palabras}} \right) - 1.02 \left( \frac{\text{Palabras}}{\text{Frases}} \right)$$

Esta ecuación está implementada en `fernandezHuerta()` y acota el resultado en un intervalo $[0, 100]$:
- Valores próximos a $100$ indican un texto extremadamente sencillo de asimilar en la locución (oraciones cortas, palabras de pocas sílabas).
- Valores por debajo de $40$ indican alta complejidad conceptual o sintaxis densa.

### 4.3 Puntuación de Calidad Narrativa (ICN)
El **Índice de Calidad Narrativa (ICN)** unifica las métricas semánticas y heurísticas mediante un promedio ponderado estructurado en `computeAnalysis()`:

```javascript
score = Math.round(hs * 0.31 + cl * 0.22 + pa * 0.22 + pr * 0.17 + (tiene_CTA ? 8 : 0))
```

#### Componentes de la Fórmula:
- **`hs` (Hook Score - Peso 31%)**: Mide la efectividad del Hook. Base de $40$ puntos; suma $28$ puntos si su extensión está optimizada (entre $24$ y $86$ palabras) y otros $20$ puntos si existe un solapamiento léxico directo con la promesa. Penaliza con $-8$ si no existe solapamiento.
- **`cl` (Claridad - Peso 22%)**: Basado en el Índice Fernández-Huerta ($82\%$), penalizado si la longitud media de las oraciones excede las $18$ palabras de manera acumulada.
- **`pa` (Ritmo/Pacing - Peso 22%)**: Mide la densidad de elementos dinámicos. Parte de una base de $40$ puntos e incrementa $15$ puntos adicionales por cada bloque de tipo `GIRO` o `VISUAL` introducido en el flujo.
- **`pr` (Alineación Heurística - Peso 17%)**: Puntuación de $82$ si existe coincidencia de palabras clave (de longitud $\ge 4$ caracteres) entre el Hook y la Promesa, o $30$ en su defecto.
- **Bono por CTA**: Suma directa de $8$ puntos al total si el guion cuenta con al menos un bloque estructurado de llamado a la acción (`CTA`).

---

## 5. Algoritmo de Calibración con Datos Reales (APV/YouTube Studio)

Para mitigar el carácter teórico de las fórmulas de legibilidad, la aplicación incluye un sistema de calibración empírica basado en datos de rendimiento reales obtenidos de la plataforma de destino (YouTube Studio).

El usuario puede cargar registros históricos en el almacén de IndexedDB `calibrations` (especificando formato, género y la retención real obtenida, expresada como el porcentaje promedio del video visto o **APV**).

### Ecuación de Calibración
El ICN final se recalcula de la siguiente forma si el usuario tiene cargados al menos $5$ registros en el sistema:

$$\text{ICN}_{\text{Calibrado}} = \begin{cases} 
\text{ICN}_{\text{Raw}} & \text{si } N_{\text{registros}} < 5 \\
\text{round} \left( \text{ICN}_{\text{Raw}} \cdot 0.7 + \overline{\text{APV}}_{[last\ 5]} \cdot 0.3 \right) & \text{si } N_{\text{registros}} \ge 5 
\end{cases}$$

Donde $\overline{\text{APV}}_{[last\ 5]}$ representa la media aritmética del Porcentaje Promedio de Reproducción (*Average Percentage Viewed*) de los últimos $5$ videos reales cargados por el creador. Esto ajusta el índice teórico a la realidad de la audiencia del canal del creador, actuando como un factor de corrección contextualizado.

---

## 6. Persistencia y Ciclo de Caché

La aplicación está diseñada para ser resiliente a pérdidas de conexión eléctrica, cierres abruptos de pestañas o cortes de red.

### 6.1 Estructura del Almacén IndexedDB (`scriptlab-ai`)
El motor de base de datos relacional local utiliza un esquema clave-valor estructurado en la versión $2$ bajo los siguientes almacenes de objetos (`Object Stores`):

1. **`projects`**: Guarda la metadata del proyecto y un array estructurado de bloques (`id`, `type`, `label`, `content`, `notes`). La clave primaria es el string de identidad (`id: "active"`).
2. **`snapshots`**: Almacén que funciona como histórico de versiones del guion. Almacena instantáneas automáticas cada 30 minutos de inactividad, permitiendo auditorías o recuperaciones en caso de corrupción de datos.
3. **`calibrations`**: Guarda los datos de rendimiento reales de videos anteriores para alimentar el algoritmo de calibración del ICN.
4. **`analysisCache`**: Almacena las salidas JSON generadas por el Web Worker asociadas al hash de sus correspondientes bloques de texto procesados, optimizando la batería y el uso del CPU.
5. **`settings`** y **`modelRegistry`**: Reservados para configuraciones personalizadas del entorno e inventariado de modelos.

---

## 7. Tabla de Diagnóstico de Compatibilidad

| Característica | Dependencia Tecnológica | Comportamiento en Modo Offline | Observaciones |
|---|---|---|---|
| **Heurísticas Básicas** | Hilo principal JavaScript nativo | **100% Funcional** | Sin requerimientos de red. |
| **Generación de Embeddings** | ONNX Runtime via WASM / Transformers.js | **Funcional tras primera descarga** | Los archivos `.bin` del modelo se guardan en el *Cache Storage* del navegador de manera indefinida. |
| **Síntesis de Voz (Teleprompter)** | `speechSynthesis` de Web Speech API | **Dependiente del Navegador** | Algunos sistemas operativos (como iOS o Android) requieren conexión de datos para inicializar las voces de síntesis local premium. |
| **Base de Datos** | IndexedDB API | **100% Funcional** | Los datos permanecen persistentes en el disco local asignado a la sandbox del navegador. |

---

## Referencias
* [1] Hugging Face. (2024). *Transformers.js: State-of-the-art Machine Learning for the Web*. Recuperado de https://huggingface.co/docs/transformers.js
* [2] Wang, L., Yang, N., Huang, X., Yang, B., Deng, S. & Zhou, M. (2022). *Text Embeddings by Weakly-Supervised Contrastive Pre-training*. arXiv preprint arXiv:2212.03533.
* [3] Fernández-Huerta, J. (1959). *Medidas de sencillez del escrito*. Consigna, (215), 29-32.