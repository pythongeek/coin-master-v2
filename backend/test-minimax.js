
const { getKycSettings } = require('./dist/services/kyc-settings');
const { validateMiniMaxApiKey } = require('./dist/services/minimax-client');

async function main() {
  try {
    const settings = await getKycSettings();
    console.log('Provider:', settings.provider);
    console.log('API key set:', settings.minimaxApiKeySet);
    console.log('Base URL:', settings.minimaxBaseUrl);
    console.log('Model:', settings.minimaxModel);
    
    if (!settings.minimaxApiKey) {
      console.error('No API key found');
      process.exit(1);
    }
    
    console.log('Calling MiniMax /models to validate key...');
    const valid = await validateMiniMaxApiKey(settings.minimaxApiKey);
    console.log('Key valid:', valid);
    process.exit(valid ? 0 : 1);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();

