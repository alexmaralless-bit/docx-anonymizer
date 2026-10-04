// Node-аналог regex-guard Worker'а для тестов: тот же evaluateRegex, отдельный поток.
import { parentPort, workerData } from 'node:worker_threads';
import { evaluateRegex } from '../../../src/options/regex-guard-core.js';

parentPort.postMessage(evaluateRegex(workerData));
