// Web Worker: ядро. Сообщения от offscreen.js: { clientId, msg }; ответы — { clientId, msg }.
import { createHost } from './host.js';

const host = createHost({
  post: (clientId, msg) => self.postMessage({ clientId, msg }),
  toolVersion: typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0',
});

self.onmessage = (e) => {
  const { clientId, msg } = e.data || {};
  if (msg) host.handle(clientId, msg);
};
