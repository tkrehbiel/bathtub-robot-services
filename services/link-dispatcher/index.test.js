import test from 'node:test';
import assert from 'node:assert';
import { SNSClient } from '@aws-sdk/client-sns';
import {
  extractLinks,
  validateLink,
  isExternal,
  downloadHtml,
  processRecord,
  handler,
} from './index.js';

test('Link Dispatcher - extractLinks extracts links inside article only', () => {
  const html = `
    <html>
      <body>
        <a href="https://outside-article.com">Outside</a>
        <article class="post">
          <p>Read more on <a href="https://inside-article-1.com">Inside 1</a></p>
          <div>
            <a href='https://inside-article-2.com'>Inside 2</a>
            <a href="http://inside-http.com">Inside HTTP</a>
            <a href="/relative-link">Relative</a>
          </div>
        </article>
      </body>
    </html>
  `;
  const links = extractLinks(html);
  assert.deepStrictEqual(links, [
    'https://inside-article-1.com',
    'https://inside-article-2.com',
    'http://inside-http.com',
    '/relative-link'
  ]);
});

test('Link Dispatcher - validateLink validations', () => {
  assert.strictEqual(validateLink('https://example.com'), true);
  assert.strictEqual(validateLink('https://example.com/some/path?param=1'), true);
  assert.strictEqual(validateLink('http://example.com'), false); // Only https allowed
  assert.strictEqual(validateLink('/relative'), false);
  assert.strictEqual(validateLink('#fragment'), false);
  assert.strictEqual(validateLink('not-a-url'), false);
});

test('Link Dispatcher - isExternal detection', () => {
  const source = 'https://endgameviable.com/post-one';
  assert.strictEqual(isExternal(source, 'https://google.com'), true);
  assert.strictEqual(isExternal(source, 'https://endgameviable.com/post-two'), false);
  assert.strictEqual(isExternal(source, 'https://endgameviable.com'), false);
  assert.strictEqual(isExternal(source, 'invalid-url'), false);
});

test('Link Dispatcher - downloadHtml uses mock fetch', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.strictEqual(url, 'https://endgameviable.com/post-one');
    assert.strictEqual(options.headers['User-Agent'], process.env.USER_AGENT || 'BathtubRobot/1.0 (Link Dispatcher; +https://github.com/tkrehbiel/bathtub-robot-services)');
    return {
      ok: true,
      text: async () => '<html>Mock HTML</html>',
    };
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const html = await downloadHtml('https://endgameviable.com/post-one');
  assert.strictEqual(html, '<html>Mock HTML</html>');
});

test('Link Dispatcher - processRecord flows and filters duplicates', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      text: async () => `
        <article>
          <a href="https://external-1.com">External 1</a>
          <a href="https://external-1.com">External 1 Duplicate</a>
          <a href="https://endgameviable.com/internal">Internal</a>
          <a href="http://unsecured.com">HTTP</a>
        </article>
      `,
    };
  };

  const publishCalls = [];
  const originalSend = SNSClient.prototype.send;
  SNSClient.prototype.send = async (command) => {
    publishCalls.push(command.input);
    return { MessageId: 'mock-msg-id' };
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    SNSClient.prototype.send = originalSend;
  });

  await processRecord({ url: 'https://endgameviable.com/post-one' });

  assert.strictEqual(publishCalls.length, 1);
  assert.deepStrictEqual(publishCalls[0], {
    TopicArn: process.env.EXTERNAL_MENTION_TOPIC_ARN,
    Message: JSON.stringify({
      source: 'https://endgameviable.com/post-one',
      target: 'https://external-1.com',
    }),
  });
});

test('Link Dispatcher - extractLinks ignores links inside figure elements', () => {
  const html = `
    <article>
      <p>Link <a href="https://good.com">Good</a></p>
      <figure>
        <a href="https://inside-figure.com">Figure link</a>
        <figcaption>Diagram showing <a href="https://inside-fig-caption.com">caption link</a></figcaption>
      </figure>
      <p>Another <a href="https://another-good.com">Good</a></p>
    </article>
  `;
  const links = extractLinks(html);
  assert.deepStrictEqual(links, [
    'https://good.com',
    'https://another-good.com'
  ]);
});
