import { SNSClient, ListTopicsCommand, PublishCommand, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';
import { SQSClient, CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import http from 'http';

const clientOptions = {
  endpoint: process.env.AWS_ENDPOINT_URL || 'http://localhost:4566',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'mock',
    secretAccessKey: 'mock',
  },
};

const snsClient = new SNSClient(clientOptions);
const sqsClient = new SQSClient(clientOptions);

async function main() {
  let server;
  let queueUrl;
  let queueArn;
  let subscriptionArn;

  try {
    // 1. Resolve Topic ARNs
    console.log('Resolving SNS Topic ARNs in LocalStack...');
    const listTopicsResult = await snsClient.send(new ListTopicsCommand({}));
    const newPostTopic = listTopicsResult.Topics.find(t => t.TopicArn.endsWith('new-posts'));
    const externalMentionTopic = listTopicsResult.Topics.find(t => t.TopicArn.endsWith('external-mentions'));

    if (!newPostTopic || !externalMentionTopic) {
      throw new Error(`Could not find required SNS topics. Found: ${JSON.stringify(listTopicsResult.Topics)}`);
    }
    console.log(`Found NewPostTopic: ${newPostTopic.TopicArn}`);
    console.log(`Found ExternalMentionTopic: ${externalMentionTopic.TopicArn}`);

    // 2. Start a mock HTTP server serving a mock blog post
    console.log('Starting Mock HTTP Server...');
    server = http.createServer((req, res) => {
      console.log(`Mock Server received request for: ${req.url}`);
      if (req.url === '/mock-post.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <body>
              <a href="https://outside-article-should-be-ignored.com">Outside Link</a>
              <article>
                <p>External links that should be fetched:</p>
                <a href="https://google.com">Google</a>
                <a href="https://github.com">GitHub</a>
                
                <p>Internal or unsafe links that should be ignored:</p>
                <a href="http://insecure-http-link.com">Insecure HTTP</a>
                <a href="/internal-relative-path">Relative Path</a>
                <a href="#fragment-only">Fragment Only</a>
              </article>
            </body>
          </html>
        `);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const port = await new Promise((resolve) => {
      server.listen(0, '0.0.0.0', () => {
        resolve(server.address().port);
      });
    });
    console.log(`Mock HTTP server listening on port ${port}`);

    // 3. Create a temporary SQS queue to subscribe to the output topic
    const queueName = `link-dispatcher-test-queue-${Date.now()}`;
    console.log(`Creating test SQS queue: ${queueName}`);
    const createQueueResult = await sqsClient.send(new CreateQueueCommand({ QueueName: queueName }));
    queueUrl = createQueueResult.QueueUrl;

    const attributesResult = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    }));
    queueArn = attributesResult.Attributes.QueueArn;
    console.log(`SQS Queue ARN: ${queueArn}`);

    // 4. Subscribe the SQS queue to the ExternalMentionTopic SNS
    console.log(`Subscribing SQS queue to ${externalMentionTopic.TopicArn}...`);
    const subscribeResult = await snsClient.send(new SubscribeCommand({
      TopicArn: externalMentionTopic.TopicArn,
      Protocol: 'sqs',
      Endpoint: queueArn,
    }));
    subscriptionArn = subscribeResult.SubscriptionArn;
    console.log(`Subscribed. Subscription ARN: ${subscriptionArn}`);

    // 5. Trigger the system by publishing a new post to NewPostTopic
    // Inside LocalStack lambda, host.docker.internal resolves to the host machine
    const mockPostUrl = `http://host.docker.internal:${port}/mock-post.html`;
    const newPostPayload = {
      url: mockPostUrl,
      title: 'Integration Test Post',
      published: new Date().toISOString(),
    };

    console.log(`Publishing mock post to NewPostTopic: ${mockPostUrl}`);
    await snsClient.send(new PublishCommand({
      TopicArn: newPostTopic.TopicArn,
      Message: JSON.stringify(newPostPayload),
    }));

    // 6. Poll the SQS queue for the dispatched target messages
    console.log('Polling SQS queue for outgoing mentions...');
    const receivedTargets = new Set();
    const startTime = Date.now();
    const timeoutMs = 8000; // Wait up to 8 seconds

    while (receivedTargets.size < 2 && (Date.now() - startTime) < timeoutMs) {
      const receiveResult = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }));

      if (receiveResult.Messages) {
        for (const message of receiveResult.Messages) {
          const snsBody = JSON.parse(message.Body);
          const webmention = JSON.parse(snsBody.Message);
          console.log(`Received target: ${webmention.target} from source: ${webmention.source}`);
          
          if (webmention.source === mockPostUrl) {
            receivedTargets.add(webmention.target);
          }
        }
      }
    }

    console.log(`Discovered targets: ${Array.from(receivedTargets).join(', ')}`);

    // 7. Verify assertions
    if (!receivedTargets.has('https://google.com') || !receivedTargets.has('https://github.com')) {
      throw new Error(`Integration test FAILED. Did not receive expected webmention targets. Found: ${JSON.stringify(Array.from(receivedTargets))}`);
    }

    if (receivedTargets.size > 2) {
      throw new Error(`Integration test FAILED. Received unexpected targets. Found: ${JSON.stringify(Array.from(receivedTargets))}`);
    }

    console.log('Integration Test SUCCESSFUL! All targets received correctly.');
  } catch (error) {
    console.error('Integration Test Error:', error);
    process.exitCode = 1;
  } finally {
    // 8. Cleanup resources
    if (subscriptionArn && subscriptionArn !== 'PendingConfirmation') {
      console.log('Unsubscribing from SNS...');
      try {
        await snsClient.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
      } catch (err) {
        console.error('Error during unsubscribe:', err);
      }
    }

    if (queueUrl) {
      console.log('Deleting temporary SQS queue...');
      try {
        await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      } catch (err) {
        console.error('Error deleting queue:', err);
      }
    }

    if (server) {
      console.log('Stopping Mock HTTP Server...');
      server.close();
    }
  }
}

main();
