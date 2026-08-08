import { DynamoDBClient, BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";

const stage = process.env.STAGE || 'prod';
const tableName = `bathtub-robot-services-${stage}-poll-history`;
const feedUrl = process.env.JSON_FEED_URL;

if (!feedUrl) {
  console.error("Error: JSON_FEED_URL environment variable is not defined.");
  process.exit(1);
}

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1"
});

async function main() {
  try {
    console.log(`Fetching current posts from feed: ${feedUrl}...`);
    const feedResponse = await fetch(feedUrl);
    if (!feedResponse.ok) {
      throw new Error(`Failed to fetch feed: ${feedResponse.statusText}`);
    }
    const feedData = await feedResponse.json();
    const posts = feedData.items || [];
    console.log(`Found ${posts.length} posts in the feed.`);

    if (posts.length === 0) {
      console.log("No posts found. Nothing to write.");
      return;
    }

    const now = new Date().toISOString();
    console.log(`Writing posts to AWS DynamoDB table: ${tableName}...`);

    const batchSize = 25;
    for (let i = 0; i < posts.length; i += batchSize) {
      const batch = posts.slice(i, i + batchSize);
      const writeRequests = batch.map(post => ({
        PutRequest: {
          Item: {
            url: { S: post.url },
            published: { S: post.date_published },
            detected: { S: now }
          }
        }
      }));

      await client.send(new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: writeRequests
        }
      }));
      console.log(`Wrote batch of ${batch.length} items.`);
    }

    console.log("DynamoDB table successfully pre-populated with current posts!");
  } catch (error) {
    console.error("Error pre-populating database:", error);
    process.exit(1);
  }
}

main();
