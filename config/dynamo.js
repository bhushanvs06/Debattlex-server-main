// server/config/dynamo.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const docClient = DynamoDBDocumentClient.from(client);
const USERS_TABLE = "Users";

// ====================== HELPERS ======================
async function getUser(email) {
  const command = new GetCommand({
    TableName: USERS_TABLE,
    Key: { email },
  });
  const { Item } = await docClient.send(command);
  return Item || null;
}

async function putUser(userData) {
  const command = new PutCommand({
    TableName: USERS_TABLE,
    Item: userData,
  });
  await docClient.send(command);
}

async function scanAllUsers() {
  const command = new ScanCommand({ TableName: USERS_TABLE });
  const { Items } = await docClient.send(command);
  return Items || [];
}

module.exports = { getUser, putUser, scanAllUsers, USERS_TABLE };