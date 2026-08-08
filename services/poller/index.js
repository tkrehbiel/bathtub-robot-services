import {
  DynamoDBClient,
  BatchGetItemCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

const jsonFeedUrl = process.env.JSON_FEED_URL;
const stateTableName = process.env.STATE_TABLE_NAME;
const notifyTopicArn = process.env.NOTIFY_TOPIC_ARN;

const clientOptions = {};
if (process.env.AWS_ENDPOINT_URL) {
  clientOptions.endpoint = process.env.AWS_ENDPOINT_URL;
} else if (process.env.LOCALSTACK_HOSTNAME) {
  clientOptions.endpoint = `http://${process.env.LOCALSTACK_HOSTNAME}:4566`;
}

const dynamoClient = new DynamoDBClient(clientOptions);
const snsClient = new SNSClient(clientOptions);

class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppError';
  }
}

export async function fetchPosts(sourceUrl) {
  if (!sourceUrl) {
    throw new AppError('JSON_FEED_URL is not configured');
  }
  const response = await fetch(sourceUrl);
  if (response.status !== 200) {
    throw new AppError(`received status ${response.status} while fetching ${sourceUrl}`);
  }
  const data = await response.json();
  if (!data || !Array.isArray(data.items)) {
    return [];
  }
  return data.items.map((item) => ({
    postUrl: item.url,
    postDate: item.date_published || new Date().toISOString(),
    postTitle: item.title || 'Untitled',
    postSummary: item.summary || '',
    postImage: item.image || item.banner_image || null,
    postTags: Array.isArray(item.tags) ? item.tags : [],
  }));
}

export async function findExistingItems(posts) {
  if (posts.length === 0) return [];
  const batchSize = 100;
  const promises = [];
  for (let i = 0; i < posts.length; i += batchSize) {
    const chunk = posts.slice(i, i + batchSize);
    const batchGetItemCommand = new BatchGetItemCommand({
      RequestItems: {
        [stateTableName]: {
          Keys: chunk.map((post) => ({
            url: { S: post.postUrl },
          })),
        },
      },
    });
    promises.push(dynamoClient.send(batchGetItemCommand));
  }
  const results = await Promise.all(promises);
  const foundItems = [];
  for (const data of results) {
    if (data.Responses && data.Responses[stateTableName]) {
      foundItems.push(...data.Responses[stateTableName]);
    }
  }
  return foundItems;
}

export async function detectNewPosts(posts, items) {
  return posts.filter((post) => {
    const found = items.find((item) => item.url.S === post.postUrl);
    return found === undefined;
  });
}

async function sendMessage(message) {
  const command = new PublishCommand({
    TopicArn: notifyTopicArn,
    Message: JSON.stringify(message),
  });
  return snsClient.send(command);
}

export async function triggerNotifications(posts) {
  const promises = [];
  const newItems = [];
  for (const post of posts) {
    console.log('triggering notification for post:', post.postUrl);
    const message = {
      url: post.postUrl,
      published: post.postDate,
      title: post.postTitle,
      summary: post.postSummary,
      image: post.postImage,
      tags: post.postTags,
      detected: new Date().toISOString(),
    };
    promises.push(sendMessage(message));
    newItems.push(message);
  }
  await Promise.all(promises);
  return newItems;
}

export async function writeNewItems(itemsToWrite) {
  if (itemsToWrite.length === 0) {
    console.log('no new items to store');
    return;
  }
  const batchSize = 25;
  for (let i = 0; i < itemsToWrite.length; i += batchSize) {
    const chunk = itemsToWrite.slice(i, i + batchSize);
    const batchWriteCommand = new BatchWriteItemCommand({
      RequestItems: {
        [stateTableName]: chunk.map((item) => ({
          PutRequest: {
            Item: {
              url: { S: item.url },
              published: { S: item.published },
              detected: { S: item.detected },
            },
          },
        })),
      },
    });
    try {
      const data = await dynamoClient.send(batchWriteCommand);
      console.log(`Successfully wrote batch of ${chunk.length} items to state table:`, data);
    } catch (error) {
      console.error(`Error writing batch of ${chunk.length} items to state table:`, error);
      throw error;
    }
  }
}

export async function main() {
  try {
    console.log('Fetching posts from feed:', jsonFeedUrl);
    const posts = await fetchPosts(jsonFeedUrl);
    console.log(`Fetched ${posts.length} posts from feed`);
    if (posts.length === 0) return;

    const items = await findExistingItems(posts);
    console.log(`Found ${items.length} existing items in state table`);

    const newPosts = await detectNewPosts(posts, items);
    console.log(`Detected ${newPosts.length} new posts`);
    if (newPosts.length === 0) return;

    try {
      const newItems = await triggerNotifications(newPosts);
      console.log(`Triggered notifications for ${newItems.length} new items`);
      await writeNewItems(newItems);
    } catch (error) {
      console.error('An error occurred while notifying, items were not saved to state');
      throw error;
    }
  } catch (error) {
    if (error instanceof AppError) {
      console.warn('App warning:', error.message);
    } else {
      console.error('Fatal error in main:', error);
      throw error;
    }
  }
}

export async function handler(event) {
  console.log('Launching from handler');
  await main();
}

// Invoke main() if run directly on command line
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Launching from command line');
  (async () => await main())();
}
