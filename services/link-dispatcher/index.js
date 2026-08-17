import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

const externalMentionTopicArn = process.env.EXTERNAL_MENTION_TOPIC_ARN;
const userAgent = process.env.USER_AGENT || 'BathtubRobot/1.0 (Link Dispatcher; +https://github.com/tkrehbiel/bathtub-robot-services)';

const clientOptions = {};
if (process.env.AWS_ENDPOINT_URL) {
  clientOptions.endpoint = process.env.AWS_ENDPOINT_URL;
} else if (process.env.LOCALSTACK_HOSTNAME) {
  clientOptions.endpoint = `http://${process.env.LOCALSTACK_HOSTNAME}:4566`;
}

const snsClient = new SNSClient(clientOptions);

export async function downloadHtml(url) {
  console.log(`Downloading HTML from: ${url} using User-Agent: ${userAgent}`);
  const response = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export function extractLinks(html) {
  if (!html) return [];
  const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  const links = [];
  let articleMatch;

  while ((articleMatch = articleRegex.exec(html)) !== null) {
    // Remove figure blocks (diagrams) from the content before scanning
    const articleContent = articleMatch[1].replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '');
    let hrefMatch;
    // Using a local regex inside the loop to ensure clean exec state
    const localHrefRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["']/gi;
    while ((hrefMatch = localHrefRegex.exec(articleContent)) !== null) {
      links.push(hrefMatch[1]);
    }
  }
  return links;
}

export function validateLink(href) {
  if (!href) return false;
  if (href.startsWith('http://')) return false;
  if (href.startsWith('/') || href.startsWith('#')) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

export function isExternal(sourceUrl, targetUrl) {
  try {
    const sourceObj = new URL(sourceUrl);
    const targetObj = new URL(targetUrl);
    return sourceObj.hostname !== targetObj.hostname;
  } catch (err) {
    return false;
  }
}

export async function publishWebmention(source, target) {
  const payload = { source, target };
  console.log(`Publishing outgoing webmention message: ${JSON.stringify(payload)}`);
  const command = new PublishCommand({
    TopicArn: externalMentionTopicArn,
    Message: JSON.stringify(payload),
  });
  return snsClient.send(command);
}

export async function processRecord(message) {
  const { url } = message;
  if (!url) {
    console.warn('Record missing "url" property, skipping.');
    return;
  }

  const html = await downloadHtml(url);
  const links = extractLinks(html);
  
  const externalLinks = links.filter((link) => {
    return validateLink(link) && isExternal(url, link);
  });

  const uniqueLinks = [...new Set(externalLinks)];
  console.log(`Found ${uniqueLinks.length} unique external links to dispatch.`);

  for (const target of uniqueLinks) {
    await publishWebmention(url, target);
  }
}

export async function handler(event) {
  if (!externalMentionTopicArn) {
    throw new Error('EXTERNAL_MENTION_TOPIC_ARN is not configured');
  }

  for (const record of event.Records) {
    const snsMessage = JSON.parse(record.Sns.Message);
    await processRecord(snsMessage);
  }
}
