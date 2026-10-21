// Hilo aparte para la IA que corre en el dispositivo: así la pantalla no se congela mientras piensa.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
