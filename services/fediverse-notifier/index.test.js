import test from 'node:test';
import assert from 'node:assert';
import {
  cleanUrl,
  stripHtml,
  formatTags,
  formatStatusText,
} from './index.js';

test('Notifier - cleanUrl cleans URLs correctly', () => {
  assert.strictEqual(cleanUrl('https://example.com/'), 'https://example.com');
  assert.strictEqual(cleanUrl('example.com/'), 'https://example.com');
  assert.strictEqual(cleanUrl('http://example.com'), 'http://example.com');
});

test('Notifier - stripHtml cleans HTML and translates entities', () => {
  const html = '<p>Hello <strong>World</strong>!</p><br/>Next line &amp; &quot;quote&quot;.';
  const expected = 'Hello World!\n\nNext line & "quote".';
  assert.strictEqual(stripHtml(html), expected);
});

test('Notifier - formatTags converts tags to space-stripped hashtags', () => {
  const tags = ['EverQuest II', 'Gaming', 'MMORPG'];
  const expected = '#EverQuestII #Gaming #MMORPG';
  assert.strictEqual(formatTags(tags), expected);
});

test('Notifier - formatTags handles empty input', () => {
  assert.strictEqual(formatTags([]), '');
  assert.strictEqual(formatTags(null), '');
});

test('Notifier - formatStatusText formats status correctly', () => {
  const title = 'Blog Post Title';
  const summary = 'This is a brief summary of the blog post.';
  const url = 'https://example.com/my-post';
  const hashtags = '#Gaming #EverQuestII';

  const expected = 'Blog Post Title: This is a brief summary of the blog post. https://example.com/my-post\n\n#Gaming #EverQuestII';
  assert.strictEqual(formatStatusText(title, summary, url, hashtags), expected);
});
