'use strict';

const http = require('node:http');

function parseMultipartImport(contentType, body) {
  const match = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!match) return { metadata: null, message: body };

  const boundary = match[1];
  const jsonMarker = Buffer.from('Content-Type: application/json; charset=UTF-8\r\n\r\n');
  const messageMarker = Buffer.from('Content-Type: message/rfc822\r\n\r\n');
  const delimiter = Buffer.from(`\r\n--${boundary}`);

  const jsonStart = body.indexOf(jsonMarker);
  const messageStart = body.indexOf(messageMarker);
  if (jsonStart < 0 || messageStart < 0) return { metadata: null, message: body };

  const jsonBodyStart = jsonStart + jsonMarker.length;
  const jsonEnd = body.indexOf(delimiter, jsonBodyStart);
  const messageBodyStart = messageStart + messageMarker.length;
  const messageEnd = body.indexOf(Buffer.from(`\r\n--${boundary}--`), messageBodyStart);

  if (jsonEnd < 0 || messageEnd < 0) return { metadata: null, message: body };

  return {
    metadata: JSON.parse(body.subarray(jsonBodyStart, jsonEnd).toString('utf8')),
    message: body.subarray(messageBodyStart, messageEnd),
  };
}

/**
 * Faux Google, pour les tests : le point de jeton OAuth et le point d'import
 * de l'API Gmail.
 *
 * Il retient ce qu'on lui envoie — corps brut de l'import compris — parce que
 * c'est précisément ce qu'on veut vérifier : le message doit arriver octet pour
 * octet, avec les bons paramètres de requête et le bon jeton.
 */
function startFakeGoogle(options = {}) {
  const state = { tokenCalls: [], imports: [] };
  let issued = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === '/token') {
        const form = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
        state.tokenCalls.push(form);

        if (options.tokenError) return send(400, options.tokenError);
        if (form.grant_type === 'authorization_code') {
          return send(200, options.codeResponse ?? { refresh_token: 'refresh-1', expires_in: 3599 });
        }
        return send(200, { access_token: `access-${++issued}`, expires_in: options.expiresIn ?? 3599 });
      }

      if (url.pathname === '/upload') {
        const contentType = req.headers['content-type'];
        const parsed = parseMultipartImport(contentType, body);
        state.imports.push({
          body,
          message: parsed.message,
          metadata: parsed.metadata,
          authorization: req.headers.authorization,
          contentType,
          params: Object.fromEntries(url.searchParams),
        });
        if (options.importError) return send(options.importStatus ?? 403, options.importError);
        return send(200, { id: 'msg-' + state.imports.length, labelIds: ['INBOX', 'UNREAD'] });
      }

      send(404, { error: { message: 'inconnu' } });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      process.env.GOOGLE_TOKEN_URL = `${base}/token`;
      process.env.GMAIL_UPLOAD_URL = `${base}/upload`;
      resolve({
        base,
        state,
        close: () =>
          new Promise((done) => {
            delete process.env.GOOGLE_TOKEN_URL;
            delete process.env.GMAIL_UPLOAD_URL;
            server.close(done);
          }),
      });
    });
  });
}

module.exports = { startFakeGoogle };
