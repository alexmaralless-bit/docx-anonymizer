// Точка входа для тестового бандла: клиент протокола §5.4 в странице расширения (собирается esbuild в тесте).
import { connectClient } from '../../../src/shared/port-client.js';
import { MSG } from '../../../src/shared/protocol.js';

window.__docx = { connectClient, MSG };
