import { DynamoDBClient, ScanCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: {
    accessKeyId: "mock",
    secretAccessKey: "mock",
  },
});

const tableName = "bathtub-robot-services-local-poll-history";

async function main() {
  try {
    console.log(`Scanning table ${tableName}...`);
    const scanResult = await client.send(new ScanCommand({ TableName: tableName }));
    const items = scanResult.Items || [];
    console.log(`Found ${items.length} items to delete.`);

    for (const item of items) {
      console.log(`Deleting item with URL: ${item.url.S}`);
      await client.send(new DeleteItemCommand({
        TableName: tableName,
        Key: {
          url: item.url
        }
      }));
    }
    console.log("DynamoDB history cleared successfully!");
  } catch (error) {
    if (error.name === "ResourceNotFoundException") {
      console.log("DynamoDB table does not exist yet. Nothing to clear.");
    } else {
      console.error("Error clearing DynamoDB history:", error);
      process.exit(1);
    }
  }
}

main();
