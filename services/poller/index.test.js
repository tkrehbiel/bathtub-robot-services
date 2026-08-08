import test from 'node:test';
import assert from 'node:assert';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { fetchPosts, detectNewPosts, findExistingItems, writeNewItems } from './index.js';

test('Poller - fetchPosts parses posts correctly', async (t) => {
  const mockFeed = {
    items: [
      {
        url: 'https://example.com/post-1',
        title: 'Post One',
        date_published: '2026-08-08T10:00:00Z',
        summary: '<p>Summary 1</p>',
        image: 'https://example.com/image1.jpg',
        tags: ['Tag 1', 'Tag 2']
      }
    ]
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return {
      status: 200,
      json: async () => mockFeed
    };
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const posts = await fetchPosts('https://example.com/feed.json');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].postUrl, 'https://example.com/post-1');
  assert.strictEqual(posts[0].postTitle, 'Post One');
  assert.strictEqual(posts[0].postSummary, '<p>Summary 1</p>');
  assert.strictEqual(posts[0].postImage, 'https://example.com/image1.jpg');
  assert.deepStrictEqual(posts[0].postTags, ['Tag 1', 'Tag 2']);
});

test('Poller - detectNewPosts returns posts not in state', async (t) => {
  const posts = [
    { postUrl: 'https://example.com/post-1' },
    { postUrl: 'https://example.com/post-2' }
  ];
  const existingItems = [
    { url: { S: 'https://example.com/post-1' } }
  ];

  const newPosts = await detectNewPosts(posts, existingItems);
  assert.strictEqual(newPosts.length, 1);
  assert.strictEqual(newPosts[0].postUrl, 'https://example.com/post-2');
});

test('Poller - findExistingItems chunks queries of > 100 items', async (t) => {
  // Generate 120 posts
  const posts = Array.from({ length: 120 }, (_, i) => ({
    postUrl: `https://example.com/post-${i}`
  }));

  let callsCount = 0;
  const originalSend = DynamoDBClient.prototype.send;
  
  DynamoDBClient.prototype.send = async function (command) {
    callsCount++;
    const keys = command.input.RequestItems['undefined'].Keys;
    return {
      Responses: {
        'undefined': keys.map(key => ({ url: { S: key.url.S } }))
      }
    };
  };

  t.after(() => {
    DynamoDBClient.prototype.send = originalSend;
  });

  const existing = await findExistingItems(posts);
  
  // 120 posts chunked by 100 should result in 2 calls (one of 100, one of 20)
  assert.strictEqual(callsCount, 2);
  assert.strictEqual(existing.length, 120);
});

test('Poller - writeNewItems chunks writes of > 25 items', async (t) => {
  // Generate 60 items to write
  const items = Array.from({ length: 60 }, (_, i) => ({
    url: `https://example.com/post-${i}`,
    published: '2026-08-08T10:00:00Z',
    detected: '2026-08-08T10:00:00Z'
  }));

  let callsCount = 0;
  const originalSend = DynamoDBClient.prototype.send;
  
  DynamoDBClient.prototype.send = async function (command) {
    callsCount++;
    const requests = command.input.RequestItems['undefined'];
    assert(requests.length <= 25);
    return {};
  };

  t.after(() => {
    DynamoDBClient.prototype.send = originalSend;
  });

  await writeNewItems(items);
  
  // 60 items chunked by 25 should result in 3 calls (25, 25, 10)
  assert.strictEqual(callsCount, 3);
});
