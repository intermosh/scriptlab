# ScriptLab

**ScriptLab** es un editor y analizador de guiones para creadores de contenido que funciona completamente en el navegador. Está diseñado para estructurar narrativas, medir su claridad y practicar la lectura, **sin enviar información a servidores externos**.

---

## Características

- **Editor por bloques**: Estructura el guion arrastrando y soltando componentes narrativos (Hook, Contexto, Evidencia, Giro, CTA, etc.).
- **Métricas de calidad**: Calcula un *Índice de Calidad Narrativa* basado en la fórmula de legibilidad Fernández‑Huerta, la estructura del guion y el ritmo visual.
- **Teleprompter integrado**: Herramienta de lectura en voz alta con control de velocidad (WPM) para práctica o grabación.
- **Análisis IA local (opcional)**: Descarga un modelo de lenguaje que evalúa la coherencia semántica entre el título, la promesa y los bloques del guion.
- **Calibración de métricas**: Permite ingresar datos reales de retención de YouTube Studio para ajustar el índice de calidad a tu rendimiento histórico.
- **Funcionamiento sin conexión**: Tras la primera carga, la aplicación y el modelo IA pueden funcionar offline.

---

## Privacidad y funcionamiento

La aplicación **no requiere cuentas ni procesos de registro**. Todo el texto ingresado, los proyectos guardados y las configuraciones se almacenan localmente en el almacenamiento de tu navegador (IndexedDB).

El **análisis de IA** se ejecuta en un proceso aislado dentro de tu propio navegador. **No se envían guiones ni datos a la nube**.

---

## Modos de análisis

ScriptLab AI ofrece **dos modos de funcionamiento**, seleccionables desde el panel de configuración:

- **Modo heurístico (por defecto)**: Analiza la estructura, duración, claridad y ritmo de forma instantánea mediante fórmulas matemáticas y reglas de guion. No requiere descargas.
- **Modo IA**: Activa el motor de análisis semántico. Al habilitar esta opción por primera vez, se descargará un modelo de lenguaje de aproximadamente **117 MB**. Este modelo se guardará en la caché del navegador para usos futuros sin necesidad de volver a descargarlo.

---

## Cómo usarlo

1. Accede a la aplicación desde [este enlace](https://intermosh.github.io/scriptlab-ai)
2. Arrastra los bloques necesarios desde el panel izquierdo hacia el centro de la pantalla para definir el flujo narrativo.
3. Haz clic en un bloque para escribir y editar su contenido en el panel derecho.
4. Consulta las métricas y diagnósticos en la parte inferior de la pantalla.
5. Para activar el análisis semántico, haz clic en *"Configurar IA"*, selecciona *"Modo AI"* y descarga el modelo local.

---

## Limitaciones

- **Alcance de la IA**: El modelo integrado se utiliza exclusivamente para análisis de coherencia y redundancia de texto. **No genera texto, no reescribe párrafos ni sugiere ideas creativas**.
- **Rendimiento**: Al utilizar el Modo IA, el procesamiento se realiza con los recursos de tu equipo. En dispositivos de bajos recursos, el análisis puede tardar unos segundos.
- **Almacenamiento**: Al tratarse de una aplicación web, borrar la caché y los datos de navegación eliminará los guiones guardados localmente. Utiliza la función de exportación (JSON/Markdown) para respaldar tu trabajo.