import fs from 'fs';
import readline from 'readline';
import { exec } from 'child_process';

const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
  try {
    let instanceUrlInput = process.env.FEDIVERSE_INSTANCE_URL;
    if (!instanceUrlInput) {
      instanceUrlInput = await question("Please enter your Fediverse Instance URL (e.g., https://gts.example.com): ");
    }
    const GTS_URL = instanceUrlInput.trim();
    if (!GTS_URL) {
      throw new Error("Instance URL is required.");
    }

    console.log(`\nRegistering Application 'Bathtub Robot Notifier' on ${GTS_URL}...`);
    
    const appParams = new URLSearchParams();
    appParams.append('client_name', 'Bathtub Robot Notifier');
    appParams.append('redirect_uris', REDIRECT_URI);
    appParams.append('scopes', 'write:statuses write:media');

    const appResponse = await fetch(`${GTS_URL}/api/v1/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: appParams
    });

    if (!appResponse.ok) {
      throw new Error(`Failed to register app: ${appResponse.statusText}`);
    }

    const appData = await appResponse.json();
    const clientId = appData.client_id;
    const clientSecret = appData.client_secret;

    const authUrl = `${GTS_URL}/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=write:statuses+write:media`;

    console.log("\n========================================================");
    console.log("Opening authorization URL in your browser...");
    console.log("URL:", authUrl);
    console.log("========================================================\n");

    // Open browser automatically on macOS
    exec(`open "${authUrl}"`);

    const authCode = await question("Please authorize the app in your browser, then paste the authorization code here: ");
    rl.close();

    if (!authCode.trim()) {
      throw new Error("Authorization code cannot be empty.");
    }

    console.log("\nExchanging authorization code for Access Token...");
    const tokenParams = new URLSearchParams();
    tokenParams.append('client_id', clientId);
    tokenParams.append('client_secret', clientSecret);
    tokenParams.append('grant_type', 'authorization_code');
    tokenParams.append('code', authCode.trim());
    tokenParams.append('redirect_uri', REDIRECT_URI);
    tokenParams.append('scope', 'write:statuses write:media');

    const tokenResponse = await fetch(`${GTS_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams
    });

    const responseText = await tokenResponse.text();
    if (!tokenResponse.ok) {
      throw new Error(`Failed to obtain token: ${tokenResponse.status} - ${responseText}`);
    }

    const tokenData = JSON.parse(responseText);
    const accessToken = tokenData.access_token;

    console.log(`\nAccess token successfully generated!`);
    
    // Read existing .env file
    let envContent = '';
    if (fs.existsSync('.env')) {
      envContent = fs.readFileSync('.env', 'utf8');
    }

    // Update or append FEDIVERSE_INSTANCE_URL
    if (envContent.includes('FEDIVERSE_INSTANCE_URL=')) {
      envContent = envContent.replace(/FEDIVERSE_INSTANCE_URL=.*/, `FEDIVERSE_INSTANCE_URL=${GTS_URL}`);
    } else {
      envContent += `\nFEDIVERSE_INSTANCE_URL=${GTS_URL}`;
    }

    // Update or append FEDIVERSE_ACCESS_TOKEN
    if (envContent.includes('FEDIVERSE_ACCESS_TOKEN=')) {
      envContent = envContent.replace(/FEDIVERSE_ACCESS_TOKEN=.*/, `FEDIVERSE_ACCESS_TOKEN=${accessToken}`);
    } else {
      envContent += `\nFEDIVERSE_ACCESS_TOKEN=${accessToken}`;
    }

    // Save changes back to .env
    fs.writeFileSync('.env', envContent.trim() + '\n');
    console.log("Credentials successfully updated and saved in the .env file!");
  } catch (error) {
    console.error("\nError getting production token:", error.message || error);
    rl.close();
    process.exit(1);
  }
}

main();
