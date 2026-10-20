# Specillum

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | **Español**

**Pods de navegador aislados para agentes de IA, dentro de tu propio Chrome con tus sesiones iniciadas.**

Specillum es un servidor [MCP](https://modelcontextprotocol.io) de código abierto que permite a agentes de IA como **Claude Code**, **OpenAI Codex** y **Cursor** navegar por la web con tus inicios de sesión reales, mientras le da a **cada agente su propia ventana de navegador privada (un "pod")**. Los agentes nunca ven ni tocan tus pestañas, y tampoco se estorban entre sí.

*Specillum* significa **sonda** en latín. Desde una única estación (station) compartida, cada agente sale como su propia sonda.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)

> Si Specillum te resulta útil, **dale una estrella al repositorio**. Así más personas pueden encontrarlo.

---

## Por qué

La mayoría de las herramientas de navegador para agentes te ofrecen una de dos cosas:

- **Un navegador headless limpio** sin ninguna sesión iniciada, así que el agente se topa con pantallas de inicio de sesión por todas partes.
- **Tu navegador real**, donde todos los agentes comparten las mismas pestañas. Interfieren entre sí y contigo.

Specillum conserva las ventajas de ambos:

| | Navegador limpio (p. ej., Playwright MCP por defecto) | Tu navegador, compartido | **Specillum** |
|---|---|---|---|
| Usa tus sesiones activas | No | Sí | **Sí** |
| Cada agente tiene su propio espacio | Sí | No | **Sí** |
| Los agentes no pueden acceder a tus pestañas | Sí | No | **Sí** |
| Puedes observar y tomar el control | Solo en modo con interfaz | Sí | **Sí** |
| Varios agentes a la vez | Navegadores separados | Colisiones | **Un navegador, un pod por agente** |

## Cómo funciona

```
                 ┌──────────────── Station: one real Chrome, dedicated profile ────────────────┐
                 │  logins and cookies are shared, live                                         │
                 │                                                                              │
 Claude Code ──► │  Pod "claude-code-x1"  (own window: its tabs and popups only)                │
 Codex ───────►  │  Pod "codex-k9"        (own window)                                          │
 Cursor ──────►  │  Pod "cursor-p3"       (own window)                                          │
                 │                                                                              │
 You ─────────►  │  your own windows: no agent can list or touch them                           │
                 └──────────────────────────────────────────────────────────────────────────────┘
```

- **Estación:** Un Chrome (o Edge/Chromium) se ejecuta con un perfil dedicado de Specillum y un puerto de depuración vinculado a `127.0.0.1`. Inicias sesión ahí una sola vez.
- **Pod:** Cada conexión MCP obtiene su propia ventana de Chrome. Cada herramienta actúa solo sobre las páginas que el propio pod abrió, además de las ventanas emergentes que esas páginas abran. No existe ningún mecanismo para listar o alcanzar otras páginas.
- **Limpieza:** Cuando un agente se desconecta, la ventana de su pod se cierra. Tus sesiones se mantienen.
- **Snapshots eficientes en tokens:** La página se resume como los elementos interactivos visibles, uno por línea, con referencias cortas:

```
title: Sign in · Example
url: https://example.com/login
headings:
  h1: Welcome back
elements:
[e1] textbox "Email"
[e2] textbox:password "Password"
[e3] button "Sign in"
[e4] link "Forgot password?" -> /reset
```

## Inicio rápido

Requisitos: Node.js 20+ y Google Chrome (Microsoft Edge y Chromium también funcionan).

### 1. Inicia sesión una vez

```bash
npx -y specillum open
```

Esto abre la estación de Specillum. Inicia sesión en los sitios que deban usar tus agentes. Las sesiones se guardan en el perfil de Specillum, separado de tu perfil habitual de Chrome.

### 2. Añade Specillum a tu agente

**Claude Code**

```bash
claude mcp add specillum -- npx -y specillum
```

En Windows, si no se encuentra `npx`, usa `claude mcp add specillum -- cmd /c npx -y specillum`.

**OpenAI Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.specillum]
command = "npx"
args = ["-y", "specillum"]
```

**Cursor** (`~/.cursor/mcp.json`) y otros clientes MCP

```json
{
  "mcpServers": {
    "specillum": { "command": "npx", "args": ["-y", "specillum"] }
  }
}
```

### 3. Úsalo

Pídele a tu agente que haga algo en la web, por ejemplo: *"Revisa mis notificaciones pendientes de GitHub y resúmelas."* Aparecerá una nueva ventana de pod, y podrás ver cómo trabaja o hacer clic en ella para tomar el control.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `pod_status` | La etiqueta del pod de este agente y sus pestañas |
| `pod_window` | Muestra la ventana de este pod al usuario o la minimiza en la barra de tareas |
| `navigate` | Abre una URL en la pestaña activa |
| `history` | Atrás / adelante |
| `snapshot` | Vista compacta de la página con referencias a elementos (`[e12]`) (incluye iframes) |
| `read` | Texto de la página como texto plano (por defecto, el contenido principal) |
| `click` | Hace clic por referencia |
| `type` | Rellena un campo por referencia y, opcionalmente, pulsa Enter |
| `press` | Tecla o atajo de teclado |
| `select` | Elige opciones de un `<select>` |
| `hover` | Pasa el cursor por encima por referencia |
| `scroll` | Desplaza por pantallas, o desplaza hasta que una referencia quede visible |
| `wait` | Espera a que aparezca un texto o durante un tiempo fijo |
| `screenshot` | JPEG de la pestaña activa |
| `dialog` | Acepta o descarta el siguiente diálogo `confirm` / `prompt` (por defecto, los alert se aceptan y los confirm se descartan) |
| `tabs` | Lista, abre, cambia o cierra pestañas **solo de este pod** |
| `evaluate` | Ejecuta una expresión de JavaScript en la pestaña activa |

Las herramientas de acción aceptan `snapshot: true` para devolver un snapshot actualizado en la misma llamada.

## Configuración

| Variable | Valor por defecto | Propósito |
|---|---|---|
| `SPECILLUM_PORT` | `9333` | Puerto de depuración de la estación (solo localhost) |
| `SPECILLUM_PROFILE` | `%LOCALAPPDATA%\specillum\profile` (Windows), `~/Library/Application Support/specillum/profile` (macOS), `~/.config/specillum/profile` (Linux) | Directorio del perfil de la estación |
| `SPECILLUM_CHROME` | detección automática | Ejecutable del navegador |
| `SPECILLUM_POD` | `<client>-<random>` | Etiqueta fija del pod |
| `SPECILLUM_KEEP_POD` | sin definir | Ponlo en `1` para conservar la ventana del pod cuando el agente termine |
| `SPECILLUM_POD_WINDOW` | `visible` | Con `minimized`, la ventana del pod se abre minimizada en la barra de tareas y sigue funcionando |
| `SPECILLUM_WINDOW` | `1280x900` | Tamaño de la ventana del pod |

## Modelo de seguridad

Lee esto antes de iniciar sesión en algo importante.

- **Perfil separado.** Specillum nunca toca tu perfil habitual de Chrome. Los agentes solo tienen acceso a los sitios en los que inicies sesión dentro de la estación. Empieza con cuentas que no te importaría dejar usar a un asistente.
- **Puerto en localhost.** La estación escucha únicamente en `127.0.0.1`. Cualquier programa que se ejecute en tu equipo con tu usuario podría conectarse a ese puerto mientras la estación esté abierta. Cierra la estación cuando no la estés usando.
- **El aislamiento es entre agentes y ventanas, no entre sitios.** Los pods comparten cookies a propósito: así es como funcionan las sesiones. Un agente, desde su pod, puede usar cualquier sitio en el que hayas iniciado sesión en la estación.
- **Inyección de prompts.** Las páginas web pueden contener texto pensado para manipular a los agentes. Limita los permisos del agente y las sesiones de la estación a lo estrictamente necesario para la tarea.
- **Código abierto, sin telemetría.** Specillum no envía ningún dato a ninguna parte, y cada línea de código está en este repositorio. Chrome mantiene su propia configuración y telemetría como de costumbre.

## Preguntas frecuentes

**¿Cómo dejo que Claude Code use mi navegador con mis sesiones iniciadas?**
Añade Specillum como servidor MCP (`claude mcp add specillum -- npx -y specillum`), ejecuta `npx specillum open` e inicia sesión una vez. A partir de ahí, Claude Code navega en su propia ventana de pod con esas sesiones.

**¿Pueden varios agentes de IA usar un mismo navegador a la vez sin interferir entre sí?**
Sí. Para eso existe Specillum. Cada conexión MCP obtiene su propia ventana de pod. Las pestañas, el foco y el historial están separados, y un agente no puede listar ni alcanzar las páginas de otro pod ni las tuyas.

**¿Funciona con OpenAI Codex, Cursor, Windsurf u otros clientes MCP?**
Sí. Cualquier cliente capaz de lanzar un servidor MCP por stdio puede usar Specillum.

**¿Funciona en Windows?**
Sí. Se desarrolló y probó en Windows. Las rutas del navegador para macOS y Linux vienen incluidas.

**¿Por qué no usar simplemente mi perfil normal de Chrome?**
Desde Chrome 136, la depuración remota está bloqueada en el perfil predeterminado por motivos de seguridad. Además, un perfil dedicado limita lo que los agentes pueden alcanzar a las sesiones que tú elijas.

**¿Es Specillum una alternativa a navegadores para agentes como ego lite o Vercel agent-browser?**
Cubre la misma idea: agentes que usan un navegador real, con sesiones iniciadas y espacios separados. Lo hace como un servidor MCP pequeño y totalmente de código abierto, sobre el Chrome que ya tienes, sin ningún binario de navegador personalizado.

**¿En qué se diferencia de Playwright MCP o chrome-devtools-mcp?**
Esas herramientas conectan un agente a un navegador. Specillum añade la capa de pods: una estación compartida con sesiones iniciadas, una ventana aislada por agente y limpieza al desconectarse. Internamente usa Playwright.

## Usar Specillum en tu propio proyecto

Puedes usar, modificar y redistribuir Specillum, con fines comerciales o no, bajo la [Apache License 2.0](LICENSE). Lo único que se pide a cambio es el reconocimiento:

- Conserva el archivo [`NOTICE`](NOTICE) en cualquier copia u obra derivada, tal como exige la licencia.
- Menciona el proyecto en tu README o en tu documentación, por ejemplo:

  > Built on [Specillum](https://github.com/jasonwpgml/specillum) by Jason ([@jasonwpgml](https://github.com/jasonwpgml)).

- El botón **"Cite this repository"** de GitHub utiliza [`CITATION.cff`](CITATION.cff).

Y si te ha sido útil, una estrella siempre se agradece.

## Contribuir

Los issues y pull requests son bienvenidos. Consulta [CONTRIBUTING.md](CONTRIBUTING.md). Ejecuta `npm run smoke` para comprobar de extremo a extremo el aislamiento entre dos agentes.

## Licencia

[Apache-2.0](LICENSE) © 2026 Jason ([@jasonwpgml](https://github.com/jasonwpgml)). Consulta [NOTICE](NOTICE).
