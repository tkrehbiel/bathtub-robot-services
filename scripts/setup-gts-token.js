import fs from 'fs';
import { execSync } from 'child_process';

const GTS_URL = "http://localhost:8080";
const GTS_USER = "admin@example.com";
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

async function main() {
  try {
    console.log("Registering Application 'Bathtub Robot' in GotoSocial...");
    
    const appParams = new URLSearchParams();
    appParams.append('client_name', 'Bathtub Robot');
    appParams.append('redirect_uris', REDIRECT_URI);
    appParams.append('scopes', 'write:statuses write:media');

    const appResponse = await fetch(`${GTS_URL}/api/v1/apps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: appParams
    });

    if (!appResponse.ok) {
      throw new Error(`Failed to register app: ${appResponse.status} ${appResponse.statusText}`);
    }

    const appData = await appResponse.json();
    const clientId = appData.client_id;
    const clientSecret = appData.client_secret;
    console.log("App registered. Client ID:", clientId);

    console.log("Obtaining client_credentials OAuth Access Token...");
    const tokenParams = new URLSearchParams();
    tokenParams.append('client_id', clientId);
    tokenParams.append('client_secret', clientSecret);
    tokenParams.append('grant_type', 'client_credentials');
    tokenParams.append('redirect_uri', REDIRECT_URI);
    tokenParams.append('scope', 'write:statuses write:media');

    const tokenResponse = await fetch(`${GTS_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: tokenParams
    });

    const responseText = await tokenResponse.text();
    if (!tokenResponse.ok) {
      throw new Error(`Failed to obtain token: ${tokenResponse.status} ${tokenResponse.statusText} - ${responseText}`);
    }

    let tokenData = {};
    if (responseText) {
      try {
        tokenData = JSON.parse(responseText);
      } catch {
        tokenData = { text: responseText };
      }
    }
    const accessToken = tokenData.access_token;
    console.log("Access Token obtained successfully.");

    // Retrieve user ID from gts-db
    console.log(`Querying user ID for ${GTS_USER} from PostgreSQL database...`);
    const userId = execSync(`docker exec gts-db psql -U gotosocial -t -A -c "select id from users where email='${GTS_USER}' limit 1;"`)
      .toString()
      .trim();

    if (!userId) {
      throw new Error(`User ID not found in database for email ${GTS_USER}`);
    }
    console.log("Found user ID:", userId);

    // Associate the token with the user
    console.log("Updating database to associate token with user...");
    execSync(`docker exec gts-db psql -U gotosocial -c "update tokens set user_id = '${userId}' where access = '${accessToken}';"`);

    fs.writeFileSync('.gts-token', accessToken);
    console.log("OAuth Access Token successfully generated, authorized, and saved to .gts-token!");
  } catch (error) {
    console.error("Error setting up GotoSocial credentials:", error);
    process.exit(1);
  }
}

main();
