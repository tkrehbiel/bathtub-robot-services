import dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

export function cleanUrl(url) {
  if (!url) return '';
  let cleaned = url.trim();
  if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
    cleaned = 'https://' + cleaned;
  }
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

const instanceUrl = cleanUrl(process.env.FEDIVERSE_INSTANCE_URL);
const accessToken = process.env.FEDIVERSE_ACCESS_TOKEN;

class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppError';
  }
}

export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return '';
  return tags
    .map((tag) => `#${tag.replace(/\s+/g, '')}`)
    .join(' ');
}

export function formatStatusText(title, cleanSummary, url, hashtags) {
  let statusText = '';
  if (title) {
    statusText += `${title}\n\n`;
  }
  if (cleanSummary) {
    statusText += `${cleanSummary}\n\n`;
  }
  statusText += `${url}`;
  if (hashtags) {
    statusText += `\n\n${hashtags}`;
  }
  return statusText;
}

export async function uploadMedia(instUrl, token, imageUrl) {
  try {
    console.log('Fetching media image from URL:', imageUrl);
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image from URL: ${response.statusText}`);
    }
    const blob = await response.blob();

    const filename = imageUrl.split('/').pop() || 'image.jpg';

    const formData = new FormData();
    formData.append('file', blob, filename);

    console.log('Uploading media to Fediverse instance...');
    const uploadResponse = await fetch(`${instUrl}/api/v1/media`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    });

    const responseText = await uploadResponse.text();
    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload media: ${uploadResponse.status} - ${responseText}`);
    }

    let data = {};
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = { text: responseText };
      }
    }
    
    console.log('Media uploaded successfully. ID:', data.id);
    return data.id;
  } catch (error) {
    console.error('Error during media upload:', error);
    return null;
  }
}

export async function postStatus(instUrl, token, statusText, mediaIds = []) {
  const payload = {
    status: statusText,
    visibility: process.env.FEDIVERSE_VISIBILITY || 'public',
  };
  if (mediaIds && mediaIds.length > 0) {
    payload.media_ids = mediaIds;
  }

  console.log('Posting status to Fediverse...');
  const response = await fetch(`${instUrl}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to post status: ${response.status} - ${responseText}`);
  }

  let data = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { text: responseText };
    }
  }

  console.log('Status posted successfully! ID:', data.id);
  return data;
}

export async function processNotification(message) {
  const { url, title, summary, image, tags } = message;
  
  if (!url) {
    throw new AppError('Message missing required "url" field.');
  }

  console.log(`Processing notification for: ${title || url}`);

  const cleanSummary = stripHtml(summary);
  const hashtags = formatTags(tags);
  const statusText = formatStatusText(title, cleanSummary, url, hashtags);

  let mediaIds = [];
  if (image) {
    const mediaId = await uploadMedia(instanceUrl, accessToken, image);
    if (mediaId) {
      mediaIds.push(mediaId);
    }
  }

  await postStatus(instanceUrl, accessToken, statusText, mediaIds);
}

export async function handler(event, context) {
  if (!instanceUrl || !accessToken) {
    throw new Error('FEDIVERSE_INSTANCE_URL or FEDIVERSE_ACCESS_TOKEN is not configured');
  }

  for (const record of event.Records) {
    const snsMessage = JSON.parse(record.Sns.Message);
    await processNotification(snsMessage);
  }
}
