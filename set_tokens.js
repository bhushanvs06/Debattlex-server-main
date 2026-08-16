const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { getUser, putUser, scanAllUsers } = require('./config/dynamo');

async function listAndSetTokens() {
  try {
    console.log("Scanning all users in DynamoDB...");
    const users = await scanAllUsers();
    console.log(`Total users found: ${users.length}`);
    users.forEach(user => {
      console.log(`- Email: "${user.email}" | Tokens: ${user.tokens} | Name: "${user.displayName}"`);
    });

    if (users.length > 0) {
      const firstUser = users[0];
      console.log(`\nSetting tokens to 100 for user: ${firstUser.email}`);
      firstUser.tokens = 100;
      await putUser(firstUser);
      console.log("Tokens updated successfully!");
    }
  } catch (err) {
    console.error("Error listing users:", err);
  }
}

listAndSetTokens();
